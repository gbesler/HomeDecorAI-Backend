import admin from "firebase-admin";
import { logger } from "../logger.js";
import { isTimestamp } from "../firestore-utils.js";
import {
  InvalidCursorError,
  decodeExploreCursor,
  encodeExploreCursor,
  type ExploreQuery,
} from "./schemas.js";
import type { Inspiration, InspirationDTO } from "./types.js";

const INSPIRATIONS_COLLECTION = "inspirations";

function getFirestore(): admin.firestore.Firestore {
  return admin.firestore();
}

function inspirationsRef() {
  return getFirestore().collection(INSPIRATIONS_COLLECTION);
}

export class InspirationNotFoundError extends Error {
  constructor(inspirationId: string) {
    super(`Inspiration not found: ${inspirationId}`);
    this.name = "InspirationNotFoundError";
  }
}

function mapDocToInspiration(
  doc:
    | FirebaseFirestore.QueryDocumentSnapshot
    | FirebaseFirestore.DocumentSnapshot,
): Inspiration {
  const data = doc.data() ?? {};
  const epoch = admin.firestore.Timestamp.fromMillis(0);
  const tagsRaw = data["tags"];
  return {
    id: doc.id,
    roomType: typeof data["roomType"] === "string" ? data["roomType"] : "",
    designStyle:
      typeof data["designStyle"] === "string" ? data["designStyle"] : "",
    toolType: typeof data["toolType"] === "string" ? data["toolType"] : "",
    tags: Array.isArray(tagsRaw)
      ? (tagsRaw as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
    imageUrl: typeof data["imageUrl"] === "string" ? data["imageUrl"] : "",
    cdnUrl: typeof data["cdnUrl"] === "string" ? data["cdnUrl"] : null,
    featured: data["featured"] === true,
    sourceGenerationId:
      typeof data["sourceGenerationId"] === "string"
        ? data["sourceGenerationId"]
        : null,
    createdAt: isTimestamp(data["createdAt"]) ? data["createdAt"] : epoch,
  };
}

export function inspirationToDTO(insp: Inspiration): InspirationDTO {
  return {
    id: insp.id,
    roomType: insp.roomType,
    designStyle: insp.designStyle,
    toolType: insp.toolType,
    tags: insp.tags,
    imageUrl: insp.imageUrl,
    cdnUrl: insp.cdnUrl,
    featured: insp.featured,
    sourceGenerationId: insp.sourceGenerationId,
    createdAt: insp.createdAt.toDate().toISOString(),
  };
}

export interface ExplorePage {
  items: Inspiration[];
  nextCursor: string | null;
}

/**
 * List inspirations with optional filters and cursor pagination.
 *
 * Pagination uses a (createdAt DESC, __name__ DESC) keyset — the secondary
 * `__name__` ordering is essential for stable pagination when two
 * inspirations share the same `createdAt` millisecond. Without it,
 * `startAfter(timestamp)` is non-deterministic at boundaries and items can
 * appear on multiple pages or be skipped entirely.
 *
 * Filter combinations require composite indexes — `firestore.indexes.json`
 * declares the supported axes (roomType, designStyle, toolType, featuredOnly,
 * each pairwise + the full triplet, all with createdAt DESC + __name__ DESC).
 * If a caller passes a filter combination that is not indexed, Firestore
 * returns FAILED_PRECONDITION; the controller maps that to a 500 + log.
 */
export async function listInspirations(
  query: ExploreQuery,
): Promise<ExplorePage> {
  let q: admin.firestore.Query = inspirationsRef();

  if (query.roomType) q = q.where("roomType", "==", query.roomType);
  if (query.designStyle) q = q.where("designStyle", "==", query.designStyle);
  if (query.toolType) q = q.where("toolType", "==", query.toolType);
  if (query.featuredOnly) q = q.where("featured", "==", true);

  q = q
    .orderBy("createdAt", "desc")
    .orderBy(admin.firestore.FieldPath.documentId(), "desc");

  if (query.cursor) {
    const payload = decodeExploreCursor(query.cursor); // throws InvalidCursorError
    q = q.startAfter(
      admin.firestore.Timestamp.fromMillis(payload.lastCreatedAtMs),
      payload.lastId,
    );
  }

  // Fetch one extra to know whether another page exists without a count query.
  const snap = await q.limit(query.limit + 1).get();
  const docs = snap.docs.slice(0, query.limit);
  const items = docs.map(mapDocToInspiration);
  const hasMore = snap.docs.length > query.limit;

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    if (last) {
      nextCursor = encodeExploreCursor({
        lastId: last.id,
        lastCreatedAtMs: last.createdAt.toMillis(),
      });
    }
  }

  return { items, nextCursor };
}

export async function getInspiration(
  inspirationId: string,
): Promise<Inspiration> {
  const ref = inspirationsRef().doc(inspirationId);
  const snap = await ref.get();
  if (!snap.exists) throw new InspirationNotFoundError(inspirationId);
  return mapDocToInspiration(snap);
}

/** Batched existence check used by the favorite-inspirations join. Missing
 *  ids are silently skipped — we log a warning so an empty inspiration
 *  referenced by a stale favorite doc is observable. */
export async function getInspirationsByIds(
  ids: string[],
): Promise<Map<string, Inspiration>> {
  const result = new Map<string, Inspiration>();
  if (ids.length === 0) return result;

  // Firestore `in` queries cap at 30 ids; chunk defensively.
  const CHUNK = 30;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const snap = await getFirestore()
      .collection(INSPIRATIONS_COLLECTION)
      .where(admin.firestore.FieldPath.documentId(), "in", chunk)
      .get();
    for (const doc of snap.docs) {
      result.set(doc.id, mapDocToInspiration(doc));
    }
  }

  const missing = ids.filter((id) => !result.has(id));
  if (missing.length > 0) {
    logger.warn(
      { event: "inspiration.missing_ids", count: missing.length, missing },
      "Some favorite-referenced inspirations no longer exist",
    );
  }
  return result;
}

// Re-export the typed cursor error so controllers can `instanceof`-check it
// without importing through the schemas module path.
export { InvalidCursorError };
