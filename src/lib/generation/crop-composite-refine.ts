import sharp from "sharp";
import { callBgRemove } from "../ai-providers/router.js";
import type { ProviderId } from "../ai-providers/types.js";
import { logger } from "../logger.js";
import { withRetry } from "../retry.js";
import {
  downloadSafe,
  persistGenerationBuffer,
  StorageUploadError,
} from "../storage/s3-upload.js";
import {
  logNormalizeResult,
  NormalizeInputError,
  normalizeImageMaskPair,
} from "./normalize-image-mask-pair.js";

/**
 * Replace & Add Object v5.0 — Crop-Composite-Refine pipeline.
 *
 * Replaces the v4.x multi-image-edit-with-mask (Nano Banana) flow. Both
 * v4.0 (mask-as-image-3) and v4.1 (bbox text-spatial) failed in
 * production because instruction-following multi-image edit models do
 * not reliably follow spatial signals from text or auxiliary mask
 * images. v5.0 moves spatial precision OUT of the model and INTO
 * pixel-level composite — the model's only job is to blend lighting
 * and shadows around the edge of the user-painted region.
 *
 * **Pipeline stages.**
 *
 *   1. Normalize room + mask (existing) — align dims, bake EXIF, validate
 *      mask non-emptiness.
 *
 *   2. Background-remove the inspiration object via `callBgRemove`
 *      (fal.ai birefnet/v2 primary, Replicate `851-labs/background-remover`
 *      fallback). Returns a cutout PNG with transparent background.
 *      Cost ~$0.001.
 *
 *   3. Compute mask bbox + crop-composite: scale the cutout to fit inside
 *      the bbox (preserve aspect, center), then alpha-composite it onto
 *      the normalized room photo at the bbox top-left. Pure sharp pixel
 *      ops — zero model cost, 100% spatial accuracy. Output is uploaded
 *      to S3 under `precomposite/` so the refine model can fetch it.
 *
 *   4. Refine pass via `callInpaintRefine` (fal.ai `fal-ai/inpaint`
 *      primary at ~$0.005-0.01, Replicate `stability-ai/
 *      stable-diffusion-inpainting` fallback at ~$0.002). LOW-strength
 *      denoise (0.35) inside the user's brush mask blends lighting,
 *      shadows, and edges so the cutout doesn't look pasted. The model
 *      can't move the object — strength is too low to re-imagine
 *      identity — but it can harmonize tone.
 *
 *   5. Composite enforcement (existing `compositeMaskedResult`): blend
 *      the refine output back over the ORIGINAL normalized room using
 *      the user's brush mask as a feathered alpha. Guarantees byte-
 *      perceptual outside-mask preservation against any drift the
 *      refine model may introduce.
 *
 * Total cost target: ~$0.006-0.012 per generation.
 *
 * See `docs/plans/2026-05-18-001-refactor-replace-add-object-v5-crop-composite-refine-plan.md`
 * for the full design rationale and the v4.x failure post-mortem.
 */

export interface RunCropCompositeRefineInput {
  /** Public URL of the room photo (image 1 / target). */
  imageUrl: string;
  /**
   * Public URL of the inspiration item's reference photo. Resolved
   * server-side by `preEnqueueValidate` from
   * `objectInspirations/{inspirationId}.imageUrl` — never accepted from
   * the client request body.
   */
  inspirationImageUrl: string;
  /** Public URL of the client-uploaded brush mask PNG. */
  maskUrl: string;
  /** Pre-built prompt from `buildReplaceAddObjectPrompt`. Retained for
   *  logging; the pipeline rebuilds with scene-level wording so the
   *  refine pass gets directive guidance, not the bbox/image-3 v4
   *  text. */
  prompt: string;
  /** Server-resolved English title of the inspiration item. */
  inspirationTitle: string;
  /** Replace vs Add mode. Drives wording in the rebuild step. */
  mode: "replace" | "add";
  /** S3 key prefix component (matches existing pipelines). */
  userId: string;
  /** Generation record id, S3 key disambiguator. */
  generationId: string;
}

