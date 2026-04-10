import admin from "firebase-admin";

function getFirestore(): admin.firestore.Firestore {
  return admin.firestore();
}

// ─── Generation Document ────────────────────────────────────────────────────

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
  status: "pending" | "completed" | "failed";
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: admin.firestore.Timestamp;
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

export async function createGeneration(
  data: Omit<GenerationDoc, "id" | "createdAt">,
): Promise<string> {
  const db = getFirestore();
  const ref = db.collection(GENERATIONS_COLLECTION).doc();

  await ref.set({
    ...data,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return ref.id;
}

export async function updateGeneration(
  id: string,
  data: Partial<
    Pick<
      GenerationDoc,
      "outputImageUrl" | "status" | "errorMessage" | "durationMs" | "provider"
    >
  >,
): Promise<void> {
  const db = getFirestore();
  await db.collection(GENERATIONS_COLLECTION).doc(id).update(data);
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
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      userId: data["userId"],
      toolType: data["toolType"],
      roomType: data["roomType"] ?? null,
      designStyle: data["designStyle"] ?? null,
      inputImageUrl: data["inputImageUrl"],
      outputImageUrl: data["outputImageUrl"] ?? null,
      prompt: data["prompt"],
      actionMode: data["actionMode"] ?? null,
      guidanceBand: data["guidanceBand"] ?? null,
      promptVersion: data["promptVersion"] ?? null,
      provider: data["provider"],
      status: data["status"],
      errorMessage: data["errorMessage"] ?? null,
      durationMs: data["durationMs"] ?? null,
      createdAt: data["createdAt"],
    } as GenerationDoc;
  });
}
