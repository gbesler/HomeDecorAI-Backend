import { callDesignGeneration, NoMaskDetectedError } from "../lib/ai-providers";
import { TOOL_TYPES, type ToolTypeConfig } from "../lib/tool-types.js";
import {
  claimProcessing,
  getGenerationById,
  markFailed,
  recordAiResult,
  recordNotification,
  recordSegmentationCheckpoint,
  recordStorageResult,
} from "../lib/firestore.js";
import {
  runRemoval,
  runSegmentationAndPersistMask,
} from "../lib/generation/segment-remove.js";
import { runPromptInpaint } from "../lib/generation/prompt-inpaint.js";
import type {
  GenerationDoc,
  GenerationErrorCode,
  ProcessGenerationInput,
  ProcessGenerationResult,
  SupportedLanguage,
} from "../lib/generation/types.js";
import { persistGenerationImage, StorageUploadError } from "../lib/storage/s3-upload.js";
import { CognitoCredentialMintError } from "../lib/storage/cognito-credentials.js";
import { sendGenerationNotification } from "../lib/notifications/fcm.js";
import { logger } from "../lib/logger.js";
import type { NotificationKind } from "../lib/notifications/i18n.js";

export type { ProcessGenerationInput, ProcessGenerationResult };

/**
 * Orchestrates the async generation pipeline behind the Cloud Tasks worker.
 *
 * Design invariant: every stage writes its own idempotency checkpoint to
 * Firestore before returning. A Cloud Tasks retry observing a populated
 * checkpoint skips that stage, so e.g. AI generation runs at most once per
 * generationId even under arbitrary retry.
 *
 * Stages:
 *   1. claimProcessing transaction                   (status: queued → processing)
 *   2. buildPrompt + AI generation + recordAiResult  (aiCompletedAt)
 *   3. download + S3 upload + recordStorageResult    (storageCompletedAt + status: completed)
 *   4. FCM push + recordNotification                  (notifiedAt)
 *
 * Return semantics: `processGeneration` returns a result object whose `action`
 * field tells the HTTP handler how to respond to Cloud Tasks:
 *   - `ok`    → 200 (terminal state reached or best-effort FCM completed)
 *   - `retry` → 500 (S3 failed in a way that warrants a retry — AI result preserved)
 *
 * The handler never throws on AI failures or FCM failures: those are recorded
 * as terminal on the doc and Cloud Tasks is told "done" so retry does not burn
 * budget.
 */

const MAX_RETRY_COUNT = 3;

/**
 * Minimum perceived "loading" window on the iOS client, in milliseconds. The
 * client listens on the Firestore doc and drops its spinner as soon as
 * `status` flips to `completed`, so we hold the transition here for a random
 * span in this range even when upstream providers return in a few seconds.
 * The delay only applies to the happy path — failures surface immediately.
 */
const MIN_LOADING_WINDOW_MS = 30_000;
const MAX_LOADING_WINDOW_MS = 60_000;

