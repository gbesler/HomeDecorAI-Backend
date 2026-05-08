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
const GENERATIONS_BATCH_SIZE = 500;

export interface DeleteUserDataResult {
  generationsDeleted: number;
}

export async function deleteUserData(uid: string): Promise<DeleteUserDataResult> {
  if (!uid || !uid.trim()) {
    throw new Error("deleteUserData requires a non-empty uid");
  }

  const db = admin.firestore();
  let generationsDeleted = 0;

  // 1. Drain top-level generations owned by this user, 500 at a time. We
  //    delete in chunks because Firestore caps a single batched write at
  //    500 operations — beyond that the commit fails.
  for (;;) {
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

    // If we got fewer than the limit back, we just drained the tail —
    // skip the inevitable empty-query round trip on the next iteration.
    if (snap.size < GENERATIONS_BATCH_SIZE) break;
  }

  // 2. Recursively delete the user's entire document tree. This handles
  //    `users/{uid}/albums/{*}/items/{*}` → `albums/{*}` → `users/{uid}` in
  //    one paginated sweep using the SDK's default BulkWriter. No-op on a
  //    missing tree, which is what makes the whole helper idempotent.
  const userRef = db.collection(USERS_COLLECTION).doc(uid);
  await db.recursiveDelete(userRef);

  logger.info(
    {
      event: "account.cascade.completed",
      generationsDeleted,
    },
    "User Firestore cascade complete",
  );

  return { generationsDeleted };
}
