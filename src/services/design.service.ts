import { getGenerationsByUser } from "../lib/firestore.js";
import type { GenerationStatus } from "../lib/generation/types.js";

export type { GenerationStatus };

export interface HistoryItem {
  id: string;
  toolType: string;
  roomType: string | null;
  designStyle: string | null;
  inputImageUrl: string;
  outputImageUrl: string | null;
  status: GenerationStatus;
  provider: string;
  durationMs: number | null;
  createdAt: string | null;
}

export async function getDesignHistory(
  userId: string,
  limit: number,
): Promise<HistoryItem[]> {
  const docs = await getGenerationsByUser(userId, limit);

  return docs.map((doc) => ({
    id: doc.id,
    toolType: doc.toolType,
    roomType: doc.roomType,
    designStyle: doc.designStyle,
    inputImageUrl: doc.inputImageUrl,
    outputImageUrl: doc.outputImageUrl,
    status: doc.status,
    provider: doc.provider,
    durationMs: doc.durationMs,
    createdAt: doc.createdAt?.toDate().toISOString() ?? null,
  }));
}
