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
        summary: "Generate an interior design transformation",
        description:
          "Accepts a room photo URL, room type, and design style. Uses Replicate (primary) or fal.ai (fallback) to generate an AI-redesigned interior. Requires Firebase authentication and is rate-limited.",
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["imageUrl", "roomType", "designStyle"],
          properties: {
            imageUrl: {
              type: "string",
              format: "uri",
              description: "Public URL of the room photo to redesign (must use http or https scheme)",
              example: "https://example.com/room.jpg",
            },
            roomType: {
              type: "string",
              enum: roomTypes,
              description: "Type of room in the photo",
              example: "livingRoom",
            },
            designStyle: {
              type: "string",
              enum: designStyles,
              description: "Target design style for the transformation",
              example: "modern",
            },
          },
        },
        response: {
          200: {
            type: "object",
            description: "Design generation completed successfully",
            properties: {
              id: {
                type: "string",
                description: "Firestore generation record ID",
              },
              outputImageUrl: {
                type: "string",
                format: "uri",
                description: "URL of the AI-generated design image",
              },
              provider: {
                type: "string",
                enum: ["replicate", "falai"],
                description: "AI provider that generated the image",
              },
              durationMs: {
                type: "number",
                description: "Generation duration in milliseconds",
              },
            },
            required: ["id", "outputImageUrl", "provider", "durationMs"],
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
            description: "AI generation failed (timeout or provider error)",
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
        security: [{ bearerAuth: [] }],
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
                    toolType: { type: "string", description: "Tool type used", example: "interiorDesign" },
                    roomType: { type: "string", nullable: true, description: "Room type" },
                    designStyle: { type: "string", nullable: true, description: "Design style" },
                    inputImageUrl: { type: "string", description: "Original room photo URL" },
                    outputImageUrl: { type: "string", nullable: true, description: "Generated design URL" },
                    status: {
                      type: "string",
                      enum: ["pending", "completed", "failed"],
                      description: "Generation status",
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
