import type { FastifyPluginAsync } from "fastify";
import {
  deleteFavoriteHandler,
  listFavoritesHandler,
  saveFavoriteHandler,
} from "../controllers/favorite-inspirations.controller.js";
import { createRateLimitPreHandler } from "../lib/rate-limiter.js";
import {
  EXPLORE_DEFAULT_LIMIT,
  EXPLORE_MAX_LIMIT,
} from "../lib/inspiration/types.js";
import { errorResponse, idPattern, inspirationSchema } from "./shared-schemas.js";

const favoriteWriteLimit = createRateLimitPreHandler("favoriteWrite");
const favoriteReadLimit = createRateLimitPreHandler("favoriteRead");

const favoriteRoutes: FastifyPluginAsync = async (app) => {
  app.put(
    "/:inspirationId",
    {
      schema: {
        tags: ["Favorites"],
        summary: "Save an inspiration to the caller's favorites (idempotent)",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        params: {
          type: "object",
          required: ["inspirationId"],
          properties: { inspirationId: { type: "string", pattern: idPattern } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              favorite: {
                type: "object",
                properties: {
                  inspirationId: { type: "string" },
                  savedAt: { type: "string", format: "date-time" },
                },
                required: ["inspirationId", "savedAt"],
              },
            },
            required: ["favorite"],
          },
          400: { ...errorResponse, description: "Invalid id" },
          401: { ...errorResponse, description: "Unauthorized" },
          404: { ...errorResponse, description: "Inspiration not found" },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Internal error" },
        },
      },
      preHandler: [app.authenticate, favoriteWriteLimit],
    },
    saveFavoriteHandler,
  );

  app.delete(
    "/:inspirationId",
    {
      schema: {
        tags: ["Favorites"],
        summary: "Remove an inspiration from the caller's favorites (idempotent)",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        params: {
          type: "object",
          required: ["inspirationId"],
          properties: { inspirationId: { type: "string", pattern: idPattern } },
        },
        response: {
          204: { type: "null", description: "Removed" },
          400: { ...errorResponse, description: "Invalid id" },
          401: { ...errorResponse, description: "Unauthorized" },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Internal error" },
        },
      },
      preHandler: [app.authenticate, favoriteWriteLimit],
    },
    deleteFavoriteHandler,
  );

  app.get(
    "/",
    {
      schema: {
        tags: ["Favorites"],
        summary: "List the caller's favorite inspirations (savedAt desc)",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        querystring: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: EXPLORE_MAX_LIMIT,
              default: EXPLORE_DEFAULT_LIMIT,
            },
            cursor: { type: "string", maxLength: 2048 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    inspiration: inspirationSchema,
                    savedAt: { type: "string", format: "date-time" },
                  },
                  required: ["inspiration", "savedAt"],
                },
              },
              nextCursor: { type: ["string", "null"] },
            },
            required: ["items", "nextCursor"],
          },
          400: { ...errorResponse, description: "Invalid query" },
          401: { ...errorResponse, description: "Unauthorized" },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Internal error" },
        },
      },
      preHandler: [app.authenticate, favoriteReadLimit],
    },
    listFavoritesHandler,
  );
};

export default favoriteRoutes;
