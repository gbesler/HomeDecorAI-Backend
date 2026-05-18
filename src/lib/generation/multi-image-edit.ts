import sharp from "sharp";
import { callDesignGeneration } from "../ai-providers/router.js";
import type { ProviderId } from "../ai-providers/types.js";
import { logger } from "../logger.js";
import {
  buildReplaceAddObjectPrompt,
  type MaskBbox,
} from "../prompts/tools/replace-add-object.js";
import { withRetry } from "../retry.js";
import { downloadSafe, StorageUploadError } from "../storage/s3-upload.js";
import { compositeMaskedResult } from "./composite-masked-result.js";
import {
  logNormalizeResult,
  NormalizeInputError,
  normalizeImageMaskPair,
} from "./normalize-image-mask-pair.js";
import { snapToSupportedRatio } from "./probe-aspect-ratio.js";

/**
 * Multi-image instructional edit pipeline (v4.0 — Nano Banana).
 *
 * Replaces the Flux Fill `prompt-inpaint.ts` orchestration for the
 * Replace & Add Object tool. The architectural diff in one sentence:
 * Flux Fill is a caption-fill model that cannot accept the user's
 * picked inspiration as a reference image; Nano Banana is an
 * instruction-following multi-image edit model where the inspiration
 * photo flows in as image 2 and the brush mask as image 3.
 *
 * **Pipeline stages.**
 *
 *   1. `normalizeImageMaskPair` aligns the room image's dimensions
 *      against the mask's. `dilateMaskPx: 0` — the Flux Fill silhouette
 *      bias that the 10/8 px dilation worked around does not exist in
 *      Nano Banana. The composite step (stage 3) uses its own
 *      feathering for the edge blend; pre-dilating here would just
 *      pollute the third-image hint with off-by-one boundary shifts.
 *   2. `callDesignGeneration` (role: edit) calls the model with the
 *      three-image array assembled by the provider adapters. Routes
 *      through the existing `runWithFallback` envelope so
 *      Replicate → fal.ai fallback works without any new wiring.
 *   3. `compositeMaskedResult` blends the model's edited image back
 *      over the original room image using a feathered version of the
 *      brush mask. This is the load-bearing step for outside-mask
 *      preservation — Nano Banana does not guarantee untouched pixels
 *      outside the mask, so we enforce it ourselves.
 *
 * **Image ordering.** The Nano Banana / fal-ai/flux-2/edit provider
 * adapters expect `[target, reference, ...extras]` ordering. The
 * v4.0 instructional prompt refers to:
 *
 *   - image 1 = room photo (target slot, `imageUrl`)
 *   - image 2 = inspiration photo (`referenceImageUrl`)
 *   - image 3 = brush mask (`extraImageUrls[0]`)
 *
 * If anything in this file ever reorders the args to
 * `callDesignGeneration`, the prompt's image numbering becomes a
 * lie and the model loses its disambiguation signal. The test in
 * `multi-image-edit.test.ts` pins this ordering.
 *
 * **Error envelope.** Identical to `prompt-inpaint.ts`: any thrown
 * error propagates verbatim. The generation processor's outer
 * try/catch maps it to `AI_PROVIDER_FAILED` (the default for
 * non-storage errors from provider calls). `NormalizeInputError` and
 * `StorageUploadError` propagate through the same path and get
 * specialized handling at the processor level.
 *
 * See `docs/plans/2026-05-17-001-refactor-replace-add-object-nano-banana-plan.md`
 * for the full Unit 3 design rationale.
 */

