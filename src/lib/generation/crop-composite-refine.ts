import sharp from "sharp";
import {
  callBgRemove,
  callKontextInpaint,
} from "../ai-providers/router.js";
import type { ProviderId } from "../ai-providers/types.js";
import { logger } from "../logger.js";
import { buildReplaceAddObjectPrompt } from "../prompts/tools/replace-add-object.js";
import { withRetry } from "../retry.js";
import {
  downloadSafe,
  persistGenerationBuffer,
  StorageUploadError,
} from "../storage/s3-upload.js";
import { compositeMaskedResult } from "./composite-masked-result.js";
import {
  logNormalizeResult,
  NormalizeInputError,
  normalizeImageMaskPair,
} from "./normalize-image-mask-pair.js";

/**
 * Replace & Add Object v6.1 — Hybrid Composite + Kontext Low-Strength Refine.
 *
 * The v6.0 (Kontext alone, strength 0.88) failure revealed that Kontext's
 * `reference_image_url` is style/category guidance, not identity-faithful
 * reference. Without per-SKU LoRA, full-denoise Kontext erases the input
 * and generates a "kind-of-similar" object — not the specific catalog
 * item the user picked.
 *
 * v6.1 combines what each layer is actually good at:
 *
 *   1. **birefnet bg-remove** — produces a pixel-faithful cutout of the
 *      EXACT catalog item. Identity comes from these pixels directly.
 *
 *   2. **sharp.trim() + composite** — crops the cutout to its opaque
 *      bbox (fixing v5.1's transparent-border bug where birefnet's
 *      full-frame output left padding around the object), scales the
 *      tight cutout to cover the user's brush bbox, and alpha-
 *      composites onto the room. 100% spatial accuracy.
 *
 *   3. **Kontext low-strength refine (strength 0.4)** — runs over the
 *      pre-composited image with the inspiration as `reference_image_url`.
 *      At 0.4 strength, 60% of the input pixels survive — the
 *      composited cutout's identity is preserved through the denoise.
 *      The 40% denoise lets the model blend lighting, shadows, and
 *      edges so the cutout stops looking pasted. The reference image
 *      adds a secondary identity signal in case any cutout pixels do
 *      drift.
 *
 *   4. **Composite enforcement** — defensive outside-mask preservation
 *      via the existing compositeMaskedResult helper.
 *
 * **Cost**: ~$0.036/generation (birefnet $0.001 + Kontext $0.035).
 *
 * **Why "higher strength is better" (Kontext docs) doesn't apply here**:
 * the docs' guidance assumes Kontext is the SOLE generator — high
 * strength = more model influence = better adherence to prompt/reference.
 * In v6.1 we use Kontext as a BLENDER over an already-correct composite.
 * Low strength keeps the model from overwriting our correct identity
 * signal; the reference image plus the input pixels both point the
 * model in the same direction, so it has all the signal it needs at
 * low denoise.
 *
 * Function name retained as `runCropCompositeRefine` to minimize
 * processor diff. The pipeline body is the hybrid implementation.
 */

export interface RunCropCompositeRefineInput {
  imageUrl: string;
  inspirationImageUrl: string;
  maskUrl: string;
  prompt: string;
  inspirationTitle: string;
  mode: "replace" | "add";
  userId: string;
  generationId: string;
}

export interface RunCropCompositeRefineOutput {
  outputImageUrl: string;
  provider: ProviderId;
  durationMs: number;
  normalizeDurationMs: number;
  bgRemoveDurationMs: number;
  cropCompositeDurationMs: number;
  refineDurationMs: number;
  compositeDurationMs: number;
}

const PRECOMPOSITE_KEY_PREFIX = "precomposite";
const CUTOUT_KEY_PREFIX = "cutout";
const REFINE_INPUT_JPEG_QUALITY = 92;

/**
 * Kontext refine strength. 0.4 keeps the cutout pixels intact (60%
 * preserved) while letting the model do edge/lighting blending. Higher
 * values risk re-imagining the cutout content; lower values produce
 * pasted look. 0.4 is the empirical sweet spot for identity-preserving
 * refine in research (see plan doc).
 */
const KONTEXT_REFINE_STRENGTH = 0.4;

