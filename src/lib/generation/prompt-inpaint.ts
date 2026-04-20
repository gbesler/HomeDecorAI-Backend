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

export interface RunPromptInpaintInput {
  imageUrl: string;
  /** Client-uploaded binary mask PNG. White = replace, black = preserve. */
  maskUrl: string;
  prompt: string;
  guidanceScale?: number;
}

export interface RunPromptInpaintOutput {
  outputImageUrl: string;
  /** Provider id ("replicate" today). Forwarded to `recordAiResult`. */
  provider: string;
  durationMs: number;
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

  try {
    const result = await callInpaint({
      imageUrl: input.imageUrl,
      maskUrl: input.maskUrl,
      prompt: input.prompt,
      guidanceScale: input.guidanceScale,
    });
    const durationMs = Date.now() - start;
    logger.info(
      {
        event: "inpaint.completed",
        durationMs,
        provider: result.provider,
      },
      "Flux Fill inpaint completed",
    );
    return {
      outputImageUrl: result.imageUrl,
      provider: result.provider,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - start;
    logger.error(
      {
        event: "inpaint.failed",
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      },
      "Flux Fill inpaint failed",
    );
    throw error;
  }
}