export interface RunMultiImageEditInput {
  /** Public URL of the room photo (image 1 / target). */
  imageUrl: string;
  /**
   * Public URL of the inspiration item's reference photo (image 2).
   * Resolved server-side by `preEnqueueValidate` from
   * `objectInspirations/{inspirationId}.imageUrl` — never accepted
   * from the client request body.
   */
  inspirationImageUrl: string;
  /**
   * Public URL of the client-uploaded brush mask PNG.
   * White = modify, black = preserve. SSRF-guarded at controller
   * level via `clientUploadFields`. The pipeline now computes a
   * bounding box from the mask and feeds it to the model as a
   * text-spatial region descriptor (not as image_input[2]).
   */
  maskUrl: string;
  /**
   * Pre-bbox v4.0 instructional prompt from
   * `buildReplaceAddObjectPrompt(params)`. Retained for telemetry /
   * logging; the pipeline rebuilds the prompt with the computed
   * mask bbox before dispatch, so the value sent to the model is
   * not this string — it is the bbox-aware variant produced inside
   * `runMultiImageEdit`. The string is kept on the input shape so
   * the processor's promptResult chain (which logs
   * promptResult.prompt at the start of the AI call) stays
   * consistent with the rest of the codebase.
   */
  prompt: string;
  /**
   * Server-resolved English title of the inspiration item, used as
   * the `{category}` noun phrase when the pipeline rebuilds the
   * prompt with the computed mask bbox. Sanitized + length-capped
   * by `preEnqueueValidate` in tool-types.ts.
   */
  inspirationTitle: string;
  /**
   * Replace vs. Add mode signal. Drives which prompt template
   * (Replace vs. Add) the bbox-aware rebuild emits. The pipeline
   * runs the same stages for both modes — only the prompt wording
   * differs.
   */
  mode: "replace" | "add";
  /**
   * Tool registry's model config: `{ replicate, falai }`. Read from
   * the tool's `models` field at the processor level and passed
   * through. Unlike the `inpaint` / `segment` / `remove` roles
   * (which read env directly), the `edit` role's models live in
   * the registry entry — see comment in `router.ts`'s
   * `callDesignGeneration`.
   */
  models: {
    replicate: `${string}/${string}`;
    falai: string;
  };
  /** S3 key prefix component. Identifies the user that owns the
   *  generation (matches `RunPromptInpaintInput.userId`). */
  userId: string;
  /** Generation record id, used as the S3 key disambiguator. */
  generationId: string;
}

export interface RunMultiImageEditOutput {
  /** Public URL of the final composited image (the composite step's
   *  output, NOT the raw Nano Banana output). */
  outputImageUrl: string;
  /** Provider that served the model call (Replicate primary or fal.ai
   *  fallback). */
  provider: ProviderId;
  /** Total wall-clock of the pipeline (normalize + model + composite). */
  durationMs: number;
  /** Per-stage breakdown for latency attribution in logs / dashboards. */
  normalizeDurationMs: number;
  modelDurationMs: number;
  compositeDurationMs: number;
}

