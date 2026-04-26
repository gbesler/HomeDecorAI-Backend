import type { FastifyPluginAsync } from "fastify";
import {
  getInspirationHandler,
  listInspirationsHandler,
} from "../controllers/explore.controller.js";
import { createRateLimitPreHandler } from "../lib/rate-limiter.js";
import {
  DESIGN_STYLE_VALUES,
  EXPLORE_DEFAULT_LIMIT,
  EXPLORE_MAX_LIMIT,
  ROOM_TYPE_VALUES,
  TOOL_TYPE_VALUES,
} from "../lib/inspiration/types.js";
import { errorResponse, idPattern, inspirationSchema } from "./shared-schemas.js";

const exploreReadLimit = createRateLimitPreHandler("exploreRead");

const exploreRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/inspirations",
    {
      schema: {
        tags: ["Explore"],
        summary:
          "List curated inspirations with optional filters and cursor pagination",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        querystring: {
          type: "object",
          properties: {
            roomType: { type: "string", enum: [...ROOM_TYPE_VALUES] },
            designStyle: { type: "string", enum: [...DESIGN_STYLE_VALUES] },
            toolType: { type: "string", enum: [...TOOL_TYPE_VALUES] },
            featuredOnly: { type: "string", enum: ["true", "false"] },
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
              items: { type: "array", items: inspirationSchema },
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
      preHandler: [app.authenticate, exploreReadLimit],
    },
    listInspirationsHandler,
  );

  app.get(
    "/inspirations/:inspirationId",
    {
      schema: {
        tags: ["Explore"],
        summary: "Fetch a single inspiration by id",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        params: {
          type: "object",
          required: ["inspirationId"],
          properties: {
            inspirationId: { type: "string", pattern: idPattern },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { inspiration: inspirationSchema },
            required: ["inspiration"],
          },
          400: { ...errorResponse, description: "Invalid id" },
          401: { ...errorResponse, description: "Unauthorized" },
          404: { ...errorResponse, description: "Inspiration not found" },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Internal error" },
        },
      },
      preHandler: [app.authenticate, exploreReadLimit],
    },
    getInspirationHandler,
  );
};

export default exploreRoutes;
