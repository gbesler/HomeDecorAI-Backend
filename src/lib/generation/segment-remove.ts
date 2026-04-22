/**
 * Segmentation + removal pipeline helpers (SAM 3 + LaMa).
 *
 * Two composable stages the generation processor chains:
 *
 *   1. `runSegmentationAndPersistMask` — SAM 3 with a concept prompt
 *      ("clutter", "trash . empty bottles", etc.) + S3 persist of the returned
 *      binary mask. Runs once per generationId. The processor writes the
 *      mask URL to Firestore as the `segmentationMaskUrl` checkpoint
 *      IMMEDIATELY after this returns, so a later LaMa failure does not
 *      cause SAM 3 to re-run on retry.
 *
 *   2. `runRemoval` — LaMa with `image + mask`. No prompt (LaMa doesn't
 *      accept one). The model extends the surrounding surface.
 *
 * Remove Objects (mode="remove-only") uses only `runRemoval`, feeding it a
 * client-uploaded brush mask URL. The controller is responsible for
 * host-allowlisting that URL before it gets here.
 *
 * Error taxonomy:
 *
 *   - `NoMaskDetectedError` — SAM 3 succeeded but matched zero regions.
 *     Propagated unchanged so the processor translates it into a terminal
 *     `VALIDATION_FAILED` state ("already clean").
 *   - `StorageUploadError` / `CognitoCredentialMintError` — bubbled up
 *     verbatim so the processor can map them to a terminal `STORAGE_FAILED`.
 *     Do not swallow or rename here.
 *   - Anything else — treated as an AI provider failure by the caller.
 */

import {
  callRemoval,
  callSegmentation,
} from "../ai-providers/index.js";
import { logger } from "../logger.js";
import { persistGenerationImage } from "../storage/s3-upload.js";
import {
  logNormalizeResult,
  normalizeRemovalInputs,
} from "./normalize-removal-inputs.js";

// ─── Stage 1: segment + persist ─────────────────────────────────────────────

export interface RunSegmentationAndPersistMaskInput {
  userId: string;
  generationId: string;
  imageUrl: string;
  /**
   * SAM 3 concept prompt. Short noun phrases separated by ".".
   * Examples: "clutter", "trash . empty bottles . dirty dishes".
   */
  textPrompt: string;
}

export interface RunSegmentationAndPersistMaskOutput {
  /**
   * Permanent S3-hosted mask URL. The caller is expected to persist this as
   * the `segmentationMaskUrl` Firestore checkpoint BEFORE invoking `runRemoval`
   * so a subsequent retry can reuse it rather than re-running SAM 3.
   */
  maskUrl: string;
  /** Wall-clock duration of segmentation + persist, not including removal. */
  durationMs: number;
}

export async function runSegmentationAndPersistMask(
  input: RunSegmentationAndPersistMaskInput,
): Promise<RunSegmentationAndPersistMaskOutput> {
  const start = Date.now();
  const { userId, generationId, imageUrl, textPrompt } = input;

  const segmentation = await callSegmentation({ imageUrl, textPrompt });

  logger.info(
    {
      event: "segment.mask_detected",
      generationId,
      textPrompt,
      durationMs: segmentation.durationMs,
    },
    "SAM 3 mask generated",
  );

  // Replicate delivery URLs expire — re-host on our S3 so retries can reuse
  // the same mask. `persistGenerationImage` enforces ALLOWED_AI_DOWNLOAD_HOSTS,
  // which validates that `segmentation.maskUrl` came from a trusted provider
  // host. `StorageUploadError` / `CognitoCredentialMintError` bubble up
  // verbatim to the processor, which maps them to STORAGE_FAILED.
  const persisted = await persistGenerationImage({
    userId,
    generationId,
    sourceUrl: segmentation.maskUrl,
    keyPrefix: "masks",
  });
  const maskUrl = persisted.outputImageCDNUrl ?? persisted.outputImageUrl;

  return {
    maskUrl,
    durationMs: Date.now() - start,
  };
}

// ─── Stage 2: remove (LaMa) ────────────────────────────────────────────────

export interface RunRemovalInput {
  imageUrl: string;
  maskUrl: string;
  /**
   * Required for the normalization pre-step (S3 key path for the
   * `normalized/` prefix). Not used directly by LaMa.
   */
  userId: string;
  generationId: string;
}

export interface RunRemovalOutput {
  outputImageUrl: string;
  /** Provider id ("replicate" today). Forwarded to `recordAiResult`. */
  provider: string;
  durationMs: number;
  /** Wall-clock of the normalization pre-step alone. Separated so callers
   *  can reason about LaMa latency vs. preprocessing overhead. */
  normalizeDurationMs: number;
}

export async function runRemoval(
  input: RunRemovalInput,
): Promise<RunRemovalOutput> {
  const start = Date.now();

  // Defensive normalization: guarantees image + mask share pixel
  // dimensions and that the image is within LaMa's practical envelope.
  // Passthrough short-circuit means this is effectively free when inputs
  // already satisfy the invariants (notably once iOS Phase A ships — see
  // HomeDecorAI/docs/plans/2026-04-22-001-fix-remove-objects-image-mask-unify-plan.md).
  const normalized = await normalizeRemovalInputs({
    imageUrl: input.imageUrl,
    maskUrl: input.maskUrl,
    userId: input.userId,
    generationId: input.generationId,
  });
  logNormalizeResult(input.generationId, normalized);

  const result = await callRemoval({
    imageUrl: normalized.imageUrl,
    maskUrl: normalized.maskUrl,
    normalizedDims: normalized.after.image,
  });
  logger.info(
    {
      event: "remove.completed",
      generationId: input.generationId,
      durationMs: result.durationMs,
      normalizeDurationMs: normalized.durationMs,
      normalizeAction: normalized.action,
    },
    "LaMa removal completed",
  );
  return {
    outputImageUrl: result.imageUrl,
    provider: result.provider,
    durationMs: Date.now() - start,
    normalizeDurationMs: normalized.durationMs,
  };
}