export async function runMultiImageEdit(
  input: RunMultiImageEditInput,
): Promise<RunMultiImageEditOutput> {
  const start = Date.now();

  // Defense: should be unreachable in production because
  // preEnqueueValidate (tool-types.ts) returns 409 CONTENT_UNAVAILABLE
  // when the Firestore doc's imageUrl is empty. But the pipeline
  // input type marks the field required, so a future caller wiring
  // mistake (forgetting the substitution) shouldn't silently send a
  // two-image array — the structural difference in the model's
  // response would be a quality regression that's hard to diagnose
  // from logs alone. Fail loudly here.
  //
  // `NormalizeInputError` (not a plain `Error`) so the processor's
  // outer catch routes this to `VALIDATION_FAILED` rather than
  // `AI_PROVIDER_FAILED` — this is a server-side configuration error,
  // not a provider outage, and dashboard taxonomy should reflect that.
  if (
    typeof input.inspirationImageUrl !== "string" ||
    input.inspirationImageUrl.length === 0
  ) {
    throw new NormalizeInputError(
      "multi-image-edit: inspirationImageUrl is required but was empty — preEnqueueValidate must populate it",
    );
  }

  logger.info(
    {
      event: "inpaint.multi.started",
      generationId: input.generationId,
      mode: input.mode,
      replicateModel: input.models.replicate,
      falaiModel: input.models.falai,
      promptPreview: input.prompt.slice(0, 120),
      promptLen: input.prompt.length,
    },
    "Multi-image edit pipeline starting",
  );

  // Stage 1: normalize room + mask for dimension alignment. No mask
  // dilation — Nano Banana is semantic, not silhouette-conditioned;
  // dilating the mask would just blur the "white region of image 3"
  // hint the prompt relies on. The normalize step's other guarantees
  // (image long-side cap, EXIF orientation bake, empty-mask refusal)
  // still apply.
  //
  // Wrapped in `withRetry` with the same envelope the deleted
  // `prompt-inpaint.ts` used: one retry on transient errors, no retry
  // on deterministic shape/config errors. Without this wrapper a
  // transient S3 5xx during the normalize-step's PUT permanently
  // fails the generation as `STORAGE_FAILED` (terminal) before the
  // model is even called — same regression class the inpaint path
  // had pre-2026-04 and explicitly guarded against.
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
      onRetry: (error, attempt) => {
        logger.warn(
          {
            event: "inpaint.multi.normalize.retry",
            generationId: input.generationId,
            error: error.message,
            attempt,
          },
          "Normalize pre-step failed, retrying",
        );
      },
    },
  );
  logNormalizeResult(input.generationId, normalized, "inpaint");

  // Snap the room image's AR to the provider's `aspect_ratio` enum
  // using the dimensions normalizeImageMaskPair already computed in
  // memory — no extra HTTP download required. (A prior implementation
  // called probeImageAspectRatio(normalized.imageUrl) here, which
  // re-downloaded the just-uploaded normalized image purely to ask
  // sharp for its dimensions a second time. The dimensions are right
  // there in `normalized.after.image`.) Explicit AR forwarding
  // short-circuits any provider-side AR snapping that would produce
  // dims slightly off from the original.
  const aspectRatio =
    normalized.after.image.width > 0 && normalized.after.image.height > 0
      ? snapToSupportedRatio(
          normalized.after.image.width / normalized.after.image.height,
        )
      : undefined;

  // Compute the brush mask's white-pixel bounding box, then rebuild
  // the instructional prompt so the model receives a text-spatial
  // region descriptor ("the rectangular region from left 9% to right
  // 24%") rather than relying on it to interpret a 3rd image slot
  // as a semantic mask. Staging confirmed Nano Banana ignores the
  // image-3-as-mask signal — it would place the inspiration in the
  // visual center of the room regardless of where the user painted,
  // and the composite step would correctly drop the misplaced edit
  // leaving the user with an unchanged scene. The bbox text path
  // matches Google's documented "composition" pattern from the Nano
  // Banana prompting guide.
  //
  // When bbox computation fails (degenerate mask, sharp decode
  // error), we fall back to the legacy image-3-as-mask template +
  // 3-image array — same behavior as the v4.0 baseline. This is a
  // strict improvement on the broken path: at worst we get the same
  // failure mode we shipped with, at best we get a working edit.
  const maskBbox = await computeMaskBbox(
    normalized.maskUrl,
    input.generationId,
  );
  const rebuilt = buildReplaceAddObjectPrompt(
    {
      // Reconstruct the minimal subset of ReplaceAddObjectParams the
      // builder actually consumes (mode + inspirationTitle). The
      // builder ignores the other fields; passing them through
      // would mean threading the full params blob into the pipeline
      // signature for no behavioral benefit.
      imageUrl: input.imageUrl,
      maskUrl: input.maskUrl,
      prompt: "",
      categoryId: "",
      inspirationId: "",
      inspirationImageUrl: input.inspirationImageUrl,
      inspirationTitle: input.inspirationTitle,
      mode: input.mode,
    },
    { maskBbox },
  );
  const finalPrompt = rebuilt.prompt;

  logger.info(
    {
      event: "inpaint.multi.prompt_rebuilt",
      generationId: input.generationId,
      mode: input.mode,
      hasMaskBbox: maskBbox !== null,
      bbox: maskBbox,
      promptLen: finalPrompt.length,
      promptPreview: finalPrompt.slice(0, 200),
    },
    maskBbox
      ? "Multi-image edit prompt rebuilt with bbox text-spatial template"
      : "Multi-image edit prompt fell back to image-3-as-mask template (bbox compute failed or all-black mask)",
  );

  // Stage 2: call the multi-image edit model.
  //   - When bbox was computed: 2-image array [room, inspiration].
  //     The mask is NOT sent as a 3rd image — the bbox text in the
  //     prompt is the spatial signal. This matches the well-tested
  //     google/nano-banana pattern from Google's docs and is what
  //     Replicate's example payloads ship.
  //   - When bbox was null (fallback): 3-image array [room,
  //     inspiration, mask] + legacy image-3 prompt — the v4.0
  //     baseline behavior, retained because something is better
  //     than nothing for the unreachable-in-practice edge case.
  const extraImageUrls = maskBbox ? [] : [normalized.maskUrl];
  const modelStart = Date.now();
  const modelResult = await callDesignGeneration(input.models, {
    prompt: finalPrompt,
    imageUrl: normalized.imageUrl,
    referenceImageUrl: input.inspirationImageUrl,
    extraImageUrls,
    aspectRatio,
    // No guidanceScale — Nano Banana has no CFG knob
    // (supportsGuidanceScale: false). Provider adapters drop the
    // field when the capability matrix says so, but explicitly
    // omitting it here documents the intent.
  });
  const modelDurationMs = Date.now() - modelStart;

  logger.info(
    {
      event: "inpaint.multi.model_completed",
      generationId: input.generationId,
      mode: input.mode,
      provider: modelResult.provider,
      modelDurationMs,
      modelOutputUrl: modelResult.imageUrl,
    },
    "Multi-image edit model call completed",
  );

  // Stage 3: composite the model output back over the NORMALIZED room
  // image using the NORMALIZED mask. Using the originals would bypass
  // the normalize step's MAX_LONG_SIDE=2048 cap — a 48 MP iPhone
  // capture would allocate ~80 MB of RGBA buffers through the sharp
  // composite pipeline and approach the Render instance's 512 MB
  // memory ceiling under concurrent load. The normalize step already
  // baked EXIF orientation and matched image+mask dims, so the
  // composite runs in a known-bounded, dim-aligned coordinate space.
  //
  // The "user expects original pixels back outside the mask" property
  // is preserved at the perceptual level: normalize's re-encode is a
  // single q=90 JPEG pass, visually identical to the input at the
  // resolution caps we ship. Strict byte-identical preservation was
  // never available anyway — the normalize step's re-encode of the
  // user upload runs upstream of any composite work.
  const composite = await compositeMaskedResult({
    originalUrl: normalized.imageUrl,
    editedUrl: modelResult.imageUrl,
    maskUrl: normalized.maskUrl,
    userId: input.userId,
    generationId: input.generationId,
  });

  const durationMs = Date.now() - start;

  logger.info(
    {
      event: "inpaint.multi.completed",
      generationId: input.generationId,
      mode: input.mode,
      provider: modelResult.provider,
      durationMs,
      normalizeDurationMs: normalized.durationMs,
      modelDurationMs,
      compositeDurationMs: composite.durationMs,
      finalOutputUrl: composite.outputImageUrl,
    },
    "Multi-image edit pipeline completed",
  );

  return {
    outputImageUrl: composite.outputImageUrl,
    provider: modelResult.provider,
    durationMs,
    normalizeDurationMs: normalized.durationMs,
    modelDurationMs,
    compositeDurationMs: composite.durationMs,
  };
}

