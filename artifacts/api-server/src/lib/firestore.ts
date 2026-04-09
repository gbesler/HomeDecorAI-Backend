import admin from "firebase-admin";
import type { RoomType, DesignStyle } from "@workspace/api-zod";
import type { Provider } from "./ai-providers/types.js";

function getFirestore(): admin.firestore.Firestore {
  return admin.firestore();
}

// ─── Generation Document ────────────────────────────────────────────────────

export type GenerationStatus = "pending" | "completed" | "failed";

export interface GenerationDoc {
  id: string;
  userId: string;
  toolType: string;
  roomType: RoomType | null;
  designStyle: DesignStyle | null;
  inputImageUrl: string;
  outputImageUrl: string | null;
  prompt: string;
  provider: Provider | "pending";
  status: GenerationStatus;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: admin.firestore.Timestamp;
}

const GENERATIONS_COLLECTION = "generations";

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

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as GenerationDoc[];
}
