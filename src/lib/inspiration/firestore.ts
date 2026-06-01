import admin from "firebase-admin";
import { isTimestamp } from "../firestore-utils.js";
import { inspirationImageUrlFromPath } from "../storage/resolve-inspiration-url.js";
import {
  InvalidCursorError,
  decodeExploreCursor,
  encodeExploreCursor,
  type ExploreQuery,
  type InspirationSeedInput,
} from "./schemas.js";
import { planSeedWrite } from "./seedShape.js";
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
  // Envelope-shape (`taxonomy: { ... }`) is the new write target. Fall back
  // to top-level fields for any legacy docs that pre-date the envelope.
  const taxonomyRaw = data["taxonomy"];
  const taxonomy: Record<string, unknown> =
    taxonomyRaw && typeof taxonomyRaw === "object" && !Array.isArray(taxonomyRaw)
      ? (taxonomyRaw as Record<string, unknown>)
      : data;
  const tagsRaw = taxonomy["tags"] ?? data["tags"];
  return {
    id: doc.id,
    roomType:
      typeof taxonomy["roomType"] === "string" ? taxonomy["roomType"] : "",
    designStyle:
      typeof taxonomy["designStyle"] === "string"
        ? taxonomy["designStyle"]
        : "",
    toolType:
      typeof taxonomy["toolType"] === "string" ? taxonomy["toolType"] : "",
    tags: Array.isArray(tagsRaw)
      ? (tagsRaw as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
    // Docs store a bucket-relative `path`; the REST DTO still exposes a
    // fetchable `imageUrl`, composed from the trusted base at read time.
    imageUrl:
      typeof data["path"] === "string" && data["path"].length > 0
        ? inspirationImageUrlFromPath(data["path"])
        : "",
    cdnUrl: null,
    featured: data["featured"] === true,
    sourceGenerationId:
      typeof data["sourceGenerationId"] === "string"
        ? data["sourceGenerationId"]
        : null,
    createdAt: isTimestamp(data["createdAt"]) ? data["createdAt"] : epoch,
    // Envelope fields surface on the DTO so the write/verify loop works
    // (POST writes them, GET returns them). All optional with explicit
    // null fallbacks so legacy flat-shape docs decode cleanly.
    kind: typeof data["kind"] === "string" ? data["kind"] : null,
    imageWidth: typeof data["imageWidth"] === "number" ? data["imageWidth"] : null,
    imageHeight:
      typeof data["imageHeight"] === "number" ? data["imageHeight"] : null,
    imageMime: typeof data["imageMime"] === "string" ? data["imageMime"] : null,
    prompt: typeof data["prompt"] === "string" ? data["prompt"] : null,
    schemaVersion:
      typeof data["schemaVersion"] === "number" ? data["schemaVersion"] : null,
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
    kind: insp.kind,
    imageWidth: insp.imageWidth,
    imageHeight: insp.imageHeight,
    imageMime: insp.imageMime,
    prompt: insp.prompt,
    schemaVersion: insp.schemaVersion,
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

  // Envelope schema (iOS plan 2026-05-12-001) nests taxonomy fields under
  // `taxonomy.*`. Composite indexes in `firestore.indexes.json` use the
  // nested paths to match the on-disk shape; querying the top-level flat
  // field would miss every envelope doc.
  if (query.roomType) q = q.where("taxonomy.roomType", "==", query.roomType);
  if (query.designStyle)
    q = q.where("taxonomy.designStyle", "==", query.designStyle);
  if (query.toolType)
    q = q.where("taxonomy.toolType", "==", query.toolType);
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

// MARK: - Envelope seed writer (iOS plan 2026-05-12-001)

export interface SeedInspirationResult {
  id: string;
  /** `true` when the doc was newly created; `false` for an upsert that
   *  refreshed an existing row's metadata and `updatedAt` stamp. */
  created: boolean;
}

/**
 * Upsert one inspiration envelope at `inspirations/{row.id}`. Idempotent
 * by id — re-running with the same id refreshes the merge-fields and
 * advances `updatedAt` while preserving `createdAt` and any
 * previously-written `prompt` whose value the new input doesn't supply.
 *
 * The read-then-write is wrapped in a Firestore transaction so concurrent
 * upserts to the same id cannot both observe `exists: false` and both
 * execute the first-write branch (which would silently clobber
 * `createdAt`). A transaction lets exactly one writer create the doc;
 * the loser retries against the freshly-created snapshot and falls
 * through to the merge-fields branch.
 *
 * `planSeedWrite` (pure, in `seedShape.ts`) decides which fields land on
 * each write — including the load-bearing prompt-preservation rule.
 * Within a transaction each `DocumentReference` can only be written
 * once, so the previous "metadata set + standalone prompt patch" pair
 * is collapsed into a single mergeFields write whose field list
 * conditionally includes `prompt`.
 */
export async function seedInspirationDoc(
  row: InspirationSeedInput,
): Promise<SeedInspirationResult> {
  const firestore = getFirestore();
  const docRef = inspirationsRef().doc(row.id);

  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const existingPromptRaw = snap.exists
      ? (snap.get("prompt") as unknown)
      : undefined;
    const plan = planSeedWrite(row, {
      exists: snap.exists,
      prompt:
        typeof existingPromptRaw === "string" ? existingPromptRaw : null,
    });
    const now = admin.firestore.FieldValue.serverTimestamp();

    if (plan.mergeFields === null) {
      // First write — full doc with createdAt + updatedAt.
      tx.set(docRef, { ...plan.data, createdAt: now, updatedAt: now });
    } else {
      tx.set(
        docRef,
        { ...plan.data, updatedAt: now },
        { mergeFields: [...plan.mergeFields] },
      );
    }

    return { id: row.id, created: plan.created };
  });
}

// Re-export the typed cursor error so controllers can `instanceof`-check it
// without importing through the schemas module path.
export { InvalidCursorError };