export async function runCropCompositeRefine(
  input: RunCropCompositeRefineInput,
): Promise<RunCropCompositeRefineOutput> {
  const start = Date.now();

  if (
    typeof input.inspirationImageUrl !== "string" ||
    input.inspirationImageUrl.length === 0
  ) {
    throw new NormalizeInputError(
      "v6.1: inspirationImageUrl is required but was empty — preEnqueueValidate must populate it",
    );
  }

  logger.info(
    {
      event: "inpaint.refine.started",
      generationId: input.generationId,
      mode: input.mode,
    },
    "Hybrid composite + Kontext refine pipeline starting (v6.1)",
  );

  // Stage 1: normalize.
  const normalized = await withRetry(
    () =>
      normalizeImageMaskPair({
        imageUrl: input.imageUrl,
        maskUrl: input.maskUrl,
        userId: input.userId,
        generationId: input.generationId,
        dilateMaskPx: 0,
        callerKind: "inpaint",
      }),
    {
      maxRetries: 1,
      delayMs: 1000,
      isRetryable: (error) => {
        if (error instanceof NormalizeInputError) return false;
        if (error instanceof StorageUploadError) {
          const msg = error.message;
          if (
            msg.includes("Host not in AI download allowlist") ||
            msg.includes("exceeds limit") ||
            msg.includes("Invalid source URL") ||
            msg.includes("refusing to persist an empty buffer") ||
            msg.includes("Refused to download non-HTTP(S)")
          ) {
            return false;
          }
        }
        return true;
      },
    },
  );
  logNormalizeResult(input.generationId, normalized, "inpaint");

  const roomWidth = normalized.after.image.width;
  const roomHeight = normalized.after.image.height;

  // Stage 2: background-remove the inspiration object.
  const bgRemoveStart = Date.now();
  const bgRemoveResult = await callBgRemove({
    imageUrl: input.inspirationImageUrl,
  });
  const bgRemoveDurationMs = Date.now() - bgRemoveStart;
  logger.info(
    {
      event: "inpaint.refine.bgremove_completed",
      generationId: input.generationId,
      provider: bgRemoveResult.provider,
      bgRemoveDurationMs,
      cutoutUrl: bgRemoveResult.imageUrl,
    },
    "Inspiration cutout produced",
  );

  // Stage 3: compute mask bbox + trim cutout to opaque region + composite.
  const cropStart = Date.now();
  const bbox = await computeMaskBbox(normalized.maskUrl, input.generationId);
  if (bbox === null) {
    throw new NormalizeInputError(
      "v6.1: mask bbox compute failed — mask is degenerate or unreadable",
    );
  }
  const bboxLeftPx = Math.floor(bbox.left * roomWidth);
  const bboxTopPx = Math.floor(bbox.top * roomHeight);
  const bboxWidthPx = Math.max(
    1,
    Math.ceil((bbox.right - bbox.left) * roomWidth),
  );
  const bboxHeightPx = Math.max(
    1,
    Math.ceil((bbox.bottom - bbox.top) * roomHeight),
  );

  const [roomDl, cutoutDl] = await Promise.all([
    downloadSafe(normalized.imageUrl),
    downloadSafe(bgRemoveResult.imageUrl),
  ]);

  // CRITICAL FIX over v5.1: trim the cutout's transparent borders before
  // resize. birefnet outputs the full input dimensions (e.g. 1024×1024)
  // with the object centered and transparent padding around it. Without
  // trim, fit:"cover" scales the WHOLE padded frame to the brush bbox,
  // which shrinks the actual object to a fraction of the bbox. The
  // remaining bbox area shows the original room (including the
  // original object the user wanted replaced). sharp.trim() crops to
  // the bounding box of non-uniform pixels, including transparent
  // borders. Threshold=1 means "trim any pixel within 1/255 of the
  // border color" — i.e. pure-alpha-0 transparent padding.
  const cutoutTrimmed = await sharp(cutoutDl.buffer)
    .rotate()
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
    .png()
    .toBuffer();

  // Resize the tight cutout to COVER the brush bbox. fit:"cover" fills
  // the entire bbox (cropping minor overflow at the cutout's edge) so
  // the brush region is fully covered by the new object — no remnants
  // of the original showing through.
  const cutoutResized = await sharp(cutoutTrimmed)
    .resize(bboxWidthPx, bboxHeightPx, {
      fit: "cover",
      position: "center",
    })
    .ensureAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });

  // Soft alpha edge — birefnet leaves 1-2px hard cut; small gaussian
  // smooths the silhouette so the Kontext refine pass has a cleaner
  // transition to blend.
  const cutoutSoftened = await sharp(cutoutResized.data)
    .blur(1.5)
    .png()
    .toBuffer({ resolveWithObject: true });

  // Alpha-composite the cutout onto the normalized room at the bbox
  // top-left.
  const preCompositeBuffer = await sharp(roomDl.buffer)
    .rotate()
    .removeAlpha()
    .composite([
      {
        input: cutoutSoftened.data,
        left: bboxLeftPx,
        top: bboxTopPx,
        blend: "over",
      },
    ])
    .jpeg({ quality: REFINE_INPUT_JPEG_QUALITY })
    .toBuffer();

  // Persist pre-composite to S3 so Kontext can fetch via URL.
  const preCompositePersisted = await persistGenerationBuffer({
    userId: input.userId,
    generationId: input.generationId,
    buffer: preCompositeBuffer,
    mime: "image/jpeg",
    keyPrefix: PRECOMPOSITE_KEY_PREFIX,
  });
  const preCompositeUrl =
    preCompositePersisted.outputImageCDNUrl ??
    preCompositePersisted.outputImageUrl;

  // Debug artifact persist — non-fatal.
  void persistGenerationBuffer({
    userId: input.userId,
    generationId: input.generationId,
    buffer: cutoutSoftened.data,
    mime: "image/png",
    keyPrefix: CUTOUT_KEY_PREFIX,
  }).catch((err) => {
    logger.warn(
      {
        event: "inpaint.refine.cutout_persist_failed",
        generationId: input.generationId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Cutout debug-persist failed — non-fatal",
    );
  });

  const cropCompositeDurationMs = Date.now() - cropStart;
  logger.info(
    {
      event: "inpaint.refine.precomposite_completed",
      generationId: input.generationId,
      bbox,
      bboxPx: {
        left: bboxLeftPx,
        top: bboxTopPx,
        width: bboxWidthPx,
        height: bboxHeightPx,
      },
      cutoutTrimmedInfo: cutoutResized.info,
      cropCompositeDurationMs,
      preCompositeUrl,
    },
    "Pre-composite ready for Kontext refine pass",
  );

  // Stage 4: Kontext refine at LOW strength. Input is the pre-composite
  // (so cutout identity is already in the pixels); reference image
  // provides supplementary identity signal; strength 0.4 lets the
  // model blend edges/lighting without erasing the cutout.
  const rebuilt = buildReplaceAddObjectPrompt({
    imageUrl: input.imageUrl,
    maskUrl: input.maskUrl,
    prompt: "",
    categoryId: "",
    inspirationId: "",
    inspirationImageUrl: input.inspirationImageUrl,
    inspirationTitle: input.inspirationTitle,
    mode: input.mode,
  });
  const refinePrompt = rebuilt.prompt;

  const refineStart = Date.now();
  const refineResult = await callKontextInpaint({
    imageUrl: preCompositeUrl,
    maskUrl: normalized.maskUrl,
    referenceImageUrl: input.inspirationImageUrl,
    prompt: refinePrompt,
    strength: KONTEXT_REFINE_STRENGTH,
  });
  const refineDurationMs = Date.now() - refineStart;

  logger.info(
    {
      event: "inpaint.refine.model_completed",
      generationId: input.generationId,
      provider: refineResult.provider,
      refineDurationMs,
      refineOutputUrl: refineResult.imageUrl,
      strength: KONTEXT_REFINE_STRENGTH,
    },
    "Kontext refine returned",
  );

  // Stage 5: composite enforcement against the original normalized room
  // (outside-mask preservation guard).
  const composite = await compositeMaskedResult({
    originalUrl: normalized.imageUrl,
    editedUrl: refineResult.imageUrl,
    maskUrl: normalized.maskUrl,
    userId: input.userId,
    generationId: input.generationId,
  });

  const durationMs = Date.now() - start;
  logger.info(
    {
      event: "inpaint.refine.completed",
      generationId: input.generationId,
      mode: input.mode,
      provider: refineResult.provider,
      durationMs,
      normalizeDurationMs: normalized.durationMs,
      bgRemoveDurationMs,
      cropCompositeDurationMs,
      refineDurationMs,
      compositeDurationMs: composite.durationMs,
      finalOutputUrl: composite.outputImageUrl,
    },
    "Hybrid composite + Kontext refine pipeline completed (v6.1)",
  );

  return {
    outputImageUrl: composite.outputImageUrl,
    provider: refineResult.provider,
    durationMs,
    normalizeDurationMs: normalized.durationMs,
    bgRemoveDurationMs,
    cropCompositeDurationMs,
    refineDurationMs,
    compositeDurationMs: composite.durationMs,
  };
}

interface MaskBbox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

async function computeMaskBbox(
  maskUrl: string,
  generationId: string,
): Promise<MaskBbox | null> {
  try {
    const { buffer } = await downloadSafe(maskUrl);
    const { data, info } = await sharp(buffer)
      .removeAlpha()
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const width = info.width;
    const height = info.height;
    if (width === 0 || height === 0) return null;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x += 1) {
        if (data[rowOffset + x] > 127) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < 0) {
      logger.warn(
        { event: "inpaint.refine.bbox.all_black", generationId, width, height },
        "Mask bbox compute found no white pixels",
      );
      return null;
    }

    return {
      left: minX / width,
      top: minY / height,
      right: (maxX + 1) / width,
      bottom: (maxY + 1) / height,
    };
  } catch (err) {
    logger.warn(
      {
        event: "inpaint.refine.bbox.error",
        generationId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Mask bbox compute failed",
    );
    return null;
  }
}
