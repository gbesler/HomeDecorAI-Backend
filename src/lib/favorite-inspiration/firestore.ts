import admin from "firebase-admin";
import { logger } from "../logger.js";
import { isTimestamp } from "../firestore-utils.js";
import {
  InspirationNotFoundError,
  getInspiration,
  getInspirationsByIds,
} from "../inspiration/firestore.js";
import type { Inspiration } from "../inspiration/types.js";
import {
  decodeFavoritesCursor,
  encodeFavoritesCursor,
} from "../inspiration/schemas.js";
import type {
  FavoriteInspiration,
  FavoriteInspirationDTO,
} from "./types.js";

const USERS_COLLECTION = "users";
const FAVORITES_SUBCOLLECTION = "favoriteInspirations";

function getFirestore(): admin.firestore.Firestore {
  return admin.firestore();
}

function favoritesRef(userId: string) {
  return getFirestore()
    .collection(USERS_COLLECTION)
    .doc(userId)
    .collection(FAVORITES_SUBCOLLECTION);
}

function mapDoc(
  doc:
    | FirebaseFirestore.QueryDocumentSnapshot
    | FirebaseFirestore.DocumentSnapshot,
): FavoriteInspiration {
  const data = doc.data() ?? {};
  const epoch = admin.firestore.Timestamp.fromMillis(0);
  return {
    inspirationId: doc.id,
    savedAt: isTimestamp(data["savedAt"]) ? data["savedAt"] : epoch,
  };
}

export function favoriteToDTO(
  fav: FavoriteInspiration,
): FavoriteInspirationDTO {
  return {
    inspirationId: fav.inspirationId,
    savedAt: fav.savedAt.toDate().toISOString(),
  };
}

/**
 * Idempotent save. Verifies the inspiration exists first so we don't
 * accumulate dangling references when an admin deletes content.
 *
 * Returns the favorite with `savedAt` set to the call-site `Date.now()`
 * rather than reading back the just-written document. The previous
 * read-after-write pattern occasionally hit a race where the server
 * timestamp had not been resolved by the time the read landed, yielding a
 * 1970-01-01 epoch value in the response. The exact server timestamp is
 * still authoritative on subsequent list reads — this only affects the
 * single PUT response body and the iOS optimistic insert order.
 *
 * Throws InspirationNotFoundError when the inspiration is missing.
 */
export async function saveFavorite(
  userId: string,
  inspirationId: string,
): Promise<FavoriteInspiration> {
  await getInspiration(inspirationId); // side effect: throws when missing

  const now = admin.firestore.Timestamp.now();
  const ref = favoritesRef(userId).doc(inspirationId);
  await ref.set(
    {
      savedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  logger.info(
    { event: "favorite.saved", userId, inspirationId },
    "Inspiration favorited",
  );
  return { inspirationId, savedAt: now };
}

/** Idempotent delete: returns silently when the doc does not exist. */
export async function removeFavorite(
  userId: string,
  inspirationId: string,
): Promise<void> {
  const ref = favoritesRef(userId).doc(inspirationId);
  await ref.delete();
  logger.info(
    { event: "favorite.removed", userId, inspirationId },
    "Inspiration unfavorited",
  );
}

export interface FavoritesPage {
  /** Joined inspirations, in savedAt-desc order. Missing inspirations are
   *  silently skipped (with a warning logged in `getInspirationsByIds`). */
  items: Array<{ inspiration: Inspiration; savedAt: admin.firestore.Timestamp }>;
  nextCursor: string | null;
}

/**
 * List a user's favorites with cursor pagination, joining the actual
 * inspiration content. Pagination uses a (savedAt DESC, __name__ DESC)
 * keyset for stable ordering when two favorites share the same `savedAt`
 * millisecond.
 *
 * Returning `nextCursor != null` together with `items: []` would let the
 * iOS pagination loop spin forever, so the caller's expectation is that an
 * empty visible page only ever happens with a null cursor. We achieve that
 * by re-fetching deeper pages until either we've filled `limit` visible
 * items, or the underlying collection is exhausted. The fetch loop is
 * bounded so a corrupt subcollection can't fan out unbounded reads.
 */
export async function listFavorites(
  userId: string,
  limit: number,
  cursor: string | null,
): Promise<FavoritesPage> {
  const items: FavoritesPage["items"] = [];

  // Sentinel for "we've reached the end of the user's subcollection".
  let exhausted = false;
  // Cursor passed into the next inner fetch — starts at the caller's
  // cursor and advances each iteration.
  let innerCursor: string | null = cursor;
  // Track the last raw favorite doc we *visited* (post-deletion-filter
  // skipped or kept). This is what we encode into nextCursor so the next
  // page resumes after the last doc the caller saw — including any
  // deletion-skipped ones, so we don't re-visit them.
  let lastVisited: FavoriteInspiration | null = null;

  // Fetch loop bound: at most 5 inner pages per outer call. With the
  // default limit of 20 and a worst-case 50% deletion rate, this still
  // surfaces the requested page. A higher deletion rate falls through to
  // the bound and reports nextCursor pointing at the last visited doc so
  // the client can keep paginating.
  const MAX_INNER_FETCHES = 5;

  for (let i = 0; i < MAX_INNER_FETCHES && items.length < limit && !exhausted; i++) {
    let q: admin.firestore.Query = favoritesRef(userId)
      .orderBy("savedAt", "desc")
      .orderBy(admin.firestore.FieldPath.documentId(), "desc");

    if (innerCursor) {
      const payload = decodeFavoritesCursor(innerCursor); // throws InvalidCursorError
      q = q.startAfter(
        admin.firestore.Timestamp.fromMillis(payload.lastSavedAtMs),
        payload.lastId,
      );
    }

    // Fetch a `limit + 1` window so we know whether the underlying
    // collection has more docs even after deletion-filtering.
    const innerLimit = limit + 1;
    const snap = await q.limit(innerLimit).get();
    if (snap.docs.length === 0) {
      exhausted = true;
      break;
    }

    const rawFavorites = snap.docs.map(mapDoc);
    const inspirationsById = await getInspirationsByIds(
      rawFavorites.map((f) => f.inspirationId),
    );

    for (const fav of rawFavorites) {
      lastVisited = fav;
      const inspiration = inspirationsById.get(fav.inspirationId);
      if (!inspiration) continue;
      items.push({ inspiration, savedAt: fav.savedAt });
      if (items.length >= limit) break;
    }

    if (snap.docs.length < innerLimit) {
      // The underlying query is exhausted; no further pages.
      exhausted = true;
    } else if (lastVisited) {
      innerCursor = encodeFavoritesCursor({
        lastId: lastVisited.inspirationId,
        lastSavedAtMs: lastVisited.savedAt.toMillis(),
      });
    }
  }

  // nextCursor is null when we've drained the subcollection OR when items
  // is empty (the second guard avoids the infinite-empty-page loop on
  // iOS). Otherwise it points at the last doc we visited.
  let nextCursor: string | null = null;
  if (!exhausted && items.length > 0 && lastVisited) {
    nextCursor = encodeFavoritesCursor({
      lastId: lastVisited.inspirationId,
      lastSavedAtMs: lastVisited.savedAt.toMillis(),
    });
  }

  return { items, nextCursor };
}

export { InspirationNotFoundError };