/**
 * Compute the white-pixel bounding box of a binary mask PNG, in
 * normalized [0..1] coordinates. Used to feed Nano Banana a
 * text-spatial region descriptor that the model actually follows
 * instead of relying on it to interpret a 3rd image_input slot as a
 * semantic mask.
 *
 * Threshold: pixel value > 127 = white. The normalize step
 * upstream already collapses RGB masks to greyscale and rejects
 * effectively-empty masks (MIN_MASK_WHITE_FRACTION = 0.001), so by
 * the time we reach this point the mask is well-formed and the
 * threshold is a no-op cleanup against soft edges that survived
 * the Gaussian-blur dilation.
 *
 * Failure modes return null and let the pipeline fall back to the
 * legacy image-3-as-mask template:
 *   - sharp decode error on the mask buffer
 *   - all-black mask post-threshold (no white pixels — should be
 *     unreachable since normalize rejects this upstream, but
 *     defended here so a thin-slice escape doesn't crash the
 *     pipeline)
 *
 * Cost: O(width × height) single-pass scan. At 1024×1024 ≈ 10ms
 * on the deployment instance. Cheap relative to the 5-15s Nano
 * Banana call that follows.
 */
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
        {
          event: "inpaint.multi.bbox.all_black",
          generationId,
          width,
          height,
        },
        "Mask bbox compute found no white pixels (should be unreachable; normalize step rejects empty masks)",
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
        event: "inpaint.multi.bbox.error",
        generationId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Mask bbox compute failed, falling back to image-3-as-mask prompt template",
    );
    return null;
  }
}
