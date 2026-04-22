/**
 * Prompt-driven inpainting stage (Flux Fill).
 *
 * Single stage — no segmentation, no mask persistence, no multi-step chain.
 * The caller supplies a client-uploaded mask (iOS brush) plus a curated
 * inspiration prompt; this helper just invokes `callInpaint` and returns the
 * output URL for the processor's S3 persist step.
 *
 * Error taxonomy: any thrown error propagates verbatim. The generation
 * processor's outer try/catch maps it to `AI_PROVIDER_FAILED` (our default for
 * non-storage errors from provider calls).
 */

import { callInpaint } from "../ai-providers/index.js";
import { logger } from "../logger.js";
import { withRetry } from "../retry.js";
import { StorageUploadError } from "../storage/s3-upload.js";
import {
  logNormalizeResult,
  NormalizeInputError,
  normalizeImageMaskPair,
} from "./normalize-image-mask-pair.js";

export interface RunPromptInpaintInput {
  imageUrl: string;
  /** Client-uploaded binary mask PNG. White = replace, black = preserve. */
  maskUrl: string;
  prompt: string;
  guidanceScale?: number;
  /**
   * Required for the normalization pre-step (S3 key path for the
   * `normalized/` prefix). Mirrors `RunRemovalInput`. Not used directly
   * by Flux Fill.
   */
  userId: string;
  generationId: string;
}

export interface RunPromptInpaintOutput {
  outputImageUrl: string;
  /** Provider id ("replicate" today). Forwarded to `recordAiResult`. */
  provider: string;
  durationMs: number;
  /** Wall-clock of the normalization pre-step alone. Separated so
   *  callers can reason about Flux Fill latency vs. preprocessing
   *  overhead. */
  normalizeDurationMs: number;
}

export async function runPromptInpaint(
  input: RunPromptInpaintInput,
): Promise<RunPromptInpaintOutput> {
  const start = Date.now();
  logger.info(
    {
      event: "inpaint.started",
      promptPreview: input.prompt.slice(0, 40),
      promptLen: input.prompt.length,
    },
    "Flux Fill inpaint starting",
  );

  // Defensive normalization: guarantees image + mask share pixel
  // dimensions and that the image is within Flux Fill's practical
  // envelope. Mirrors the Remove Objects path — see
  // src/lib/generation/normalize-image-mask-pair.ts and
  // src/lib/generation/segment-remove.ts for the full rationale.
  //
  // Same retry envelope as Remove Objects: one retry on transients,
  // no retry on deterministic client-shape / config errors.
  const normalized = await withRetry(
    () =>
      normalizeImageMaskPair({
        imageUrl: input.imageUrl,
        maskUrl: input.maskUrl,
        userId: input.userId,
        generationId: input.generationId,
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
            event: "inpaint.normalize.retry",
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

  try {
    const result = await callInpaint({
      imageUrl: normalized.imageUrl,
      maskUrl: normalized.maskUrl,
      prompt: input.prompt,
      guidanceScale: input.guidanceScale,
      normalizedDims: normalized.after.image,
    });
    const durationMs = Date.now() - start;
    logger.info(
      {
        event: "inpaint.completed",
        generationId: input.generationId,
        durationMs,
        normalizeDurationMs: normalized.durationMs,
        normalizeAction: normalized.action,
        provider: result.provider,
      },
      "Flux Fill inpaint completed",
    );
    return {
      outputImageUrl: result.imageUrl,
      provider: result.provider,
      durationMs,
      normalizeDurationMs: normalized.durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - start;
    logger.error(
      {
        event: "inpaint.failed",
        generationId: input.generationId,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      },
      "Flux Fill inpaint failed",
    );
    throw error;
  }
}
