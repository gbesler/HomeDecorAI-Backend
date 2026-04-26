import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ID_PATTERN,
  internalError,
  notFound,
  unauthorized,
  validationError,
} from "../lib/controller-helpers.js";
import {
  InspirationNotFoundError,
  favoriteToDTO,
  listFavorites,
  removeFavorite,
  saveFavorite,
} from "../lib/favorite-inspiration/firestore.js";
import { inspirationToDTO } from "../lib/inspiration/firestore.js";
import {
  InvalidCursorError,
  LimitSchema,
} from "../lib/inspiration/schemas.js";

const InspirationIdParams = z.object({
  inspirationId: z.string().regex(ID_PATTERN),
});

const FavoritesQuery = z.object({
  limit: LimitSchema,
  cursor: z.string().min(1).max(2048).optional(),
});

export async function saveFavoriteHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const params = InspirationIdParams.safeParse(request.params);
  if (!params.success) return validationError(reply, params.error);

  try {
    const fav = await saveFavorite(userId, params.data.inspirationId);
    reply.code(200);
    return { favorite: favoriteToDTO(fav) };
  } catch (err) {
    if (err instanceof InspirationNotFoundError)
      return notFound(reply, "Inspiration not found.");
    request.log.error(
      {
        event: "favorite.save_failed",
        userId,
        inspirationId: params.data.inspirationId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to save favorite",
    );
    return internalError(reply, "Failed to save favorite.");
  }
}

export async function deleteFavoriteHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const params = InspirationIdParams.safeParse(request.params);
  if (!params.success) return validationError(reply, params.error);

  try {
    await removeFavorite(userId, params.data.inspirationId);
    reply.code(204);
    return;
  } catch (err) {
    request.log.error(
      {
        event: "favorite.delete_failed",
        userId,
        inspirationId: params.data.inspirationId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to delete favorite",
    );
    return internalError(reply, "Failed to delete favorite.");
  }
}

export async function listFavoritesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const parsed = FavoritesQuery.safeParse(request.query ?? {});
  if (!parsed.success) return validationError(reply, parsed.error);

  try {
    const page = await listFavorites(
      userId,
      parsed.data.limit,
      parsed.data.cursor ?? null,
    );
    return {
      items: page.items.map((entry) => ({
        inspiration: inspirationToDTO(entry.inspiration),
        savedAt: entry.savedAt.toDate().toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      reply.code(400);
      return { error: "Validation Error", message: err.message };
    }
    request.log.error(
      {
        event: "favorite.list_failed",
        userId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to list favorites",
    );
    return internalError(reply, "Failed to list favorites.");
  }
}
