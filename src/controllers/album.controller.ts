import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  AlbumNotFoundError,
  GenerationNotFoundError,
  addGenerationToAlbum,
  albumToDTO,
  createAlbum,
  deleteAlbum,
  listAlbums,
  removeGenerationFromAlbum,
  renameAlbum,
} from "../lib/album/firestore.js";
import { MAX_ALBUM_NAME_LENGTH } from "../lib/album/types.js";

// URL-safe path-segment IDs only — defense in depth against path traversal
// payloads that bypass the Fastify route schema (e.g. via Swagger key bypass
// or future schema misconfig).
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const NameBody = z.object({
  name: z.string().trim().min(1).max(MAX_ALBUM_NAME_LENGTH),
});

const AlbumIdParams = z.object({
  albumId: z.string().regex(ID_PATTERN),
});

const AlbumGenerationParams = z.object({
  albumId: z.string().regex(ID_PATTERN),
  generationId: z.string().regex(ID_PATTERN),
});

const AddGenerationBody = z.object({
  generationId: z.string().regex(ID_PATTERN),
});

function unauthorized(reply: FastifyReply) {
  reply.code(401);
  return { error: "Unauthorized", message: "Authentication required" };
}

function validationError(reply: FastifyReply, err: z.ZodError) {
  reply.code(400);
  return {
    error: "Validation Error",
    message: err.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", "),
  };
}

function notFound(reply: FastifyReply, kind: "album" | "generation") {
  reply.code(404);
  return {
    error: "Not Found",
    message:
      kind === "album"
        ? "Album not found."
        : "Generation not found or unauthorized.",
  };
}

function internalError(reply: FastifyReply, message = "Internal error.") {
  reply.code(500);
  return { error: "Internal Error", message };
}

export async function createAlbumHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const parsed = NameBody.safeParse(request.body);
  if (!parsed.success) return validationError(reply, parsed.error);

  try {
    const album = await createAlbum(userId, parsed.data.name);
    reply.code(201);
    return { album: albumToDTO(album) };
  } catch (err) {
    request.log.error(
      {
        event: "album.create_failed",
        userId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to create album",
    );
    return internalError(reply, "Failed to create album.");
  }
}

export async function listAlbumsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  try {
    const albums = await listAlbums(userId);
    return { albums: albums.map(albumToDTO) };
  } catch (err) {
    request.log.error(
      {
        event: "album.list_failed",
        userId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to list albums",
    );
    return internalError(reply, "Failed to list albums.");
  }
}

export async function renameAlbumHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const params = AlbumIdParams.safeParse(request.params);
  if (!params.success) return validationError(reply, params.error);

  const body = NameBody.safeParse(request.body);
  if (!body.success) return validationError(reply, body.error);

  try {
    const album = await renameAlbum(
      userId,
      params.data.albumId,
      body.data.name,
    );
    return { album: albumToDTO(album) };
  } catch (err) {
    if (err instanceof AlbumNotFoundError) return notFound(reply, "album");
    request.log.error(
      {
        event: "album.rename_failed",
        userId,
        albumId: params.data.albumId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to rename album",
    );
    return internalError(reply, "Failed to rename album.");
  }
}

export async function deleteAlbumHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const params = AlbumIdParams.safeParse(request.params);
  if (!params.success) return validationError(reply, params.error);

  try {
    await deleteAlbum(userId, params.data.albumId);
    reply.code(204);
    return;
  } catch (err) {
    if (err instanceof AlbumNotFoundError) return notFound(reply, "album");
    request.log.error(
      {
        event: "album.delete_failed",
        userId,
        albumId: params.data.albumId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to delete album",
    );
    return internalError(reply, "Failed to delete album.");
  }
}

export async function addGenerationToAlbumHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const params = AlbumIdParams.safeParse(request.params);
  if (!params.success) return validationError(reply, params.error);

  const body = AddGenerationBody.safeParse(request.body);
  if (!body.success) return validationError(reply, body.error);

  try {
    const album = await addGenerationToAlbum(
      userId,
      params.data.albumId,
      body.data.generationId,
    );
    return { album: albumToDTO(album) };
  } catch (err) {
    if (err instanceof AlbumNotFoundError) return notFound(reply, "album");
    if (err instanceof GenerationNotFoundError)
      return notFound(reply, "generation");
    request.log.error(
      {
        event: "album.add_generation_failed",
        userId,
        albumId: params.data.albumId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to add generation to album",
    );
    return internalError(reply, "Failed to add generation to album.");
  }
}

export async function removeGenerationFromAlbumHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const params = AlbumGenerationParams.safeParse(request.params);
  if (!params.success) return validationError(reply, params.error);

  try {
    const album = await removeGenerationFromAlbum(
      userId,
      params.data.albumId,
      params.data.generationId,
    );
    return { album: albumToDTO(album) };
  } catch (err) {
    if (err instanceof AlbumNotFoundError) return notFound(reply, "album");
    request.log.error(
      {
        event: "album.remove_generation_failed",
        userId,
        albumId: params.data.albumId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to remove generation from album",
    );
    return internalError(reply, "Failed to remove generation from album.");
  }
}
