import type { FastifyPluginAsync } from "fastify";
import { createRateLimitPreHandler } from "../lib/rate-limiter.js";
import {
  createInteriorDesign,
  getHistory,
} from "../controllers/design.controller.js";

const errorResponse = {
  type: "object" as const,
  properties: {
    error: { type: "string" as const },
    message: { type: "string" as const },
  },
  required: ["error", "message"] as const,
};

const roomTypes = [
  "livingRoom",
  "bedroom",
  "kitchen",
  "underStairSpace",
  "diningRoom",
  "bathroom",
  "entryway",
  "stairway",
  "office",
  "homeOffice",
  "studyRoom",
  "gamingRoom",
] as const;

const designStyles = [
  "modern",
  "minimalist",
  "scandinavian",
  "industrial",
  "bohemian",
  "contemporary",
  "midCentury",
  "coastal",
  "farmhouse",
  "japandi",
  "artDeco",
  "traditional",
  "tropical",
  "rustic",
  "luxury",
  "cozy",
  "christmas",
  "airbnb",
] as const;

const designRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/interior",
    {
      schema: {
        tags: ["Design"],
        summary: "Enqueue an interior design transformation",
        description:
          "Accepts a room photo URL, room type, and design style. Creates a generation record and enqueues an async Cloud Tasks job that generates the design with Replicate (primary) or fal.ai (fallback), uploads to S3, and notifies the client via Firestore listener + FCM push. Returns 202 with a generationId; the client subscribes to `generations/{generationId}` for status updates.",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        body: {
          type: "object",
          required: ["imageUrl", "roomType", "designStyle"],
          properties: {
            imageUrl: {
              type: "string",
              format: "uri",
              description: "Public URL of the room photo to redesign (must use http or https scheme)",
            },
            roomType: {
              type: "string",
              enum: roomTypes,
              description: "Type of room in the photo",
            },
            designStyle: {
              type: "string",
              enum: designStyles,
              description: "Target design style for the transformation",
            },
            language: {
              type: "string",
              enum: ["tr", "en"],
              description:
                "Optional UI language snapshot for FCM push notifications. If omitted, backend falls back to Accept-Language header, then `en`.",
            },
          },
        },
        response: {
          202: {
            type: "object",
            description: "Generation accepted and enqueued",
            properties: {
              generationId: {
                type: "string",
                description: "Firestore document ID for real-time listener",
              },
              status: {
                type: "string",
                enum: ["queued"],
                description: "Initial lifecycle status",
              },
            },
            required: ["generationId", "status"],
          },
          400: {
            ...errorResponse,
            description: "Validation error (invalid body or imageUrl scheme)",
          },
          401: {
            ...errorResponse,
            description: "Missing, invalid, or expired Firebase token",
          },
          403: {
            ...errorResponse,
            description: "Invalid User-Agent header (must be HomeDecorAI/*)",
          },
          429: {
            type: "object",
            description: "Rate limit exceeded",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
              retryAfterMs: {
                type: "number",
                description: "Milliseconds until the rate limit resets",
              },
            },
            required: ["error", "message"],
          },
          500: {
            ...errorResponse,
            description: "Failed to create the queued generation record",
          },
          503: {
            ...errorResponse,
            description: "Failed to enqueue the Cloud Tasks job",
          },
        },
      },
      preHandler: [
        app.authenticate,
        createRateLimitPreHandler("interiorDesign"),
      ],
    },
    createInteriorDesign,
  );

  app.get(
    "/history",
    {
      schema: {
        tags: ["Design"],
        summary: "Get generation history",
        description:
          "Returns the authenticated user's past interior design generations, ordered by creation date (newest first).",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        querystring: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 50,
              description: "Maximum number of history items to return",
            },
          },
        },
        response: {
          200: {
            type: "object",
            description: "Generation history retrieved successfully",
            properties: {
              generations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Generation record ID" },
                    toolType: { type: "string", description: "Tool type used" },
                    roomType: { type: "string", nullable: true, description: "Room type" },
                    designStyle: { type: "string", nullable: true, description: "Design style" },
                    inputImageUrl: { type: "string", description: "Original room photo URL" },
                    outputImageUrl: { type: "string", nullable: true, description: "Generated design URL" },
                    status: {
                      type: "string",
                      enum: ["pending", "queued", "processing", "completed", "failed"],
                      description: "Generation lifecycle status",
                    },
                    provider: { type: "string", description: "AI provider used" },
                    durationMs: { type: "number", nullable: true, description: "Generation duration in ms" },
                    createdAt: { type: "string", nullable: true, format: "date-time", description: "ISO 8601 timestamp" },
                  },
                  required: ["id", "toolType", "inputImageUrl", "status", "provider"],
                },
              },
            },
            required: ["generations"],
          },
          400: {
            ...errorResponse,
            description: "Invalid limit parameter",
          },
          401: {
            ...errorResponse,
            description: "Missing, invalid, or expired Firebase token",
          },
          403: {
            ...errorResponse,
            description: "Invalid User-Agent header",
          },
          500: {
            ...errorResponse,
            description: "Failed to fetch generation history",
          },
        },
      },
      preHandler: [app.authenticate],
    },
    getHistory,
  );
};

export default designRoutes;