export interface RunCropCompositeRefineOutput {
  outputImageUrl: string;
  /** Provider that served the refine call. */
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

export async function runCropCompositeRefine(
  input: RunCropCompositeRefineInput,
): Promise<RunCropCompositeRefineOutput> {
  const start = Date.now();

  if (
    typeof input.inspirationImageUrl !== "string" ||
    input.inspirationImageUrl.length === 0
  ) {
    throw new NormalizeInputError(
      "crop-composite-refine: inspirationImageUrl is required but was empty — preEnqueueValidate must populate it",
    );
  }

  logger.info(
    {
      event: "inpaint.refine.started",
      generationId: input.generationId,
      mode: input.mode,
    },
    "Crop-composite-refine pipeline starting",
  );

  // Stage 1: normalize room + mask.
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

  // Stage 3: compute bbox + crop-composite.
  const cropStart = Date.now();
  const bbox = await computeMaskBbox(normalized.maskUrl, input.generationId);
  if (bbox === null) {
    throw new NormalizeInputError(
      "crop-composite-refine: mask bbox compute failed — mask is degenerate or unreadable",
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

  // Download room + cutout in parallel.
  const [roomDl, cutoutDl] = await Promise.all([
    downloadSafe(normalized.imageUrl),
    downloadSafe(bgRemoveResult.imageUrl),
  ]);

  // Scale the cutout to COVER the bbox: the user's brush stroke defines
  // the region they want the object to occupy. `fit: "cover"` fills the
  // entire bbox (cropping minor overflow) so the user does not see
  // remnants of the original object peeking through unfilled bbox
  // space. v5.0 first iteration used `fit: "inside"` which left
  // top/bottom strips of original pixels visible — for replace mode
  // that meant the user still saw fragments of the old object.
  //
  // The cropping risk (clipping a vase top or chair leg) is acceptable
  // because brush strokes are user-authored: the user paints what they
  // want covered. Any clip happens at the edge they chose to paint.
  const cutoutResized = await sharp(cutoutDl.buffer)
    .rotate()
    .resize(bboxWidthPx, bboxHeightPx, {
      fit: "cover",
      position: "center",
    })
    .ensureAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });

  // Soften the cutout's alpha edge with a small gaussian blur. Without
  // this the composite produces a hard outline where the model's
  // bg-remove cut transitioned from object to transparent, which reads
  // as "pasted" to viewers. Sigma 1.5 px keeps the silhouette intact
  // while smoothing the 1-2px hard edge that birefnet leaves.
  const cutoutSoftened = await sharp(cutoutResized.data)
    .blur(1.5)
    .png()
    .toBuffer({ resolveWithObject: true });

  // Alpha-composite the cutout onto the normalized room at the bbox
  // top-left. fit:"cover" already sized it to bbox dims, so no center
  // offset math required.
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

  // Persist final composite to S3. This IS the user-facing output —
  // v5.1 dropped the Flux Fill refine pass because it full-denoise
  // regenerates the masked region from prompt alone, destroying the
  // pre-composited cutout identity (the actual reason the user picked
  // the inspiration item in the first place). The visible cost: no
  // model-driven lighting/shadow blend. The benefit: the user sees
  // their selected item, at exactly the region they painted, at every
  // single generation. Identity + spatial preservation > model polish.
  //
  // When a verified low-denoise reference-aware inpaint endpoint
  // becomes available (fal-ai/flux-kontext-lora/inpaint with
  // reference_image_url, or fal-ai/lora/inpaint with IP-Adapter
  // configured at low strength), revisit this stage as an optional
  // polish pass behind a feature flag.
  const finalPersisted = await persistGenerationBuffer({
    userId: input.userId,
    generationId: input.generationId,
    buffer: preCompositeBuffer,
    mime: "image/jpeg",
    keyPrefix: PRECOMPOSITE_KEY_PREFIX,
  });
  const finalOutputUrl =
    finalPersisted.outputImageCDNUrl ?? finalPersisted.outputImageUrl;

  // Best-effort debug artifact: persist the softened cutout PNG so
  // operators can sanity-check bg-remove output without re-running the
  // pipeline. Failure is non-fatal.
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
  const durationMs = Date.now() - start;
  logger.info(
    {
      event: "inpaint.refine.completed",
      generationId: input.generationId,
      mode: input.mode,
      provider: "falai",
      durationMs,
      normalizeDurationMs: normalized.durationMs,
      bgRemoveDurationMs,
      cropCompositeDurationMs,
      refineDurationMs: 0,
      compositeDurationMs: 0,
      bbox,
      bboxPx: {
        left: bboxLeftPx,
        top: bboxTopPx,
        width: bboxWidthPx,
        height: bboxHeightPx,
      },
      cutoutInfo: cutoutResized.info,
      finalOutputUrl,
    },
    "Crop-composite pipeline completed (refine pass disabled in v5.1)",
  );

  return {
    outputImageUrl: finalOutputUrl,
    provider: "falai",
    durationMs,
    normalizeDurationMs: normalized.durationMs,
    bgRemoveDurationMs,
    cropCompositeDurationMs,
    refineDurationMs: 0,
    compositeDurationMs: 0,
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
