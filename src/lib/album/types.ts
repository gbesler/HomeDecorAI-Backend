import type admin from "firebase-admin";

/**
 * Album domain type. Albums are user-scoped folders that group generations
 * via a many-to-many `generationIds` array. Stored at:
 *   `users/{userId}/albums/{albumId}`
 *
 * The array model is intentional for V1: typical users have <100 generations
 * per album which sits comfortably under the Firestore 1MB doc limit. If
 * we later see albums grow beyond a few hundred items we move membership to
 * a subcollection (`users/{uid}/albums/{aid}/items/{generationId}`).
 */
export interface Album {
  id: string;
  name: string;
  generationIds: string[];
  createdAt: admin.firestore.Timestamp;
  updatedAt: admin.firestore.Timestamp;
}

/** Wire-format album returned by the REST API. Timestamps are ISO strings. */
export interface AlbumDTO {
  id: string;
  name: string;
  generationIds: string[];
  createdAt: string;
  updatedAt: string;
}

export const MAX_ALBUM_NAME_LENGTH = 50;
