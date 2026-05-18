import { callKontextInpaint } from "../ai-providers/router.js";
import type { ProviderId } from "../ai-providers/types.js";
import { logger } from "../logger.js";
import { buildReplaceAddObjectPrompt } from "../prompts/tools/replace-add-object.js";
import { withRetry } from "../retry.js";
import { StorageUploadError } from "../storage/s3-upload.js";
import { compositeMaskedResult } from "./composite-masked-result.js";
import {
  logNormalizeResult,
  NormalizeInputError,
  normalizeImageMaskPair,
} from "./normalize-image-mask-pair.js";

/**
 * Replace & Add Object v6.0 — Flux Kontext LoRA Inpaint.
 *
 * Replaces v5.x crop-composite-refine. The v5 pipeline (birefnet bg-remove
 * + sharp composite + optional refine) failed the user's quality bar
 * because pixel-level pasting is not a model condition — downstream
 * inpaint models either ignored the pasted cutout (Flux Fill regenerated
 * from prompt only) or the original object's pixels around the cutout
 * remained visible (no refine path).
 *
 * v6.0 uses fal-ai/flux-kontext-lora/inpaint, the first verified-live
 * endpoint in 2026 with native reference-aware inpaint:
 *
 *   image_url + mask_url + reference_image_url + prompt
 *
 * Kontext (ACE++ architecture lineage) ingests the reference image as
 * an in-context token to the DiT's cross-attention, so subject identity
 * is preserved through the inpaint denoise — the model erases the
 * original object inside the mask AND places the reference object in
 * the same forward pass.
 *
 * **Pipeline:**
 *   1. Normalize room + mask (existing) — align dims, bake EXIF, validate
 *      mask non-emptiness.
 *   2. callKontextInpaint — single fal.ai call. ~$0.035/generation.
 *   3. compositeMaskedResult — defensive composite enforcement against
 *      the original normalized room using the brush mask as a feathered
 *      alpha. Kontext's inpaint is well-behaved outside the mask but
 *      JPEG re-encode can introduce subtle color drift; the composite
 *      step's byte-identical preservation guarantee is cheap insurance.
 *
 * **Function name retained** as `runCropCompositeRefine` to minimize
 * the diff against the generation-processor's import. The pipeline body
 * is entirely rewritten; the bg-remove + sharp composite + refine paths
 * are gone.
 *
 * See `docs/plans/2026-05-18-001-refactor-replace-add-object-v5-crop-composite-refine-plan.md`
 * (extended with v6.0 outcome) for the cumulative failure timeline that
 * led here.
 */

export interface RunCropCompositeRefineInput {
  imageUrl: string;
  inspirationImageUrl: string;
  maskUrl: string;
  /** Pre-built prompt from buildReplaceAddObjectPrompt — kept on the
   *  shape for processor logging continuity. The pipeline rebuilds with
   *  the v6.0 concise template before dispatch. */
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

export async function runCropCompositeRefine(
  input: RunCropCompositeRefineInput,
): Promise<RunCropCompositeRefineOutput> {
  const start = Date.now();

  if (
    typeof input.inspirationImageUrl !== "string" ||
    input.inspirationImageUrl.length === 0
  ) {
    throw new NormalizeInputError(
      "kontext-inpaint: inspirationImageUrl is required but was empty — preEnqueueValidate must populate it",
    );
  }

  logger.info(
    {
      event: "inpaint.kontext.started",
      generationId: input.generationId,
      mode: input.mode,
    },
    "Kontext inpaint pipeline starting (v6.0)",
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

  // Stage 2: rebuild prompt with v6.0 concise template and call Kontext.
  // The researcher's recommendation: keep the prompt short and
  // category-anchored, let the reference image do the identity work.
  // Long descriptive prompts fight the reference signal in DiT models.
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
  const kontextPrompt = rebuilt.prompt;

  // Strength tuning per mode:
  //   - replace (0.88, Kontext default): full denoise inside the mask —
  //     erases the original object completely while reference guides
  //     the new content.
  //   - add (0.85): slightly lower so the new object blends with the
  //     surrounding empty surface (wall/floor) more naturally without
  //     drifting away from the reference identity.
  const strength = input.mode === "add" ? 0.85 : 0.88;

  const kontextStart = Date.now();
  const kontextResult = await callKontextInpaint({
    imageUrl: normalized.imageUrl,
    maskUrl: normalized.maskUrl,
    referenceImageUrl: input.inspirationImageUrl,
    prompt: kontextPrompt,
    strength,
  });
  const kontextDurationMs = Date.now() - kontextStart;

  logger.info(
    {
      event: "inpaint.kontext.model_completed",
      generationId: input.generationId,
      mode: input.mode,
      provider: kontextResult.provider,
      kontextDurationMs,
      strength,
      kontextOutputUrl: kontextResult.imageUrl,
      promptPreview: kontextPrompt.slice(0, 200),
      promptLen: kontextPrompt.length,
    },
    "Kontext inpaint model returned",
  );

  // Stage 3: defensive composite enforcement against original normalized
  // room using brush mask. Kontext's inpaint is well-behaved outside the
  // mask but JPEG re-encode can introduce subtle color drift; this step
  // guarantees byte-perceptual outside-mask preservation against any
  // drift the model introduces.
  const composite = await compositeMaskedResult({
    originalUrl: normalized.imageUrl,
    editedUrl: kontextResult.imageUrl,
    maskUrl: normalized.maskUrl,
    userId: input.userId,
    generationId: input.generationId,
  });

  const durationMs = Date.now() - start;
  logger.info(
    {
      event: "inpaint.kontext.completed",
      generationId: input.generationId,
      mode: input.mode,
      provider: kontextResult.provider,
      durationMs,
      normalizeDurationMs: normalized.durationMs,
      kontextDurationMs,
      compositeDurationMs: composite.durationMs,
      finalOutputUrl: composite.outputImageUrl,
    },
    "Kontext inpaint pipeline completed (v6.0)",
  );

  return {
    outputImageUrl: composite.outputImageUrl,
    provider: kontextResult.provider,
    durationMs,
    normalizeDurationMs: normalized.durationMs,
    // v5 fields retained for output-shape continuity; bg-remove and
    // crop-composite stages no longer exist in v6.0.
    bgRemoveDurationMs: 0,
    cropCompositeDurationMs: 0,
    refineDurationMs: kontextDurationMs,
    compositeDurationMs: composite.durationMs,
  };
}
