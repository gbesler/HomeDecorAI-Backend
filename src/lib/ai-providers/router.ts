import { designCircuitBreaker } from "../circuit-breaker.js";
import { env } from "../env.js";
import { withRetry } from "../retry.js";
import { logger } from "../logger.js";
import {
  callInpaintReplicate,
  callRemovalReplicate,
  callReplicate,
  callSegmentationReplicate,
} from "./replicate.js";
import { callFalAI } from "./falai.js";
import type {
  GenerationInput,
  GenerationOutput,
  InpaintInput,
  InpaintOutput,
  RemovalInput,
  RemovalOutput,
  SegmentationInput,
  SegmentationOutput,
} from "./types.js";

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
    logger.info(
      { event: "provider.circuit_open", provider: "falai" },
      "Circuit open — routing to fal.ai fallback",
    );

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
          { event: "provider.retry", provider: "falai", error: error.message, attempt },
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
            { event: "provider.retry", provider: "replicate", error: error.message, attempt },
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
      {
        event: "provider.fallback",
        provider: "falai",
        error: error instanceof Error ? error.message : String(error),
      },
      "Replicate failed after retries, trying fal.ai fallback",
    );

    // Immediate fallback for this request
    return callFalAI(models.falai, input);
  }
}

/**
 * Run text-grounded segmentation. Replicate-only: no fal.ai equivalent is
 * wired today. Records circuit-breaker state so repeated segmentation
 * failures contribute to the same "Replicate degraded" signal as edit calls.
 *
 * Throws `NoMaskDetectedError` when the model succeeds but matches zero
 * regions — that is NOT a breaker-worthy failure and is re-thrown unchanged.
 */
export async function callSegmentation(
  input: SegmentationInput,
): Promise<SegmentationOutput> {
  const model = env.REPLICATE_SEGMENTATION_MODEL;
  try {
    const result = await withRetry(
      () => callSegmentationReplicate(model, input),
      {
        maxRetries: 1,
        delayMs: 1000,
        // A "no mask detected" result is a deterministic terminal outcome;
        // retrying would bill SAM a second time for the same answer.
        isRetryable: (error) => error.name !== "NoMaskDetectedError",
        onRetry: (error, attempt) => {
          logger.warn(
            { event: "provider.retry", provider: "replicate", role: "segment", error: error.message, attempt },
            "Segmentation call failed, retrying",
          );
        },
      },
    );
    designCircuitBreaker.record(true);
    return result;
  } catch (error) {
    // NoMaskDetectedError is a domain signal, not a provider health issue.
    // Do not pollute the breaker with it.
    if (error instanceof Error && error.name === "NoMaskDetectedError") {
      throw error;
    }
    designCircuitBreaker.record(false);
    throw error;
  }
}

/**
 * Run mask-guided object removal via LaMa. Replicate-only. Same breaker
 * semantics as `callDesignGeneration` but no fal.ai fallback — LaMa has
 * no equivalent wired on the fallback side.
 */
export async function callRemoval(
  input: RemovalInput,
): Promise<RemovalOutput> {
  const model = env.REPLICATE_REMOVAL_MODEL;
  try {
    const result = await withRetry(
      () => callRemovalReplicate(model, input),
      {
        maxRetries: 1,
        delayMs: 1000,
        onRetry: (error, attempt) => {
          logger.warn(
            { event: "provider.retry", provider: "replicate", role: "remove", error: error.message, attempt },
            "Removal call failed, retrying",
          );
        },
      },
    );
    designCircuitBreaker.record(true);
    return result;
  } catch (error) {
    designCircuitBreaker.record(false);
    throw error;
  }
}

/**
 * Run prompt-driven inpainting via Flux Fill. Replicate-only; mirrors the
 * breaker + single-retry envelope of `callRemoval`. No fal.ai fallback — the
 * fallback provider has no inpaint-with-prompt model wired up, and silently
 * substituting a non-inpainting path would degrade quality without signal.
 */
export async function callInpaint(
  input: InpaintInput,
): Promise<InpaintOutput> {
  const model = env.REPLICATE_INPAINT_MODEL;
  try {
    const result = await withRetry(
      () => callInpaintReplicate(model, input),
      {
        maxRetries: 1,
        delayMs: 1000,
        onRetry: (error, attempt) => {
          logger.warn(
            { event: "provider.retry", provider: "replicate", role: "inpaint", error: error.message, attempt },
            "Inpaint call failed, retrying",
          );
        },
      },
    );
    designCircuitBreaker.record(true);
    return result;
  } catch (error) {
    designCircuitBreaker.record(false);
    throw error;
  }
}
