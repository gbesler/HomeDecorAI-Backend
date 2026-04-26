import type admin from "firebase-admin";

/**
 * FavoriteInspiration domain type. A user's saved curated-inspiration entry.
 * Stored at: `users/{userId}/favoriteInspirations/{inspirationId}`.
 *
 * The doc id IS the inspiration id, which makes the PUT/DELETE flow idempotent
 * without an extra existence query and gives O(1) "is this favorited?" lookups
 * on iOS (no scan of a list).
 */
export interface FavoriteInspiration {
  inspirationId: string;
  savedAt: admin.firestore.Timestamp;
}

/** Wire format. The full Inspiration object is joined in by the controller so
 *  iOS can render the Favorites grid without a second round-trip per item. */
export interface FavoriteInspirationDTO {
  inspirationId: string;
  savedAt: string;
}
