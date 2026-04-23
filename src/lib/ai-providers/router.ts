import {
  designCircuitBreaker,
  designCircuitBreakerFalPrimary,
  type CircuitBreaker,
} from "../circuit-breaker.js";
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
  ProviderId,
  RemovalInput,
  RemovalOutput,
  SegmentationInput,
  SegmentationOutput,
} from "./types.js";

interface ToolModelConfig {
  replicate: `${string}/${string}`;
  falai: string;
  /**
   * Which provider handles the primary path. Defaults to "replicate".
   * When "falai", the router flips: fal.ai is tried first and Replicate
   * is the hard-failure fallback. Used by reference-style (Kontext Max
   * Multi primary, Nano Banana fallback).
   */
  primaryProvider?: ProviderId;
}

const PROBE_COOLDOWN_MS = 30_000;
const PROBE_TIMEOUT_MS = 30_000;
const lastProbeTime = new Map<string, number>();

type Providers = {
  primary: ProviderId;
  callPrimary: () => Promise<GenerationOutput>;
  callFallback: () => Promise<GenerationOutput>;
  breaker: CircuitBreaker;
  primaryModel: string;
  fallbackModel: string;
};

function resolveProviders(
  models: ToolModelConfig,
  input: GenerationInput,
): Providers {
  if (models.primaryProvider === "falai") {
    return {
      primary: "falai",
      callPrimary: () => callFalAI(models.falai, input),
      callFallback: () => callReplicate(models.replicate, input),
      breaker: designCircuitBreakerFalPrimary,
      primaryModel: models.falai,
      fallbackModel: models.replicate,
    };
  }
  return {
    primary: "replicate",
    callPrimary: () => callReplicate(models.replicate, input),
    callFallback: () => callFalAI(models.falai, input),
    breaker: designCircuitBreaker,
    primaryModel: models.replicate,
    fallbackModel: models.falai,
  };
}

/**
 * Route an AI generation request through the circuit breaker.
 *
 * Default flow: Replicate primary, fal.ai fallback (interior, exterior,
 * garden, etc.). When `models.primaryProvider === "falai"`, the flow flips:
 * fal.ai primary, Replicate fallback (reference-style). Each direction uses
 * its own circuit-breaker instance so health signals stay independent.
 */
export async function callDesignGeneration(
  models: ToolModelConfig,
  input: GenerationInput,
): Promise<GenerationOutput> {
  const providers = resolveProviders(models, input);
  const {
    primary,
    callPrimary,
    callFallback,
    breaker,
    primaryModel,
    fallbackModel,
  } = providers;
  const fallbackProvider = breaker.fallbackProvider;

  const useFallback = breaker.shouldUseFallback();

  // Shared fallback invocation used by both the circuit-open path and the
  // primary-failure catch path. Wraps in withRetry(maxRetries:1) so the two
  // paths behave symmetrically (a transient fallback error gets one retry
  // regardless of whether the breaker was already open). Records breaker
  // outcome on the fallback side too — otherwise a persistently broken
  // fallback would never contribute to any health signal.
  async function callFallbackWithRetry(
    reason: "circuit_open" | "primary_failed",
  ): Promise<GenerationOutput> {
    try {
      const result = await withRetry(callFallback, {
        maxRetries: 1,
        delayMs: 1000,
        onRetry: (error, attempt) => {
          logger.warn(
            {
              event: "provider.retry",
              provider: fallbackProvider,
              error: error.message,
              attempt,
            },
            `${fallbackProvider} fallback call failed, retrying`,
          );
        },
      });
      breaker.record(true);
      logger.info(
        {
          event: "provider.generation",
          provider: fallbackProvider,
          model: fallbackModel,
          fallbackFired: true,
          fallbackReason: reason,
        },
        "Generation served from fallback provider",
      );
      return result;
    } catch (error) {
      breaker.record(false);
      throw error;
    }
  }

  if (useFallback) {
    logger.info(
      {
        event: "provider.circuit_open",
        provider: fallbackProvider,
        breaker: breaker.name,
      },
      `Circuit open — routing to ${fallbackProvider} fallback`,
    );

    // Fire-and-forget probe to check if the primary has recovered. Probe
    // gets its own AbortController so a hanging primary can't keep a
    // zombie promise alive past graceful shutdown — the SIGTERM handler
    // (not wired here; lives in app shutdown hooks) aborts pending probes.
    const now = Date.now();
    const lastProbe = lastProbeTime.get(breaker.name) ?? 0;
    if (now - lastProbe >= PROBE_COOLDOWN_MS) {
      lastProbeTime.set(breaker.name, now);
      const probeTimeout = setTimeout(
        () => breaker.recordProbe(false),
        PROBE_TIMEOUT_MS,
      );
      probeTimeout.unref?.();
      callPrimary()
        .then(() => {
          clearTimeout(probeTimeout);
          breaker.recordProbe(true);
        })
        .catch(() => {
          clearTimeout(probeTimeout);
          breaker.recordProbe(false);
        });
    }

    return callFallbackWithRetry("circuit_open");
  }

  // Primary path with retry. Record circuit breaker once per logical
  // request, not per retry attempt.
  try {
    const result = await withRetry(callPrimary, {
      maxRetries: 1,
      delayMs: 1000,
      onRetry: (error, attempt) => {
        logger.warn(
          {
            event: "provider.retry",
            provider: primary,
            error: error.message,
            attempt,
          },
          `${primary} call failed, retrying`,
        );
      },
    });

    breaker.record(true);
    logger.info(
      {
        event: "provider.generation",
        provider: primary,
        model: primaryModel,
        fallbackFired: false,
      },
      "Generation served from primary provider",
    );
    return result;
  } catch (error) {
    breaker.record(false);

    logger.error(
      {
        event: "provider.fallback",
        provider: fallbackProvider,
        error: error instanceof Error ? error.message : String(error),
      },
      `${primary} failed after retries, trying ${fallbackProvider} fallback`,
    );

    return callFallbackWithRetry("primary_failed");
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
