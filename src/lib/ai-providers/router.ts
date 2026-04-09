import { designCircuitBreaker } from "../circuit-breaker.js";
import { withRetry } from "../retry.js";
import { logger } from "../logger.js";
import { callReplicate } from "./replicate.js";
import { callFalAI } from "./falai.js";
import type { GenerationInput, GenerationOutput } from "./types.js";

interface ToolModelConfig {
  replicate: `${string}/${string}`;
  falai: string;
}

const PROBE_COOLDOWN_MS = 30_000;
let lastProbeTime = 0;

/**
 * Route an AI generation request through the circuit breaker.
 * Primary: Replicate. Fallback: fal.ai.
 */
export async function callDesignGeneration(
  models: ToolModelConfig,
  input: GenerationInput,
): Promise<GenerationOutput> {
  const useFallback = designCircuitBreaker.shouldUseFallback();

  if (useFallback) {
    logger.info("Circuit open — routing to fal.ai fallback");

    // Fire-and-forget probe to check if Replicate has recovered
    const now = Date.now();
    if (now - lastProbeTime >= PROBE_COOLDOWN_MS) {
      lastProbeTime = now;
      callReplicate(models.replicate, input)
        .then(() => designCircuitBreaker.recordProbe(true))
        .catch(() => designCircuitBreaker.recordProbe(false));
    }

    return withRetry(() => callFalAI(models.falai, input), {
      maxRetries: 1,
      delayMs: 1000,
      onRetry: (error, attempt) => {
        logger.warn(
          { error: error.message, attempt },
          "fal.ai fallback call failed, retrying",
        );
      },
    });
  }

  // Primary path: Replicate with retry
  // Record circuit breaker once per logical request, not per retry attempt
  try {
    const result = await withRetry(
      () => callReplicate(models.replicate, input),
      {
        maxRetries: 1,
        delayMs: 1000,
        onRetry: (error, attempt) => {
          logger.warn(
            { error: error.message, attempt },
            "Replicate call failed, retrying",
          );
        },
      },
    );

    designCircuitBreaker.record(true);
    return result;
  } catch (error) {
    designCircuitBreaker.record(false);

    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Replicate failed after retries, trying fal.ai fallback",
    );

    // Immediate fallback for this request
    return callFalAI(models.falai, input);
  }
}
