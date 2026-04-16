import { getGenerationsByUser } from "../lib/firestore.js";
import type { GenerationStatus } from "../lib/generation/types.js";

export type { GenerationStatus };

export interface HistoryItem {
  id: string;
  toolType: string;
  /** Legacy interior-only mirrored field. Kept for iOS backwards compat. */
  roomType: string | null;
  /** Legacy interior-only mirrored field. Kept for iOS backwards compat. */
  designStyle: string | null;
  /**
   * Tool-agnostic parameter blob. Carries the original request fields for
   * exterior / garden / future tools (roomType + designStyle are still the
   * canonical fields for interior, mirrored from toolParams at write time).
   */
  toolParams: Record<string, unknown> | null;
  inputImageUrl: string;
  outputImageUrl: string | null;
  /**
   * CloudFront-fronted URL for the same S3 object as `outputImageUrl`.
   * Null on legacy records and on deploys without `AWS_CLOUDFRONT_HOST`.
   * Clients should prefer this when non-null for CDN-cached delivery.
   */
  outputImageCDNUrl: string | null;
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
    toolParams: doc.toolParams,
    inputImageUrl: doc.inputImageUrl,
    outputImageUrl: doc.outputImageUrl,
    outputImageCDNUrl: doc.outputImageCDNUrl,
    status: doc.status,
    provider: doc.provider,
    durationMs: doc.durationMs,
    createdAt: doc.createdAt?.toDate().toISOString() ?? null,
  }));
}
