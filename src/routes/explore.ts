import type { FastifyPluginAsync } from "fastify";
import {
  getInspirationHandler,
  listInspirationsHandler,
  seedInspirationHandler,
} from "../controllers/explore.controller.js";
import { createRateLimitPreHandler } from "../lib/rate-limiter.js";
import {
  DESIGN_STYLE_VALUES,
  EXPLORE_DEFAULT_LIMIT,
  EXPLORE_MAX_LIMIT,
  INSPIRATION_KIND_VALUES,
  ROOM_TYPE_VALUES,
  TOOL_TYPE_VALUES,
} from "../lib/inspiration/types.js";
import { errorResponse, idPattern, inspirationSchema } from "./shared-schemas.js";

const exploreReadLimit = createRateLimitPreHandler("exploreRead");
const exploreSeedLimit = createRateLimitPreHandler("exploreSeed");

// Operational guard: the seed endpoint validates `imageUrl` against an
// env-built allow-list (CloudFront host + S3 bucket hostnames). When
// AWS_CLOUDFRONT_HOST is unset, every CloudFront-hosted URL is rejected
// with an opaque 400 — a deploy-time misconfiguration that an author
// experiences as a confusing rejection. Surface it loudly at boot.
function logSeedEnvWarningsIfNeeded(app: import("fastify").FastifyInstance) {
  if (!process.env.AWS_CLOUDFRONT_HOST) {
    app.log.warn(
      { event: "explore.seed.cloudfront_host_unset" },
      "AWS_CLOUDFRONT_HOST is not configured — POST /explore/inspirations will reject every CloudFront imageUrl with 'host not allowed'. Set the env var or only seed bucket-hosted URLs.",
    );
  }
}

const exploreRoutes: FastifyPluginAsync = async (app) => {
  logSeedEnvWarningsIfNeeded(app);

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

  app.post(
    "/inspirations",
    {
      schema: {
        tags: ["Explore"],
        summary:
          "Upsert one inspiration envelope (admin / seed). Image must already be uploaded; supply URL + dimensions.",
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "toolType",
            "designStyle",
            "imageUrl",
            "imageWidth",
            "imageHeight",
          ],
          properties: {
            id: { type: "string", pattern: idPattern },
            kind: { type: "string", enum: [...INSPIRATION_KIND_VALUES] },
            toolType: { type: "string", enum: [...TOOL_TYPE_VALUES] },
            designStyle: { type: "string", enum: [...DESIGN_STYLE_VALUES] },
            roomType: { type: ["string", "null"], minLength: 1, maxLength: 64 },
            buildingType: { type: ["string", "null"], minLength: 1, maxLength: 64 },
            gardenStyle: { type: ["string", "null"], minLength: 1, maxLength: 64 },
            patioStyle: { type: ["string", "null"], minLength: 1, maxLength: 64 },
            poolStyle: { type: ["string", "null"], minLength: 1, maxLength: 64 },
            outdoorLightingStyle: { type: ["string", "null"], minLength: 1, maxLength: 64 },
            colorPaletteId: { type: ["string", "null"], minLength: 1, maxLength: 64 },
            tags: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 40 },
              maxItems: 20,
            },
            featured: { type: "boolean" },
            imageUrl: { type: "string", format: "uri", maxLength: 2048 },
            imageWidth: { type: "integer", minimum: 1, maximum: 20000 },
            imageHeight: { type: "integer", minimum: 1, maximum: 20000 },
            imageMime: {
              type: "string",
              maxLength: 64,
              pattern: "^image/[a-zA-Z0-9.+-]+$",
            },
            prompt: { type: "string", minLength: 1, maxLength: 8000 },
          },
        },
        response: {
          200: {
            type: "object",
            description: "Existing inspiration upserted",
            properties: {
              id: { type: "string" },
              created: { type: "boolean" },
            },
            required: ["id", "created"],
          },
          201: {
            type: "object",
            description: "Inspiration created",
            headers: {
              Location: {
                type: "string",
                description: "Path of the newly created inspiration resource.",
              },
            },
            properties: {
              id: { type: "string" },
              created: { type: "boolean" },
            },
            required: ["id", "created"],
          },
          400: { ...errorResponse, description: "Invalid body" },
          401: { ...errorResponse, description: "Unauthorized" },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Internal error" },
        },
      },
      preHandler: [app.authenticate, exploreSeedLimit],
    },
    seedInspirationHandler,
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
