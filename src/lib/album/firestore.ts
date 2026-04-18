import { randomUUID } from "node:crypto";
import admin from "firebase-admin";
import { logger } from "../logger.js";
import type { Album, AlbumDTO } from "./types.js";

const USERS_COLLECTION = "users";
const ALBUMS_SUBCOLLECTION = "albums";
const GENERATIONS_COLLECTION = "generations";

function getFirestore(): admin.firestore.Firestore {
  return admin.firestore();
}

function albumsRef(userId: string) {
  return getFirestore()
    .collection(USERS_COLLECTION)
    .doc(userId)
    .collection(ALBUMS_SUBCOLLECTION);
}

/** Domain error thrown when an operation references a missing album. */
export class AlbumNotFoundError extends Error {
  constructor(albumId: string) {
    super(`Album not found: ${albumId}`);
    this.name = "AlbumNotFoundError";
  }
}

/** Thrown when a user tries to add a generation they do not own. */
export class GenerationNotFoundError extends Error {
  constructor(generationId: string) {
    super(`Generation not found or unauthorized: ${generationId}`);
    this.name = "GenerationNotFoundError";
  }
}

/**
 * Firestore admin SDK throws gRPC code 5 (NOT_FOUND) when `update()` or
 * `delete()` runs against a doc that was deleted between our existence
 * check and the mutation. Without this guard the controller maps the raw
 * error to a generic 500 — but the user-visible truth is "the album is
 * gone", which is a 404.
 */
function isFirestoreNotFound(err: unknown): boolean {
  const e = err as { code?: number | string } | null;
  if (!e) return false;
  // Admin SDK uses numeric gRPC code 5 OR string code "not-found" depending
  // on transport.
  return e.code === 5 || e.code === "not-found";
}

function isTimestamp(value: unknown): value is admin.firestore.Timestamp {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  );
}

function mapDocToAlbum(
  doc: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot,
): Album {
  const data = doc.data() ?? {};
  const rawIds = data["generationIds"];
  // Guard timestamp fields — a doc read immediately after a serverTimestamp()
  // write or a manually seeded doc may not have committed Timestamps yet.
  // Falling back to epoch 0 keeps `albumToDTO` total instead of throwing on
  // `.toDate()` of undefined.
  const epoch = admin.firestore.Timestamp.fromMillis(0);
  return {
    id: doc.id,
    name: typeof data["name"] === "string" ? data["name"] : "",
    generationIds: Array.isArray(rawIds)
      ? (rawIds as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
    createdAt: isTimestamp(data["createdAt"]) ? data["createdAt"] : epoch,
    updatedAt: isTimestamp(data["updatedAt"]) ? data["updatedAt"] : epoch,
  };
}

export function albumToDTO(album: Album): AlbumDTO {
  return {
    id: album.id,
    name: album.name,
    generationIds: album.generationIds,
    createdAt: album.createdAt.toDate().toISOString(),
    updatedAt: album.updatedAt.toDate().toISOString(),
  };
}

export async function createAlbum(
  userId: string,
  name: string,
): Promise<Album> {
  const id = randomUUID();
  const ref = albumsRef(userId).doc(id);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.set({
    name,
    generationIds: [],
    createdAt: now,
    updatedAt: now,
  });
  const snap = await ref.get();
  logger.info({ event: "album.created", userId, albumId: id }, "Album created");
  return mapDocToAlbum(snap);
}

export async function listAlbums(userId: string): Promise<Album[]> {
  const snap = await albumsRef(userId).orderBy("updatedAt", "desc").get();
  return snap.docs.map((d) => mapDocToAlbum(d));
}

export async function renameAlbum(
  userId: string,
  albumId: string,
  newName: string,
): Promise<Album> {
  const ref = albumsRef(userId).doc(albumId);
  const snap = await ref.get();
  if (!snap.exists) throw new AlbumNotFoundError(albumId);
  try {
    await ref.update({
      name: newName,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    if (isFirestoreNotFound(err)) throw new AlbumNotFoundError(albumId);
    throw err;
  }
  const updated = await ref.get();
  if (!updated.exists) throw new AlbumNotFoundError(albumId);
  logger.info({ event: "album.renamed", userId, albumId }, "Album renamed");
  return mapDocToAlbum(updated);
}

export async function deleteAlbum(
  userId: string,
  albumId: string,
): Promise<void> {
  const ref = albumsRef(userId).doc(albumId);
  // delete() is idempotent — no need for a pre-read existence check.
  // The pre-read here used to provide a 404 for "already deleted" callers,
  // but iOS retries are infrequent enough that returning 200 for a no-op
  // delete is preferable to the extra Firestore read on every request.
  // We retain the pre-read only when we want to know the album existed.
  const snap = await ref.get();
  if (!snap.exists) throw new AlbumNotFoundError(albumId);
  await ref.delete();
  logger.info(
    { event: "album.deleted", userId, albumId },
    "Album deleted (generations untouched)",
  );
}

/**
 * Verify a generation belongs to the requesting user before adding it to one
 * of their albums. Prevents cross-user data leaks via guessable generationIds.
 */
async function assertGenerationOwnedBy(
  userId: string,
  generationId: string,
): Promise<void> {
  // Project only `userId` — the generations doc carries prompt + URL payload
  // we don't need just to verify ownership. `.select()` lives on Query, not
  // DocumentReference, so this goes through the parent collection with a
  // doc-id `where()` clause.
  const snap = await getFirestore()
    .collection(GENERATIONS_COLLECTION)
    .where(admin.firestore.FieldPath.documentId(), "==", generationId)
    .select("userId")
    .limit(1)
    .get();
  if (snap.empty) throw new GenerationNotFoundError(generationId);
  const data = snap.docs[0]?.data() ?? {};
  if (data["userId"] !== userId) {
    throw new GenerationNotFoundError(generationId);
  }
}

export async function addGenerationToAlbum(
  userId: string,
  albumId: string,
  generationId: string,
): Promise<Album> {
  const ref = albumsRef(userId).doc(albumId);
  const snap = await ref.get();
  if (!snap.exists) throw new AlbumNotFoundError(albumId);
  await assertGenerationOwnedBy(userId, generationId);
  try {
    await ref.update({
      generationIds: admin.firestore.FieldValue.arrayUnion(generationId),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    if (isFirestoreNotFound(err)) throw new AlbumNotFoundError(albumId);
    throw err;
  }
  const updated = await ref.get();
  if (!updated.exists) throw new AlbumNotFoundError(albumId);
  logger.info(
    { event: "album.generation_added", userId, albumId, generationId },
    "Generation added to album",
  );
  return mapDocToAlbum(updated);
}

export async function removeGenerationFromAlbum(
  userId: string,
  albumId: string,
  generationId: string,
): Promise<Album> {
  const ref = albumsRef(userId).doc(albumId);
  const snap = await ref.get();
  if (!snap.exists) throw new AlbumNotFoundError(albumId);
  try {
    await ref.update({
      generationIds: admin.firestore.FieldValue.arrayRemove(generationId),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    if (isFirestoreNotFound(err)) throw new AlbumNotFoundError(albumId);
    throw err;
  }
  const updated = await ref.get();
  if (!updated.exists) throw new AlbumNotFoundError(albumId);
  logger.info(
    { event: "album.generation_removed", userId, albumId, generationId },
    "Generation removed from album",
  );
  return mapDocToAlbum(updated);
}
