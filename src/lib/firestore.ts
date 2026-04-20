import admin from "firebase-admin";
import type {
  ClaimProcessingResult,
  CreateQueuedGenerationInput,
  GenerationDoc,
  GenerationErrorCode,
  GenerationStatus,
  RecordAiResultInput,
  SupportedLanguage,
} from "./generation/types.js";

// Re-export the domain types so existing `from "./firestore.js"` imports keep
// working during the transition. New code should prefer importing from
// `./generation/types.js` directly.
export type {
  ClaimProcessingResult,
  CreateQueuedGenerationInput,
  GenerationDoc,
  GenerationErrorCode,
  GenerationStatus,
  RecordAiResultInput,
  SupportedLanguage,
};

function getFirestore(): admin.firestore.Firestore {
  return admin.firestore();
}

const GENERATIONS_COLLECTION = "generations";

/**
 * Maximum byte size for the persisted `prompt` field in Firestore. This is
 * a defensive cap applied to the Firestore copy ONLY — the model call uses
 * the full untruncated prompt. Protects against Firestore indexed-string
 * limits (1500 bytes) and document size limits (1MB). See R26.
 */
export const MAX_FIRESTORE_PROMPT_BYTES = 4000;
const TRUNCATION_MARKER = "\n...[truncated]";

/**
 * Truncate a prompt string to fit Firestore byte limits, appending a clear
 * marker when truncation occurs. Byte-aware so multi-byte UTF-8 sequences
 * are not split mid-character.
 */
export function truncatePromptForPersistence(prompt: string): string {
  const byteLength = Buffer.byteLength(prompt, "utf8");
  if (byteLength <= MAX_FIRESTORE_PROMPT_BYTES) {
    return prompt;
  }

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const targetBytes = MAX_FIRESTORE_PROMPT_BYTES - markerBytes;

  // Slice by byte, then decode back to string. If the slice lands mid-character,
  // Node's Buffer.toString will replace the partial with U+FFFD; strip any
  // trailing replacement character before appending the marker.
  const buf = Buffer.from(prompt, "utf8").subarray(0, targetBytes);
  let truncated = buf.toString("utf8");
  while (truncated.length > 0 && truncated.charCodeAt(truncated.length - 1) === 0xfffd) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + TRUNCATION_MARKER;
}

export async function getGenerationsByUser(
  userId: string,
  limit = 50,
): Promise<GenerationDoc[]> {
  const db = getFirestore();
  const snapshot = await db
    .collection(GENERATIONS_COLLECTION)
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  // Explicit mapping + undefined → null normalization for the R27 fields.
  // Firestore returns `undefined` for absent fields (not null), which would
  // create a silent type lie against `string | null`. Older documents that
  // predate R27 lack these fields entirely.
  return snapshot.docs.map((doc) => mapDocToGeneration(doc));
}

// ─── Async Pipeline Helpers (checkpoint-based idempotency) ──────────────────

/**
 * Write a new `queued` generation record. This is the first step of the async
 * pipeline — it runs inside the enqueue HTTP handler, before Cloud Tasks
 * submission. If the task enqueue fails, the caller uses {@link markEnqueueFailed}
 * to mark the same record as failed so no document is orphaned.
 */
