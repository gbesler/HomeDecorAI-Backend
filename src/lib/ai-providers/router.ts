import { designCircuitBreaker } from "../circuit-breaker.js";
import { env } from "../env.js";
import { withRetry } from "../retry.js";
import { logger } from "../logger.js";
import {
  callBgRemoveReplicate,
  callInpaintRefineReplicate,
  callInpaintReplicate,
  callRemovalReplicate,
  callReplicate,
  callSegmentationReplicate,
} from "./replicate.js";
import {
  callBgRemoveFalAI,
  callFalAI,
  callInpaintFalAI,
  callInpaintRefineFalAI,
  callRemovalFalAI,
  callSegmentationFalAI,
} from "./falai.js";
import type {
  BgRemoveInput,
  BgRemoveOutput,
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
const PROBE_TIMEOUT_MS = 30_000;
const lastProbeTime = new Map<string, number>();

/**
 * Route an AI generation request through the circuit breaker.
 *
 * Replicate primary, fal.ai fallback. Every tool in the registry shares
 * this flow (interior, exterior, garden, reference-style, etc.), tracked
 * by the single `designCircuitBreaker` instance — same instance the
 * segment/remove/inpaint roles use, so a Replicate-wide outage trips
 * the breaker for everyone.
 *
 * Thin wrapper over `runWithFallback<GenerationOutput>` (defined below)
 * with `role: "edit"`. The shape of `GenerationInput` is fully
 * encapsulated by the `callPrimary`/`callFallback` thunks the wrapper
 * passes in, so there is no edit-path-specific behavior left to
 * preserve in a separate copy of the envelope. Behavioural diff vs
 * the previous standalone implementation: log payloads now include a
 * `role: "edit"` field — strict telemetry improvement.
 */
export async function callDesignGeneration(
  models: ToolModelConfig,
  input: GenerationInput,
): Promise<GenerationOutput> {
  return runWithFallback<GenerationOutput>({
    role: "edit",
    callPrimary: () => callReplicate(models.replicate, input),
    callFallback: () => callFalAI(models.falai, input),
    primaryModel: models.replicate,
    fallbackModel: models.falai,
  });
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

/**
 * Run background removal with **fal.ai as primary** and Replicate as
 * fallback — inverted relative to the other roles. The Replace & Add
 * Object v5.0 pipeline uses BiRefNet v2 on fal.ai as the primary
 * because fal hosts the lowest-cost cutout endpoint we found
 * (~$0.001/image) under the project's per-call cost ceiling.
 *
 * Note: this routes through `runWithFallback` with `falaiPrimary: true`
 * to invert primary/fallback without forking the breaker logic.
 */
export async function callBgRemove(
  input: BgRemoveInput,
): Promise<BgRemoveOutput> {
  const primaryModel = env.FALAI_BG_REMOVE_MODEL;
  const fallbackModel = env.REPLICATE_BG_REMOVE_MODEL;
  return runWithFallback<BgRemoveOutput>({
    role: "bg-remove",
    callPrimary: () => callBgRemoveFalAI(primaryModel, input),
    callFallback: () => callBgRemoveReplicate(fallbackModel, input),
    primaryModel,
    fallbackModel,
    falaiPrimary: true,
  });
}

/**
 * Run inpaint-refine (low-strength SDXL pass) with **fal.ai as primary**
 * and Replicate as fallback — inverted relative to most other roles
 * for the same cost-ceiling reason as callBgRemove. The refine pass is
 * the Stage 4 step in Replace & Add Object v5.0 (crop-composite-refine).
 */
export async function callInpaintRefine(
  input: InpaintInput,
): Promise<InpaintOutput> {
  const primaryModel = env.FALAI_INPAINT_REFINE_MODEL;
  const fallbackModel = env.REPLICATE_INPAINT_REFINE_MODEL;
  return runWithFallback<InpaintOutput>({
    role: "inpaint-refine",
    callPrimary: () => callInpaintRefineFalAI(primaryModel, input),
    callFallback: () => callInpaintRefineReplicate(fallbackModel, input),
    primaryModel,
    fallbackModel,
    falaiPrimary: true,
  });
}

// ─── Shared primary/fallback envelope ──────────────────────────────────────
//
// Single retry + circuit-breaker + probe envelope for every role:
// `edit` (callDesignGeneration), `segment`, `remove`, `inpaint`. The
// `GenerationInput` plumbing for edit calls is encapsulated by the
// caller's `callPrimary`/`callFallback` thunks, so this envelope stays
// agnostic to the per-role input shape.

interface FallbackConfig<T> {
  role:
    | "edit"
    | "segment"
    | "remove"
    | "inpaint"
    | "bg-remove"
    | "inpaint-refine";
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
  /**
   * When true, `callPrimary` targets fal.ai and `callFallback` targets
   * Replicate (inverted relative to the default). Used by Replace & Add
   * Object v5.0's `bg-remove` and `inpaint-refine` roles where fal.ai
   * hosts the lowest-cost endpoint under the project's per-call cost
   * ceiling. The circuit breaker still tracks Replicate health globally;
   * the inversion only flips which provider serves the first attempt.
   */
  falaiPrimary?: boolean;
}

async function runWithFallback<T>(config: FallbackConfig<T>): Promise<T> {
  const {
    role,
    callPrimary,
    callFallback,
    primaryModel,
    fallbackModel,
    isTerminalError,
    falaiPrimary,
  } = config;
  const breaker = designCircuitBreaker;
  // Provider identity for log payloads. Inverted when `falaiPrimary` is
  // set (Replace & Add Object v5.0's bg-remove and inpaint-refine roles).
  const primaryProvider = falaiPrimary ? "falai" : "replicate";
  const fallbackProvider = falaiPrimary ? "replicate" : breaker.fallbackProvider;

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
      // Same falaiPrimary carve-out as the primary path — the breaker
      // tracks Replicate health, so a fal.ai-primary call's fallback is
      // Replicate and its success/failure DOES feed the breaker
      // (because that IS Replicate health information).
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

  // Breaker shortcut applies only when Replicate is primary. With
  // `falaiPrimary`, "fallback" is Replicate — opening the breaker
  // because Replicate is degraded should NOT redirect to a degraded
  // path. Skip the shortcut and try fal.ai first regardless.
  if (!falaiPrimary && breaker.shouldUseFallback()) {
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
        .catch((err: unknown) => {
          clearTimeout(probeTimeout);
          // Domain signals (e.g. NoMaskDetectedError from a SAM probe firing
          // on a clean image) aren't provider failures — feeding them into
          // recordProbe(false) would spuriously re-OPEN the breaker and
          // block recovery even when Replicate is healthy. Mirrors the
          // isTerminalError guard on the primary/fallback error paths.
          if (
            isTerminalError &&
            err instanceof Error &&
            isTerminalError(err)
          ) {
            return;
          }
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
    // Only record into the (Replicate-tracking) circuit breaker when
    // Replicate is actually the primary provider for this call. With
    // falaiPrimary, success/failure here reflects fal.ai health and
    // should not feed back into the Replicate breaker.
    if (!falaiPrimary) breaker.record(true);
    logger.info(
      {
        event: "provider.generation",
        provider: primaryProvider,
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
    if (!falaiPrimary) breaker.record(false);

    logger.error(
      {
        event: "provider.fallback",
        provider: fallbackProvider,
        role,
        error: error instanceof Error ? error.message : String(error),
      },
      `${primaryProvider} ${role} failed after retries, trying ${fallbackProvider} fallback`,
    );

    return callFallbackWithRetry("primary_failed");
  }
}
