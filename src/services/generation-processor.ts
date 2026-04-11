import { callDesignGeneration } from "../lib/ai-providers";
import { TOOL_TYPES } from "../lib/tool-types.js";
import {
  claimProcessing,
  getGenerationById,
  markFailed,
  recordAiResult,
  recordNotification,
  recordStorageResult,
} from "../lib/firestore.js";
import type {
  GenerationDoc,
  GenerationErrorCode,
  ProcessGenerationInput,
  ProcessGenerationResult,
  SupportedLanguage,
} from "../lib/generation/types.js";
import { persistGenerationImage, StorageUploadError } from "../lib/storage/s3-upload.js";
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

/**
 * Minimum remaining lifetime, in seconds, the Firebase ID token must have
 * before the processor calls Cognito. If the token has less than this amount
 * left, we fail fast with TOKEN_EXPIRED rather than letting the Cognito call
 * almost-certainly fail mid-flight.
 *
 * 60 seconds is generous: the Cognito GetId + GetCredentialsForIdentity round
 * trip completes in well under a second, and one iOS retry loop costs no more
 * than a few seconds. Fail fast, let the client refresh, avoid wasted work.
 */
const TOKEN_MIN_REMAINING_SECONDS = 60;

/**
 * Decode the `exp` claim of a Firebase ID token without verifying it. We
 * trust the token at this point because the enqueue path already verified it
 * via `admin.auth().verifyIdToken` before the task was created. This helper
 * only reads the expiry to avoid round-tripping to Cognito when it's clearly
 * going to fail.
 *
 * Returns the remaining lifetime in seconds, or `null` if the token cannot
 * be decoded (malformed / unexpected shape).
 */
function getFirebaseTokenRemainingSeconds(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadJson = Buffer.from(parts[1]!, "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson) as { exp?: unknown };
    if (typeof payload.exp !== "number") return null;
    return payload.exp - Math.floor(Date.now() / 1000);
  } catch {
    return null;
  }
}

export async function processGeneration(
  input: ProcessGenerationInput,
): Promise<ProcessGenerationResult> {
  const { generationId, firebaseIdToken, retryCount } = input;

  // Local fallback anchor for the loading-window pad. `claimProcessing`
  // writes a server timestamp to `processingStartedAt`, but on a fresh claim
  // the in-memory doc still reports it as null (the transaction snapshot was
  // read before the update). We only use this local value as the anchor when
  // the Firestore field is absent — retries see the original server timestamp
  // and correctly short-circuit the pad.
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
    // Pre-flight: make sure the Firebase ID token still has enough lifetime
    // for the Cognito federation round trip. If it's too close to expiry
    // (or undecodable), fail fast with TOKEN_EXPIRED so the client re-enqueues
    // with a fresh token — cheaper and cleaner than letting Cognito 401.
    const remaining = getFirebaseTokenRemainingSeconds(firebaseIdToken);
    if (remaining === null || remaining < TOKEN_MIN_REMAINING_SECONDS) {
      logger.warn(
        {
          event: "processor.token_expired",
          generationId,
          remainingSeconds: remaining,
        },
        "Firebase token near or past expiry — marking failed for client retry",
      );
      await markFailed(
        generationId,
        "TOKEN_EXPIRED",
        "Firebase ID token expired before processor could federate to Cognito; retry with a fresh token",
      ).catch((err) => logFirestoreError("markFailed", generationId, err));
      await bestEffortNotify(doc, "failed");
      return { action: "ok", reason: "token_expired" };
    }

    try {
      const persisted = await persistGenerationImage({
        userId: doc.userId,
        generationId,
        sourceUrl: aiOutputUrl,
        firebaseIdToken,
      });

      // Hold the `completed` transition so the iOS spinner stays visible for
      // a random 30–60s window even when AI + S3 returned quickly. Anchored
      // on `processingStartedAt` when available (retry path) so the pad is
      // not re-applied on each attempt.
      await holdForMinimumLoadingWindow(
        generationId,
        doc.processingStartedAt,
        invocationStartedAtMs,
      );

      await recordStorageResult({
        generationId,
        outputImageUrl: persisted.outputImageUrl,
        cognitoIdentityId: persisted.cognitoIdentityId,
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
  const { id: generationId, userId, roomType, designStyle, inputImageUrl } = doc;

  if (!roomType || !designStyle) {
    return {
      kind: "failed",
      code: "VALIDATION_FAILED",
      message: "Missing roomType or designStyle on queued record",
    };
  }

  const toolConfig = TOOL_TYPES.interiorDesign;
  let promptResult;
  try {
    promptResult = toolConfig.buildPrompt({ roomType, designStyle });
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
      roomType,
      designStyle,
      actionMode: promptResult.actionMode,
      guidanceBand: promptResult.guidanceBand,
      promptVersion: promptResult.promptVersion,
    },
    "Starting AI generation",
  );

  try {
    const result = await callDesignGeneration(toolConfig.models, {
      prompt: promptResult.prompt,
      imageUrl: inputImageUrl,
      guidanceScale: promptResult.guidanceScale,
    });

    await recordAiResult({
      generationId,
      tempOutputUrl: result.imageUrl,
      provider: result.provider,
      prompt: promptResult.prompt,
      actionMode: promptResult.actionMode,
      guidanceBand: promptResult.guidanceBand,
      promptVersion: promptResult.promptVersion,
      durationMs: result.durationMs,
    });

    logger.info(
      {
        event: "processor.ai.ok",
        generationId,
        provider: result.provider,
        durationMs: result.durationMs,
      },
      "AI generation completed",
    );

    return { kind: "ok", tempOutputUrl: result.imageUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code: GenerationErrorCode = /timeout/i.test(message)
      ? "AI_TIMEOUT"
      : "AI_PROVIDER_FAILED";

    logger.error(
      {
        event: "processor.ai.failed",
        generationId,
        code,
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
