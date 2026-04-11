import type admin from "firebase-admin";

/**
 * Generation subsystem — domain types.
 *
 * These types describe the shape of the generation lifecycle — queued by the
 * enqueue endpoint, advanced by the Cloud Tasks processor, observed by the
 * iOS listener. They deliberately live here, not next to the Firestore
 * adapter, so the domain stays decoupled from the storage layer.
 *
 * The Firestore adapter (`src/lib/firestore.ts`) imports from this module
 * and provides the data access functions. Services and controllers should
 * import from this file directly rather than leaking through `firestore.ts`.
 */

// ─── Status, language, error codes ──────────────────────────────────────────

/**
 * Generation lifecycle status.
 *
 * `pending` is preserved for backwards compatibility with documents created
 * by the legacy synchronous flow. New documents are created as `queued` and
 * advance through `processing` → `completed`/`failed`.
 */
export type GenerationStatus =
  | "pending"
  | "queued"
  | "processing"
  | "completed"
  | "failed";

/** Supported UI languages for push notification localization (R10). */
export type SupportedLanguage = "tr" | "en";

/** Typed error codes surfaced to iOS so the client can render differentiated failure UI. */
export type GenerationErrorCode =
  | "ENQUEUE_FAILED"
  | "VALIDATION_FAILED"
  | "AI_TIMEOUT"
  | "AI_PROVIDER_FAILED"
  | "STORAGE_FAILED"
  | "TOKEN_EXPIRED"
  | "RETRY_EXHAUSTED";

// ─── The generation document ────────────────────────────────────────────────

/**
 * Canonical shape of a generation record. Named `GenerationDoc` for historical
 * reasons — the "Doc" suffix reflects the Firestore origin, not an intent to
 * couple the domain to a store.
 */
export interface GenerationDoc {
  id: string;
  userId: string;
  toolType: string;
  roomType: string | null;
  designStyle: string | null;
  inputImageUrl: string;
  outputImageUrl: string | null;
  prompt: string;
  /** Builder actionMode that produced this prompt (R27). Nullable for records that predate the rewrite. */
  actionMode: string | null;
  /** Builder guidanceBand that produced this prompt (R27). Nullable for pre-rewrite records. */
  guidanceBand: string | null;
  /** Builder version identifier for post-launch A/B attribution (R27). Nullable for pre-rewrite records. */
  promptVersion: string | null;
  provider: string;
  status: GenerationStatus;
  errorMessage: string | null;
  /** Typed error classification. Nullable for legacy records. */
  errorCode: GenerationErrorCode | null;
  durationMs: number | null;
  createdAt: admin.firestore.Timestamp;
  /**
   * Snapshot-at-enqueue UI language for push notification localization (R10).
   * Nullable for legacy documents — FCM layer falls back to "en" when missing.
   */
  language: SupportedLanguage | null;
  /**
   * Temporary AI output URL (Replicate/fal.ai direct link). Persisted so the
   * processor can resume S3 upload across Cloud Tasks retries without re-running
   * the AI call. Once storageCompletedAt is set, outputImageUrl is canonical.
   */
  tempOutputUrl: string | null;
  /**
   * Cognito Identity ID that wrote the S3 object. Populated by the storage
   * stage. Lets CloudTrail events (which identify the writer by Cognito
   * identity) be cross-referenced back to a Firebase user in one query.
   * Null until the storage checkpoint is recorded.
   */
  cognitoIdentityId: string | null;
  // ─── Async pipeline checkpoints (idempotency markers) ────────────────────
  /** Set when the enqueue endpoint writes the record. */
  queuedAt: admin.firestore.Timestamp | null;
  /** Set when the processor claims the record via claimProcessing. */
  processingStartedAt: admin.firestore.Timestamp | null;
  /** Set after the AI call completes. */
  aiCompletedAt: admin.firestore.Timestamp | null;
  /** Set after the S3 upload completes. */
  storageCompletedAt: admin.firestore.Timestamp | null;
  /** Set when the terminal state is reached (completed or failed). */
  completedAt: admin.firestore.Timestamp | null;
  /** Set after the FCM push has been sent (may stay null if no tokens). */
  notifiedAt: admin.firestore.Timestamp | null;
}

// ─── Data-access input shapes ───────────────────────────────────────────────

export interface CreateQueuedGenerationInput {
  generationId: string;
  userId: string;
  toolType: string;
  roomType: string | null;
  designStyle: string | null;
  inputImageUrl: string;
  language: SupportedLanguage;
}

export interface RecordAiResultInput {
  generationId: string;
  tempOutputUrl: string;
  provider: string;
  prompt: string;
  actionMode: string | null;
  guidanceBand: string | null;
  promptVersion: string | null;
  durationMs: number;
}

// ─── Pipeline state machine ─────────────────────────────────────────────────

/**
 * Result of an attempt to claim a generation for processing (transaction).
 *
 * - `not_found`: document does not exist — caller returns 200 (idempotent no-op)
 * - `claimed`: fresh claim, status moved to `processing`
 * - `resume`: document was already `processing` (Cloud Tasks retry) — caller
 *   resumes from the first un-checkpointed stage
 * - `already_completed`: terminal state reached on a previous attempt
 */
export type ClaimProcessingResult =
  | { kind: "claimed"; doc: GenerationDoc }
  | { kind: "resume"; doc: GenerationDoc }
  | { kind: "already_completed"; doc: GenerationDoc }
  | { kind: "not_found" };

/** Outcome of a processor run, returned to the Cloud Tasks HTTP handler. */
export type ProcessGenerationResult =
  | { action: "ok"; reason: string }
  | { action: "retry"; reason: string };

export interface ProcessGenerationInput {
  generationId: string;
  /**
   * Firebase ID token belonging to the user that enqueued the job. Travels
   * through the Cloud Tasks payload so the processor can federate into
   * Cognito with the same Firebase identity iOS uses. The token is ephemeral
   * (~1h) — the processor runs an expiry pre-flight before every Cognito
   * call and fails with TOKEN_EXPIRED if the remaining lifetime is too short,
   * so the client can re-enqueue with a fresh token.
   */
  firebaseIdToken: string;
  /** Cloud Tasks retry count header, 0 for the first execution. */
  retryCount: number;
}
