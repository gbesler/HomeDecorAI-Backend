import {
  designCircuitBreaker,
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
import {
  callFalAI,
  callInpaintFalAI,
  callRemovalFalAI,
  callSegmentationFalAI,
} from "./falai.js";
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
 * Replicate primary, fal.ai fallback. Every tool in the registry shares this
 * flow (interior, exterior, garden, reference-style, etc.), tracked by the
 * single `designCircuitBreaker` instance.
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
 * Run text-grounded segmentation. Replicate primary (SAM 3), fal.ai fallback
 * (`fal-ai/sam-3/image`). Shares the `designCircuitBreaker` instance with
 * edit calls so repeated segmentation failures contribute to the same
 * "Replicate degraded" signal.
 *
 * Throws `NoMaskDetectedError` when either provider succeeds but matches
 * zero regions — that is NOT a breaker-worthy failure and is re-thrown
 * unchanged so the primary/fallback retry envelope doesn't bill a second
 * model for the same deterministic answer.
 */
export async function callSegmentation(
  input: SegmentationInput,
): Promise<SegmentationOutput> {
  const primaryModel = env.REPLICATE_SEGMENTATION_MODEL;
  const fallbackModel = env.FALAI_SEGMENTATION_MODEL;
  return runWithFallback<SegmentationOutput>({
    role: "segment",
    callPrimary: () => callSegmentationReplicate(primaryModel, input),
    callFallback: () => callSegmentationFalAI(fallbackModel, input),
    primaryModel,
    fallbackModel,
    // Domain signal — never a provider health issue. Don't pollute the
    // breaker and don't retry against the fallback for it.
    isTerminalError: (error) => error.name === "NoMaskDetectedError",
  });
}

/**
 * Run mask-guided object removal. Replicate LaMa primary, fal.ai
 * object-removal fallback. Same breaker semantics as `callDesignGeneration`.
 */
export async function callRemoval(
  input: RemovalInput,
): Promise<RemovalOutput> {
  const primaryModel = env.REPLICATE_REMOVAL_MODEL;
  const fallbackModel = env.FALAI_REMOVAL_MODEL;
  return runWithFallback<RemovalOutput>({
    role: "remove",
    callPrimary: () => callRemovalReplicate(primaryModel, input),
    callFallback: () => callRemovalFalAI(fallbackModel, input),
    primaryModel,
    fallbackModel,
  });
}

/**
 * Run prompt-driven inpainting. Replicate Flux Fill primary, fal.ai
 * `flux-pro/v1/fill` fallback.
 */
export async function callInpaint(
  input: InpaintInput,
): Promise<InpaintOutput> {
  const primaryModel = env.REPLICATE_INPAINT_MODEL;
  const fallbackModel = env.FALAI_INPAINT_MODEL;
  return runWithFallback<InpaintOutput>({
    role: "inpaint",
    callPrimary: () => callInpaintReplicate(primaryModel, input),
    callFallback: () => callInpaintFalAI(fallbackModel, input),
    primaryModel,
    fallbackModel,
  });
}

// ─── Shared primary/fallback envelope for pipeline roles ───────────────────
//
// Mirrors the retry + circuit-breaker + probe shape from
// `callDesignGeneration` for the segment/remove/inpaint roles. Kept as a
// separate function (not a merged abstraction) so the edit-path semantics —
// which also forward the reference-image/aspect-ratio fields via
// GenerationInput — stay decoupled from the three pipeline roles that share
// a simpler input shape.

interface FallbackConfig<T> {
  role: "segment" | "remove" | "inpaint";
  callPrimary: () => Promise<T>;
  callFallback: () => Promise<T>;
  primaryModel: string;
  fallbackModel: string;
  /**
   * Predicate for errors that should short-circuit the envelope — skip
   * retry, skip fallback, and skip breaker recording. Used for domain
   * signals like `NoMaskDetectedError` that are not provider health issues.
   */
  isTerminalError?: (error: Error) => boolean;
}

async function runWithFallback<T>(config: FallbackConfig<T>): Promise<T> {
  const {
    role,
    callPrimary,
    callFallback,
    primaryModel,
    fallbackModel,
    isTerminalError,
  } = config;
  const breaker = designCircuitBreaker;
  const fallbackProvider = breaker.fallbackProvider;

  async function callFallbackWithRetry(
    reason: "circuit_open" | "primary_failed",
  ): Promise<T> {
    try {
      const result = await withRetry(callFallback, {
        maxRetries: 1,
        delayMs: 1000,
        isRetryable: isTerminalError
          ? (error) => !isTerminalError(error)
          : undefined,
        onRetry: (error, attempt) => {
          logger.warn(
            {
              event: "provider.retry",
              provider: fallbackProvider,
              role,
              error: error.message,
              attempt,
            },
            `${fallbackProvider} ${role} fallback call failed, retrying`,
          );
        },
      });
      breaker.record(true);
      logger.info(
        {
          event: "provider.generation",
          provider: fallbackProvider,
          role,
          model: fallbackModel,
          fallbackFired: true,
          fallbackReason: reason,
        },
        `${role} served from fallback provider`,
      );
      return result;
    } catch (error) {
      if (
        isTerminalError &&
        error instanceof Error &&
        isTerminalError(error)
      ) {
        throw error;
      }
      breaker.record(false);
      throw error;
    }
  }

  if (breaker.shouldUseFallback()) {
    logger.info(
      {
        event: "provider.circuit_open",
        provider: fallbackProvider,
        role,
        breaker: breaker.name,
      },
      `Circuit open — routing ${role} to ${fallbackProvider} fallback`,
    );

    // Fire-and-forget probe. Shares the single-breaker probe cadence via the
    // `lastProbeTime` map, so multiple roles firing in parallel don't each
    // issue their own probe.
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

  try {
    const result = await withRetry(callPrimary, {
      maxRetries: 1,
      delayMs: 1000,
      isRetryable: isTerminalError
        ? (error) => !isTerminalError(error)
        : undefined,
      onRetry: (error, attempt) => {
        logger.warn(
          {
            event: "provider.retry",
            provider: "replicate",
            role,
            error: error.message,
            attempt,
          },
          `replicate ${role} call failed, retrying`,
        );
      },
    });
    breaker.record(true);
    logger.info(
      {
        event: "provider.generation",
        provider: "replicate",
        role,
        model: primaryModel,
        fallbackFired: false,
      },
      `${role} served from primary provider`,
    );
    return result;
  } catch (error) {
    if (
      isTerminalError &&
      error instanceof Error &&
      isTerminalError(error)
    ) {
      throw error;
    }
    breaker.record(false);

    logger.error(
      {
        event: "provider.fallback",
        provider: fallbackProvider,
        role,
        error: error instanceof Error ? error.message : String(error),
      },
      `replicate ${role} failed after retries, trying ${fallbackProvider} fallback`,
    );

    return callFallbackWithRetry("primary_failed");
  }
}
