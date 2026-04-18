import type { FastifyPluginAsync } from "fastify";
import {
  addGenerationToAlbumHandler,
  createAlbumHandler,
  deleteAlbumHandler,
  listAlbumsHandler,
  removeGenerationFromAlbumHandler,
  renameAlbumHandler,
} from "../controllers/album.controller.js";
import { createRateLimitPreHandler } from "../lib/rate-limiter.js";
import { MAX_ALBUM_NAME_LENGTH } from "../lib/album/types.js";

const albumWriteLimit = createRateLimitPreHandler("albumWrite");
const albumReadLimit = createRateLimitPreHandler("albumRead");

// Path-segment IDs: server-generated UUIDs are 36 chars (`[0-9a-f-]+`),
// but we accept any URL-safe ID up to 128 chars. The strict regex blocks
// path-traversal payloads like `../../users/...` from reaching the handler.
const idPattern = "^[A-Za-z0-9_-]{1,128}$";

const albumIdParamsSchema = {
  type: "object" as const,
  required: ["albumId"] as const,
  properties: {
    albumId: { type: "string" as const, pattern: idPattern },
  },
};

const albumGenerationParamsSchema = {
  type: "object" as const,
  required: ["albumId", "generationId"] as const,
  properties: {
    albumId: { type: "string" as const, pattern: idPattern },
    generationId: { type: "string" as const, pattern: idPattern },
  },
};

const generationBodySchema = {
  type: "object" as const,
  required: ["generationId"] as const,
  properties: {
    generationId: { type: "string" as const, pattern: idPattern },
  },
};

const nameBodySchema = {
  type: "object" as const,
  required: ["name"] as const,
  properties: {
    name: { type: "string" as const, minLength: 1, maxLength: MAX_ALBUM_NAME_LENGTH },
  },
};

const errorResponse = {
  type: "object" as const,
  properties: {
    error: { type: "string" as const },
    message: { type: "string" as const },
  },
  required: ["error", "message"] as const,
};

const albumSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" as const },
    name: { type: "string" as const },
    generationIds: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    createdAt: { type: "string" as const, format: "date-time" },
    updatedAt: { type: "string" as const, format: "date-time" },
  },
  required: [
    "id",
    "name",
    "generationIds",
    "createdAt",
    "updatedAt",
  ] as const,
};

const albumWrappedResponse = {
  type: "object" as const,
  properties: { album: albumSchema },
  required: ["album"] as const,
};

const albumsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/",
    {
      schema: {
        tags: ["Albums"],
        summary: "Create a new album",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        body: nameBodySchema,
        response: {
          201: albumWrappedResponse,
          400: { ...errorResponse, description: "Invalid body" },
          401: { ...errorResponse, description: "Unauthorized" },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Internal error" },
        },
      },
      preHandler: [app.authenticate, albumWriteLimit],
    },
    createAlbumHandler,
  );

  app.get(
    "/",
    {
      schema: {
        tags: ["Albums"],
        summary: "List the caller's albums (newest updated first)",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        response: {
          200: {
            type: "object",
            properties: { albums: { type: "array", items: albumSchema } },
            required: ["albums"],
          },
          401: { ...errorResponse, description: "Unauthorized" },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Internal error" },
        },
      },
      preHandler: [app.authenticate, albumReadLimit],
    },
    listAlbumsHandler,
  );

  app.patch(
    "/:albumId",
    {
      schema: {
        tags: ["Albums"],
        summary: "Rename an album",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        params: albumIdParamsSchema,
        body: nameBodySchema,
        response: {
          200: albumWrappedResponse,
          400: { ...errorResponse, description: "Invalid body" },
          401: { ...errorResponse, description: "Unauthorized" },
          404: { ...errorResponse, description: "Album not found" },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Internal error" },
        },
      },
      preHandler: [app.authenticate, albumWriteLimit],
    },
    renameAlbumHandler,
  );

  app.delete(
    "/:albumId",
    {
      schema: {
        tags: ["Albums"],
        summary: "Delete an album (generations are not deleted)",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        params: albumIdParamsSchema,
        response: {
          204: { type: "null", description: "Deleted" },
          401: { ...errorResponse, description: "Unauthorized" },
          404: { ...errorResponse, description: "Album not found" },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Internal error" },
        },
      },
      preHandler: [app.authenticate, albumWriteLimit],
    },
    deleteAlbumHandler,
  );

  app.post(
    "/:albumId/generations",
    {
      schema: {
        tags: ["Albums"],
        summary: "Add a generation to an album (idempotent)",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        params: albumIdParamsSchema,
        body: generationBodySchema,
        response: {
          200: albumWrappedResponse,
          400: { ...errorResponse, description: "Invalid body" },
          401: { ...errorResponse, description: "Unauthorized" },
          404: {
            ...errorResponse,
            description: "Album or generation not found",
          },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Internal error" },
        },
      },
      preHandler: [app.authenticate, albumWriteLimit],
    },
    addGenerationToAlbumHandler,
  );

  app.delete(
    "/:albumId/generations/:generationId",
    {
      schema: {
        tags: ["Albums"],
        summary: "Remove a generation from an album (idempotent)",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        params: albumGenerationParamsSchema,
        response: {
          200: albumWrappedResponse,
          401: { ...errorResponse, description: "Unauthorized" },
          404: { ...errorResponse, description: "Album not found" },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Internal error" },
        },
      },
      preHandler: [app.authenticate, albumWriteLimit],
    },
    removeGenerationFromAlbumHandler,
  );
};

export default albumsRoutes;