export async function createQueuedGeneration(
  input: CreateQueuedGenerationInput,
): Promise<void> {
  const db = getFirestore();
  const ref = db.collection(GENERATIONS_COLLECTION).doc(input.generationId);

  const doc: Omit<GenerationDoc, "id" | "createdAt"> & {
    createdAt: admin.firestore.FieldValue;
  } = {
    userId: input.userId,
    toolType: input.toolType,
    roomType: input.roomType,
    designStyle: input.designStyle,
    toolParams: input.toolParams,
    inputImageUrl: input.inputImageUrl,
    outputImageUrl: null,
    outputImageCDNUrl: null,
    prompt: "", // processor fills this when it builds the prompt
    actionMode: null,
    guidanceBand: null,
    promptVersion: null,
    provider: "pending",
    status: "queued",
    errorMessage: null,
    errorCode: null,
    durationMs: null,
    language: input.language,
    tempOutputUrl: null,
    queuedAt: admin.firestore.FieldValue.serverTimestamp() as unknown as admin.firestore.Timestamp,
    processingStartedAt: null,
    aiCompletedAt: null,
    segmentationMaskUrl: null,
    storageCompletedAt: null,
    completedAt: null,
    notifiedAt: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await ref.set(doc);
}

/**
 * Mark an enqueue failure when Cloud Tasks submission fails after the Firestore
 * record was already created. Terminal state — the iOS listener will see this
 * and surface an error to the user immediately.
 */
export async function markEnqueueFailed(
  generationId: string,
  errorMessage: string,
): Promise<void> {
  const db = getFirestore();
  await db.collection(GENERATIONS_COLLECTION).doc(generationId).update({
    status: "failed",
    errorCode: "ENQUEUE_FAILED" satisfies GenerationErrorCode,
    errorMessage: errorMessage.slice(0, 500),
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Transaction: move a `queued` (or legacy `pending`) record to `processing`.
 *
 * Behaviour:
 * - `not_found`: document does not exist — caller returns 200 (idempotent no-op)
 * - `claimed`: fresh claim, status moved to `processing`, caller runs the full pipeline
 * - `resume`: document was already `processing` (retry scenario) — caller resumes from
 *   the first un-checkpointed stage
 * - `already_completed`: terminal state reached on a previous attempt — caller returns 200
 */
export async function claimProcessing(
  generationId: string,
): Promise<ClaimProcessingResult> {
  const db = getFirestore();
  const ref = db.collection(GENERATIONS_COLLECTION).doc(generationId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { kind: "not_found" } satisfies ClaimProcessingResult;
    }

    const doc = mapDocToGeneration(snap);

    if (doc.status === "completed" || doc.status === "failed") {
      return { kind: "already_completed", doc } satisfies ClaimProcessingResult;
    }

    if (doc.status === "processing") {
      // Cloud Tasks retried while a previous attempt was mid-flight (or crashed).
      // Return resume — caller inspects checkpoints to decide what to re-run.
      return { kind: "resume", doc } satisfies ClaimProcessingResult;
    }

    // queued | pending → processing
    tx.update(ref, {
      status: "processing",
      processingStartedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      kind: "claimed",
      doc: {
        ...doc,
        status: "processing",
      },
    } satisfies ClaimProcessingResult;
  });
}

/**
 * Sub-checkpoint inside the AI stage for the segment-remove pipeline.
 * Written after SAM succeeds and the mask has been persisted to S3, BEFORE
 * the LaMa call. If the removal step fails and Cloud Tasks retries, the
 * processor sees this field and skips SAM on the next attempt.
 */
export async function recordSegmentationCheckpoint(
  generationId: string,
  segmentationMaskUrl: string,
): Promise<void> {
  const db = getFirestore();
  await db.collection(GENERATIONS_COLLECTION).doc(generationId).update({
    segmentationMaskUrl,
  });
}

/** Checkpoint: AI call succeeded. Guarantees the processor can resume from S3 upload. */
export async function recordAiResult(input: RecordAiResultInput): Promise<void> {
  const db = getFirestore();
  await db
    .collection(GENERATIONS_COLLECTION)
    .doc(input.generationId)
    .update({
      tempOutputUrl: input.tempOutputUrl,
      provider: input.provider,
      prompt: truncatePromptForPersistence(input.prompt),
      actionMode: input.actionMode,
      guidanceBand: input.guidanceBand,
      promptVersion: input.promptVersion,
      durationMs: input.durationMs,
      aiCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

/**
 * Checkpoint: S3 upload succeeded. Writes the canonical `outputImageUrl`
 * (native S3) and `outputImageCDNUrl` (CloudFront-fronted; null when
 * CloudFront is not configured), marks the record `completed`, and stamps
 * `completedAt`.
 */
export async function recordStorageResult(input: {
  generationId: string;
  outputImageUrl: string;
  outputImageCDNUrl: string | null;
}): Promise<void> {
  const db = getFirestore();
  await db.collection(GENERATIONS_COLLECTION).doc(input.generationId).update({
    outputImageUrl: input.outputImageUrl,
    outputImageCDNUrl: input.outputImageCDNUrl,
    status: "completed",
    storageCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/** Checkpoint: FCM push was dispatched successfully. */
export async function recordNotification(generationId: string): Promise<void> {
  const db = getFirestore();
  await db.collection(GENERATIONS_COLLECTION).doc(generationId).update({
    notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Terminal failure. Writes errorCode + errorMessage, flips status to `failed`,
 * stamps `completedAt`. Used by the processor for AI/timeout/retry-exhausted
 * failures that should not be retried by Cloud Tasks.
 */
export async function markFailed(
  generationId: string,
  errorCode: GenerationErrorCode,
  errorMessage: string,
): Promise<void> {
  const db = getFirestore();
  await db.collection(GENERATIONS_COLLECTION).doc(generationId).update({
    status: "failed",
    errorCode,
    errorMessage: errorMessage.slice(0, 500),
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Retry a terminally-failed generation. Transactionally flips `failed →
 * queued` on the SAME document (preserves `generationId` so the iOS
 * Firestore listener updates the open detail surface in-place) and clears
 * every checkpoint field written by prior attempts (error + stage
 * timestamps + provider id + temp + segmentation mask) so the processor
 * starts fresh. Preserves `toolType`, `toolParams`, `inputImageUrl`, and
 * `language` — same job, new run.
 *
 * Result kinds:
 *  - `reset`:          doc was `failed`, fields cleared, status is now `queued`.
 *  - `already_live`:   doc is `queued` or `processing` — do not re-enqueue
 *                      (Cloud Tasks is already in flight).
 *  - `already_done`:   doc is `completed` — nothing to retry.
 *  - `not_found`:      doc does not exist (or was deleted).
 *  - `forbidden`:      doc belongs to a different userId.
 */
export type RetryGenerationResult =
  | { kind: "reset" }
  | { kind: "already_live"; status: "queued" | "processing" }
  | { kind: "already_done" }
  | { kind: "not_found" }
  | { kind: "forbidden" };

export async function retryFailedGeneration(
  generationId: string,
  userId: string,
): Promise<RetryGenerationResult> {
  const db = getFirestore();
  const ref = db.collection(GENERATIONS_COLLECTION).doc(generationId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { kind: "not_found" } satisfies RetryGenerationResult;
    }
    const doc = mapDocToGeneration(snap);
    if (doc.userId !== userId) {
      return { kind: "forbidden" } satisfies RetryGenerationResult;
    }
    if (doc.status === "completed") {
      return { kind: "already_done" } satisfies RetryGenerationResult;
    }
    if (doc.status === "queued" || doc.status === "processing") {
      return {
        kind: "already_live",
        status: doc.status,
      } satisfies RetryGenerationResult;
    }

    // status === "failed" (or legacy "pending") — reset to queued. Clear
    // every downstream checkpoint so the processor can't accidentally
    // short-circuit on a stale value from the prior attempt. AI-stage
    // fields (prompt, actionMode, etc.) are reset too so a retry that
    // flips env-configured models picks up the fresh promptVersion /
    // provider metadata instead of keeping the failed run's slug. Output
    // URL fields are nulled defensively even though `markFailed` doesn't
    // set them — a partial write from a past schema can leave them
    // populated, and rendering a half-retried doc as "completed" via a
    // stale URL would be worse than a loading state.
    tx.update(ref, {
      status: "queued",
      errorCode: null,
      errorMessage: null,
      completedAt: null,
      processingStartedAt: null,
      aiCompletedAt: null,
      storageCompletedAt: null,
      notifiedAt: null,
      tempOutputUrl: null,
      outputImageUrl: null,
      outputImageCDNUrl: null,
      segmentationMaskUrl: null,
      durationMs: null,
      provider: "pending",
      prompt: "",
      actionMode: null,
      guidanceBand: null,
      promptVersion: null,
      queuedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { kind: "reset" } satisfies RetryGenerationResult;
  });
}

/**
 * Raw getter used by the processor after claimProcessing. Returns null for
 * missing documents. Callers should use {@link claimProcessing} as the primary
 * entry point; this helper is for the processor's re-entry paths.
 */
export async function getGenerationById(
  generationId: string,
): Promise<GenerationDoc | null> {
  const db = getFirestore();
  const snap = await db.collection(GENERATIONS_COLLECTION).doc(generationId).get();
  if (!snap.exists) return null;
  return mapDocToGeneration(snap);
}

/**
 * Map a Firestore DocumentSnapshot to a GenerationDoc, defaulting any
 * missing async-pipeline fields to null so legacy documents parse cleanly.
 */
function mapDocToGeneration(
  doc: admin.firestore.DocumentSnapshot,
): GenerationDoc {
  const data = doc.data() ?? {};
  return {
    id: doc.id,
    userId: data["userId"],
    toolType: data["toolType"],
    roomType: data["roomType"] ?? null,
    designStyle: data["designStyle"] ?? null,
    toolParams: (data["toolParams"] as Record<string, unknown> | undefined) ?? null,
    inputImageUrl: data["inputImageUrl"],
    outputImageUrl: data["outputImageUrl"] ?? null,
    outputImageCDNUrl: data["outputImageCDNUrl"] ?? null,
    prompt: data["prompt"],
    actionMode: data["actionMode"] ?? null,
    guidanceBand: data["guidanceBand"] ?? null,
    promptVersion: data["promptVersion"] ?? null,
    provider: data["provider"],
    status: data["status"],
    errorMessage: data["errorMessage"] ?? null,
    errorCode: (data["errorCode"] as GenerationErrorCode | undefined) ?? null,
    durationMs: data["durationMs"] ?? null,
    createdAt: data["createdAt"],
    language: (data["language"] as SupportedLanguage | undefined) ?? null,
    tempOutputUrl: data["tempOutputUrl"] ?? null,
    queuedAt: data["queuedAt"] ?? null,
    processingStartedAt: data["processingStartedAt"] ?? null,
    aiCompletedAt: data["aiCompletedAt"] ?? null,
    segmentationMaskUrl: data["segmentationMaskUrl"] ?? null,
    storageCompletedAt: data["storageCompletedAt"] ?? null,
    completedAt: data["completedAt"] ?? null,
    notifiedAt: data["notifiedAt"] ?? null,
  };
}
