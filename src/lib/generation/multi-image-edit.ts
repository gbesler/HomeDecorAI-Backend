import { callDesignGeneration } from "../ai-providers/router.js";
import type { ProviderId } from "../ai-providers/types.js";
import { logger } from "../logger.js";
import { withRetry } from "../retry.js";
import { StorageUploadError } from "../storage/s3-upload.js";
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
   * Public URL of the client-uploaded brush mask PNG (image 3).
   * White = modify, black = preserve. SSRF-guarded at controller
   * level via `clientUploadFields`.
   */
  maskUrl: string;
  /**
   * v4.0 instructional prompt from `buildReplaceAddObjectPrompt`.
   * References image 1 / image 2 / image 3 explicitly — the
   * provider call must put the URLs in matching slot order or the
   * model's image numbering breaks.
   */
  prompt: string;
  /**
   * Replace vs. Add mode signal. Forwarded to logs for per-mode
   * telemetry; the actual replace/add branching lives in the prompt
   * builder, not here. The pipeline runs the same stages for both
   * modes — only the prompt wording differs.
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

  // Stage 2: call the multi-image edit model. The provider adapters
  // (replicate.ts / falai.ts) construct the 3-element image array
  // from these three slots in this order:
  //   imageUrl         → image_input[0] = image 1 (target room)
  //   referenceImageUrl → image_input[1] = image 2 (inspiration)
  //   extraImageUrls[0] → image_input[2] = image 3 (brush mask)
  // The v4.0 instructional prompt references "image 1", "image 2",
  // "image 3" — DO NOT reorder these args without also updating the
  // prompt template in `prompts/tools/replace-add-object.ts`.
  const modelStart = Date.now();
  const modelResult = await callDesignGeneration(input.models, {
    prompt: input.prompt,
    imageUrl: normalized.imageUrl,
    referenceImageUrl: input.inspirationImageUrl,
    extraImageUrls: [normalized.maskUrl],
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