export async function processGeneration(
  input: ProcessGenerationInput,
): Promise<ProcessGenerationResult> {
  const { generationId, retryCount, skipLoadingPad } = input;

  // Local fallback anchor for the loading-window pad. `claimProcessing`
  // writes a server timestamp to `processingStartedAt`, but on a fresh claim
  // the in-memory doc still reports it as null (the transaction snapshot was
  // read before the update). We only use this local value as the anchor when
  // the Firestore field is absent — retries see the original server timestamp
  // and correctly short-circuit the pad. Anchored at function entry so the
  // `elapsedMs` calculation inside `holdForMinimumLoadingWindow` accounts for
  // AI + S3 time and can short-circuit the pad when upstream was slow.
  const invocationStartedAtMs = Date.now();

  // Step 1 — claim the record.
  const claim = await claimProcessing(generationId);

  if (claim.kind === "not_found") {
    logger.warn(
      { event: "processor.not_found", generationId },
      "Process invoked for missing generation — acking",
    );
    return { action: "ok", reason: "not_found" };
  }

  if (claim.kind === "already_completed") {
    logger.info(
      {
        event: "processor.already_terminal",
        generationId,
        status: claim.doc.status,
      },
      "Generation already terminal — acking",
    );
    return { action: "ok", reason: "already_terminal" };
  }

  // Retry exhaustion short-circuit. If Cloud Tasks is on its final attempt and
  // we're still not terminal, stop retry by marking failed and acking.
  if (retryCount >= MAX_RETRY_COUNT) {
    await markFailed(
      generationId,
      "RETRY_EXHAUSTED",
      `Cloud Tasks retry budget exhausted after ${retryCount} attempts`,
    ).catch((err) => logFirestoreError("markFailed", generationId, err));

    await bestEffortNotify(claim.doc, "failed");
    return { action: "ok", reason: "retry_exhausted" };
  }

  const doc = claim.doc;

  // Step 2 — AI generation (skipped if already checkpointed).
  let aiOutputUrl: string | null = doc.tempOutputUrl;
  if (!doc.aiCompletedAt) {
    const aiResult = await runAiGeneration(doc);
    if (aiResult.kind === "failed") {
      await markFailed(generationId, aiResult.code, aiResult.message).catch(
        (err) => logFirestoreError("markFailed", generationId, err),
      );
      await bestEffortNotify(doc, "failed");
      return { action: "ok", reason: "ai_failed" };
    }
    aiOutputUrl = aiResult.tempOutputUrl;
  } else {
    logger.info(
      { event: "processor.ai.skip", generationId },
      "AI stage already checkpointed — skipping",
    );
  }

  if (!aiOutputUrl) {
    // Defensive: doc.aiCompletedAt was set but tempOutputUrl is missing. This
    // should be impossible; treat as terminal failure so we don't loop.
    await markFailed(
      generationId,
      "AI_PROVIDER_FAILED",
      "AI checkpoint set without tempOutputUrl",
    ).catch((err) => logFirestoreError("markFailed", generationId, err));
    await bestEffortNotify(doc, "failed");
    return { action: "ok", reason: "missing_temp_url" };
  }

  // Step 3 — S3 upload (skipped if already checkpointed).
  if (!doc.storageCompletedAt) {
    try {
      const persisted = await persistGenerationImage({
        userId: doc.userId,
        generationId,
        sourceUrl: aiOutputUrl,
      });

      // Hold the `completed` transition so the iOS spinner stays visible for
      // a random 30–60s window even when AI + S3 returned quickly. Anchored
      // on `processingStartedAt` when available (retry path) so the pad is
      // not re-applied on each attempt. Sync HTTP path opts out — the client
      // is waiting on the response, not a Firestore listener.
      if (!skipLoadingPad) {
        await holdForMinimumLoadingWindow(
          generationId,
          doc.processingStartedAt,
          invocationStartedAtMs,
        );
      }

      await recordStorageResult({
        generationId,
        outputImageUrl: persisted.outputImageUrl,
        outputImageCDNUrl: persisted.outputImageCDNUrl,
      });
    } catch (err) {
      if (err instanceof StorageUploadError) {
        // Input-shaped error (allowlist, size) — terminal, no retry benefit.
        logger.error(
          {
            event: "processor.storage.permanent_failure",
            generationId,
            error: err.message,
          },
          "Storage upload refused — marking failed",
        );
        await markFailed(generationId, "STORAGE_FAILED", err.message).catch(
          (e) => logFirestoreError("markFailed", generationId, e),
        );
        await bestEffortNotify(doc, "failed");
        return { action: "ok", reason: "storage_refused" };
      }

      if (err instanceof CognitoCredentialMintError) {
        // Credential mint failures are almost always config-shaped (pool
        // missing unauth identities, IAM policy on the wrong role, wrong
        // pool ID). Retrying won't fix them; surface fast as STORAGE_FAILED
        // so operators see the issue on the first attempt instead of three
        // retries later.
        logger.error(
          {
            event: "processor.storage.cognito_mint_failure",
            generationId,
            error: err.message,
          },
          "Cognito credential mint failed — marking failed (config issue, retry won't help)",
        );
        await markFailed(generationId, "STORAGE_FAILED", err.message).catch(
          (e) => logFirestoreError("markFailed", generationId, e),
        );
        await bestEffortNotify(doc, "failed");
        return { action: "ok", reason: "cognito_mint_failed" };
      }

      // Transient error (network, S3 5xx) — throw to trigger Cloud Tasks retry.
      // Crucially the AI result is already checkpointed, so the retry skips the
      // expensive AI call.
      logger.error(
        {
          event: "processor.storage.transient_failure",
          generationId,
          retryCount,
          error: err instanceof Error ? err.message : String(err),
        },
        "Storage upload failed transiently — requesting Cloud Tasks retry",
      );
      return { action: "retry", reason: "storage_transient" };
    }
  } else {
    logger.info(
      { event: "processor.storage.skip", generationId },
      "Storage stage already checkpointed — skipping",
    );
  }

  // Step 4 — FCM push (best-effort, never blocks ack).
  if (!doc.notifiedAt) {
    const completedDoc = await getGenerationById(generationId);
    if (completedDoc) {
      await bestEffortNotify(completedDoc, "completed");
    }
  }

  return { action: "ok", reason: "completed" };
}

