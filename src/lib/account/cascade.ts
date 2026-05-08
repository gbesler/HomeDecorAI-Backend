import admin from "firebase-admin";
import { logger } from "../logger.js";

/**
 * Recursively delete every Firestore record owned by `uid`.
 *
 * Two trees need cleanup:
 *
 * 1. **`users/{uid}` and its subtree** — the user document itself plus the
 *    `albums/{albumId}/items/{generationId}` subcollections. Cleared with
 *    Firestore's native `recursiveDelete(docRef)` (Admin SDK v11+ /
 *    `firebase-admin: ^13`), which paginated-deletes the entire document tree
 *    via a default `BulkWriter`.
 *
 * 2. **`generations/*` where `userId == uid`** — top-level collection,
 *    partitioned by `userId` field rather than nested under the user. We
 *    cannot use `recursiveDelete` for a query result; instead we paginate the
 *    matching docs in 500-doc chunks (Firestore's batch write limit) and
 *    drain the matching set.
 *
 * Idempotent: a second call against the same uid sees an empty generations
 * query and a non-existent user doc, both of which are no-ops. Caller is
 * expected to enforce ownership upstream (auth middleware extracts `uid`
 * from a Bearer ID token), so this helper does not re-validate ownership.
 */
const GENERATIONS_COLLECTION = "generations";
const USERS_COLLECTION = "users";
const ALBUMS_SUBCOLLECTION = "albums";
const GENERATIONS_BATCH_SIZE = 500;
/// Maximum wall-clock time the cascade is allowed to spend before bailing
/// out with a partial result. Cloud Run's default request timeout is 60s;
/// we bail at 45s so the 503 + Retry-After hint actually reaches the
/// client instead of the platform killing the worker mid-response. The
/// cascade is idempotent — a retry resumes from wherever drain left off.
const CASCADE_DEADLINE_MS = 45_000;

export class CascadeDeadlineExceededError extends Error {
  constructor(public readonly generationsDeleted: number) {
    super("Cascade exceeded its deadline; partial progress made");
    this.name = "CascadeDeadlineExceededError";
  }
}

export interface DeleteUserDataResult {
  generationsDeleted: number;
}

export async function deleteUserData(uid: string): Promise<DeleteUserDataResult> {
  if (!uid || !uid.trim()) {
    throw new Error("deleteUserData requires a non-empty uid");
  }

  const db = admin.firestore();
  const start = Date.now();
  let generationsDeleted = 0;
  let batchIndex = 0;

  // 1. Drain top-level generations owned by this user, 500 at a time. We
  //    delete in chunks because Firestore caps a single batched write at
  //    500 operations — beyond that the commit fails. Heavy users
  //    (1000+ generations) are bounded by `CASCADE_DEADLINE_MS` so we
  //    never blow past Cloud Run's request timeout.
  for (;;) {
    if (Date.now() - start > CASCADE_DEADLINE_MS) {
      throw new CascadeDeadlineExceededError(generationsDeleted);
    }

    const snap = await db
      .collection(GENERATIONS_COLLECTION)
      .where("userId", "==", uid)
      .limit(GENERATIONS_BATCH_SIZE)
      .get();

    if (snap.empty) break;

    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    generationsDeleted += snap.size;
    batchIndex++;

    logger.debug(
      {
        event: "account.cascade.batch",
        batchIndex,
        batchSize: snap.size,
        elapsedMs: Date.now() - start,
      },
      "Drained generations batch",
    );

    // If we got fewer than the limit back, we just drained the tail —
    // skip the inevitable empty-query round trip on the next iteration.
    if (snap.size < GENERATIONS_BATCH_SIZE) break;
  }

  // 2. Explicitly drain the `users/{uid}/albums/*` subcollection before the
  //    recursiveDelete pass. `recursiveDelete` is documented to walk
  //    subcollections, but in production we observed album docs surviving
  //    the sweep (the parent doc + top-level subtree go, but album docs
  //    occasionally linger). An explicit batched drain here makes the
  //    delete deterministic regardless of recursiveDelete's traversal
  //    behavior, and is idempotent — a second call sees an empty
  //    subcollection and exits immediately. Albums store `generationIds`
  //    as an array field on the album doc itself, so there are no
  //    nested subcollections to chase here.
  if (Date.now() - start > CASCADE_DEADLINE_MS) {
    throw new CascadeDeadlineExceededError(generationsDeleted);
  }
  const userRef = db.collection(USERS_COLLECTION).doc(uid);
  for (;;) {
    if (Date.now() - start > CASCADE_DEADLINE_MS) {
      throw new CascadeDeadlineExceededError(generationsDeleted);
    }
    const albumsSnap = await userRef
      .collection(ALBUMS_SUBCOLLECTION)
      .limit(GENERATIONS_BATCH_SIZE)
      .get();
    if (albumsSnap.empty) break;
    const albumsBatch = db.batch();
    for (const doc of albumsSnap.docs) {
      albumsBatch.delete(doc.ref);
    }
    await albumsBatch.commit();
    if (albumsSnap.size < GENERATIONS_BATCH_SIZE) break;
  }

  // 3. Recursively delete the user's entire document tree. This handles
  //    the user doc itself plus any unanticipated subcollections added in
  //    the future. No-op on a missing tree, which is what makes the whole
  //    helper idempotent.
  if (Date.now() - start > CASCADE_DEADLINE_MS) {
    throw new CascadeDeadlineExceededError(generationsDeleted);
  }
  await db.recursiveDelete(userRef);

  logger.info(
    {
      event: "account.cascade.completed",
      generationsDeleted,
      batchCount: batchIndex,
      elapsedMs: Date.now() - start,
    },
    "User Firestore cascade complete",
  );

  return { generationsDeleted };
}