// ─── internal helpers ──────────────────────────────────────────────────────

type AiRunResult =
  | { kind: "ok"; tempOutputUrl: string }
  | { kind: "failed"; code: GenerationErrorCode; message: string };

async function runAiGeneration(doc: GenerationDoc): Promise<AiRunResult> {
  const { id: generationId, userId, toolType, inputImageUrl } = doc;

  // Registry lookup — every tool plugs in here.
  // Cast to a permissive `Record<string, unknown>` TParams so the
  // `imageUrlFields: keyof TParams` constraint widens to `string` here;
  // the per-tool config still enforces field-name correctness at registration.
  const tool = TOOL_TYPES[toolType as keyof typeof TOOL_TYPES] as unknown as
    | ToolTypeConfig<Record<string, unknown>>
    | undefined;
  if (!tool) {
    return {
      kind: "failed",
      code: "VALIDATION_FAILED",
      message: `Unknown toolType on queued record: ${toolType}`,
    };
  }

  // Recover validated params from either the new `toolParams` blob (standard
  // path) or the legacy top-level roomType/designStyle columns (in-flight
  // interior docs created before the registry refactor). The cast widens
  // the registry's narrow TParams (now `Record<string, unknown>`) so the
  // parsed params object is also typed as a record without losing field
  // information at call sites — buildPrompt and the imageUrlFields lookup
  // both index by string.
  let params: Record<string, unknown>;
  try {
    if (doc.toolParams) {
      params = tool.fromToolParams(doc.toolParams);
    } else if (doc.roomType && doc.designStyle) {
      // Legacy interior fallback — only valid for interiorDesign.
      params = tool.fromToolParams({
        imageUrl: doc.inputImageUrl,
        roomType: doc.roomType,
        designStyle: doc.designStyle,
      });
    } else {
      return {
        kind: "failed",
        code: "VALIDATION_FAILED",
        message:
          "Missing toolParams and legacy roomType/designStyle on queued record",
      };
    }
  } catch (err) {
    return {
      kind: "failed",
      code: "VALIDATION_FAILED",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let promptResult;
  try {
    promptResult = tool.buildPrompt(params);
  } catch (err) {
    return {
      kind: "failed",
      code: "VALIDATION_FAILED",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  logger.info(
    {
      event: "processor.ai.start",
      generationId,
      userId,
      toolType,
      toolParams: doc.toolParams,
      actionMode: promptResult.actionMode,
      guidanceBand: promptResult.guidanceBand,
      promptVersion: promptResult.promptVersion,
    },
    "Starting AI generation",
  );

  const mode = tool.mode ?? "edit";

  try {
    let tempOutputUrl: string;
    let provider: string;
    let durationMs: number;

    if (mode === "segment-remove") {
      // SAM 3 → persist mask → CHECKPOINT → LaMa. The builder must have
      // produced a `segmentTextPrompt` (concept noun phrase); guard at
      // runtime so a misconfigured tool surfaces as VALIDATION_FAILED.
      if (!promptResult.segmentTextPrompt) {
        return {
          kind: "failed",
          code: "VALIDATION_FAILED",
          message: `Tool ${toolType} is mode=segment-remove but buildPrompt returned no segmentTextPrompt`,
        };
      }

      // Idempotency invariant: SAM 3 runs at most once per generationId.
      // We either reuse the checkpointed mask URL or we run SAM now and
      // write the checkpoint BEFORE calling LaMa. If LaMa then fails, the
      // retry reuses the persisted mask rather than re-billing SAM.
      let maskUrl = doc.segmentationMaskUrl;
      if (!maskUrl) {
        const seg = await runSegmentationAndPersistMask({
          userId,
          generationId,
          imageUrl: inputImageUrl,
          textPrompt: promptResult.segmentTextPrompt,
        });
        maskUrl = seg.maskUrl;
        await recordSegmentationCheckpoint(generationId, maskUrl);
      } else {
        logger.info(
          { event: "segment_remove.mask_reused", generationId },
          "Reusing persisted segmentation mask from prior attempt",
        );
      }

      const result = await runRemoval({
        imageUrl: inputImageUrl,
        maskUrl,
      });
      tempOutputUrl = result.outputImageUrl;
      provider = result.provider;
      durationMs = result.durationMs;
    } else if (mode === "remove-only") {
      // Client-supplied mask URL lives in toolParams under `maskUrl`. The
      // controller already host-allowlisted it against the project's upload
      // origins (see design.controller.ts:validateClientUploadHost), so by
      // the time we reach here the URL is known-trusted.
      const maskUrl = params["maskUrl"];
      if (typeof maskUrl !== "string" || maskUrl.length === 0) {
        return {
          kind: "failed",
          code: "VALIDATION_FAILED",
          message: `Tool ${toolType} is mode=remove-only but toolParams.maskUrl is missing`,
        };
      }
      const result = await runRemoval({
        imageUrl: inputImageUrl,
        maskUrl,
      });
      tempOutputUrl = result.outputImageUrl;
      provider = result.provider;
      durationMs = result.durationMs;
    } else if (mode === "inpaint-with-prompt") {
      // Replace & Add Object: client mask + inspiration prompt → Flux Fill.
      // `maskUrl` is a client-uploaded artifact (host-allowlisted by the
      // controller, same SSRF guard as remove-only). The prompt comes from
      // `promptResult.prompt` — builder is pass-through over the iOS
      // inspiration library's authored per-item string, so an empty prompt
      // means a misconfigured builder, not a user input gap.
      const maskUrl = params["maskUrl"];
      if (typeof maskUrl !== "string" || maskUrl.length === 0) {
        return {
          kind: "failed",
          code: "VALIDATION_FAILED",
          message: `Tool ${toolType} is mode=inpaint-with-prompt but toolParams.maskUrl is missing`,
        };
      }
      if (!promptResult.prompt) {
        return {
          kind: "failed",
          code: "VALIDATION_FAILED",
          message: `Tool ${toolType} is mode=inpaint-with-prompt but buildPrompt returned empty prompt`,
        };
      }
      const result = await runPromptInpaint({
        imageUrl: inputImageUrl,
        maskUrl,
        prompt: promptResult.prompt,
        guidanceScale: promptResult.guidanceScale,
      });
      tempOutputUrl = result.outputImageUrl;
      provider = result.provider;
      durationMs = result.durationMs;
    } else {
      // Forward a secondary image URL to the provider only when the tool's
      // contract declares one — as a mandatory second field in `imageUrlFields`
      // (reference-style) OR as an optional `referenceImageUrl` in
      // `optionalImageUrlFields` (paint-walls customStyle). Reading from the
      // registry (rather than a hardcoded key) means:
      //   - single-image tools (interior/exterior/garden) skip extraction
      //     entirely, so a stray `referenceImageUrl` field accidentally written
      //     to a non-multi-image doc cannot corrupt that tool's generation.
      //   - any future multi-image tool with a different field name works
      //     without touching this file — declaration-driven, not name-driven.
      // The value is read from the already-typed `params` (post-Zod parse) so
      // it inherits the body schema's URL validation.
      const secondaryField =
        tool.imageUrlFields[1] ?? tool.optionalImageUrlFields?.[0];
      const referenceImageUrl =
        secondaryField !== undefined
          ? (params[secondaryField] as string | undefined)
          : undefined;

      const result = await callDesignGeneration(tool.models, {
        prompt: promptResult.prompt,
        imageUrl: inputImageUrl,
        referenceImageUrl,
        guidanceScale: promptResult.guidanceScale,
      });
      tempOutputUrl = result.imageUrl;
      provider = result.provider;
      durationMs = result.durationMs;
    }

    await recordAiResult({
      generationId,
      tempOutputUrl,
      provider,
      prompt: promptResult.prompt,
      actionMode: promptResult.actionMode,
      guidanceBand: promptResult.guidanceBand,
      promptVersion: promptResult.promptVersion,
      durationMs,
    });

    logger.info(
      {
        event: "processor.ai.ok",
        generationId,
        provider,
        mode,
        durationMs,
      },
      "AI generation completed",
    );

    return { kind: "ok", tempOutputUrl };
  } catch (err) {
    // Grounded-SAM matched zero regions — treat as terminal validation
    // failure with a domain-specific error code rather than a provider
    // outage. Surfaces to the user as "your room already looks clean".
    if (err instanceof NoMaskDetectedError) {
      logger.info(
        { event: "processor.ai.no_mask_detected", generationId, mode },
        "Segmentation returned no mask — marking failed as validation",
      );
      return {
        kind: "failed",
        code: "VALIDATION_FAILED",
        message: "Segmentation returned no clutter matches for this image",
      };
    }

    // Mask-persist errors happen INSIDE runSegmentationAndPersistMask (S3
    // PutObject / Cognito mint). They are storage-shaped, not AI-shaped —
    // classify them as STORAGE_FAILED so operator dashboards and runbooks
    // point at the right system. Terminal (no retry) because both failure
    // modes are config-shaped and retry won't help.
    if (err instanceof StorageUploadError) {
      logger.error(
        {
          event: "processor.ai.mask_storage_failure",
          generationId,
          mode,
          error: err.message,
        },
        "Mask persist failed — marking failed as storage",
      );
      return { kind: "failed", code: "STORAGE_FAILED", message: err.message };
    }
    if (err instanceof CognitoCredentialMintError) {
      logger.error(
        {
          event: "processor.ai.cognito_mint_failure_during_mask",
          generationId,
          mode,
          error: err.message,
        },
        "Cognito credential mint failed during mask persist — marking failed as storage",
      );
      return { kind: "failed", code: "STORAGE_FAILED", message: err.message };
    }

    const message = err instanceof Error ? err.message : String(err);
    const code: GenerationErrorCode = /timeout/i.test(message)
      ? "AI_TIMEOUT"
      : "AI_PROVIDER_FAILED";

    logger.error(
      {
        event: "processor.ai.failed",
        generationId,
        code,
        mode,
        error: message,
      },
      "AI generation failed",
    );

    return { kind: "failed", code, message };
  }
}

async function bestEffortNotify(
  doc: GenerationDoc,
  kind: NotificationKind,
): Promise<void> {
  const language: SupportedLanguage = doc.language ?? "en";
  const result = await sendGenerationNotification({
    userId: doc.userId,
    generationId: doc.id,
    kind,
    language,
  });

  // Only stamp notifiedAt when at least one push was accepted by FCM. If the
  // user has zero tokens or all tokens failed, leave notifiedAt null so a
  // future re-processing attempt (e.g. admin-triggered) can try again.
  if (result && result.sent > 0) {
    await recordNotification(doc.id).catch((err) =>
      logFirestoreError("recordNotification", doc.id, err),
    );
  }
}

async function holdForMinimumLoadingWindow(
  generationId: string,
  processingStartedAt: GenerationDoc["processingStartedAt"],
  invocationStartedAtMs: number,
): Promise<void> {
  const anchorMs = processingStartedAt
    ? processingStartedAt.toMillis()
    : invocationStartedAtMs;
  const targetMs =
    MIN_LOADING_WINDOW_MS +
    Math.floor(
      Math.random() * (MAX_LOADING_WINDOW_MS - MIN_LOADING_WINDOW_MS + 1),
    );
  const elapsedMs = Date.now() - anchorMs;
  const remainingMs = targetMs - elapsedMs;

  logger.info(
    {
      event: "processor.loading_pad",
      generationId,
      anchor: processingStartedAt ? "firestore" : "local",
      elapsedMs,
      targetMs,
      remainingMs: Math.max(0, remainingMs),
    },
    "Evaluating loading-window pad before marking completed",
  );

  if (remainingMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }
}

function logFirestoreError(op: string, generationId: string, err: unknown) {
  logger.error(
    {
      event: "processor.firestore_error",
      op,
      generationId,
      error: err instanceof Error ? err.message : String(err),
    },
    "Firestore write failed inside processor — state may be inconsistent",
  );
}
