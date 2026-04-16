import type { FastifyPluginAsync } from "fastify";
import { createRateLimitPreHandler } from "../lib/rate-limiter.js";
import {
  getHistory,
  makeCreateGenerationHandler,
  makeSyncGenerationHandler,
} from "../controllers/design.controller.js";
import { TOOL_TYPES, type ToolTypeConfig } from "../lib/tool-types.js";

// ─── Shared response schemas (hoisted to avoid per-route duplication) ──────

const errorResponse = {
  type: "object" as const,
  properties: {
    error: { type: "string" as const },
    message: { type: "string" as const },
  },
  required: ["error", "message"] as const,
};

const enqueueResponseSchemas = {
  202: {
    type: "object" as const,
    description: "Generation accepted and enqueued",
    properties: {
      generationId: {
        type: "string" as const,
        description: "Firestore document ID for real-time listener",
      },
      status: {
        type: "string" as const,
        enum: ["queued"] as const,
        description: "Initial lifecycle status",
      },
    },
    required: ["generationId", "status"] as const,
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
    type: "object" as const,
    description: "Rate limit exceeded",
    properties: {
      error: { type: "string" as const },
      message: { type: "string" as const },
      retryAfterMs: {
        type: "number" as const,
        description: "Milliseconds until the rate limit resets",
      },
    },
    required: ["error", "message"] as const,
  },
  500: {
    ...errorResponse,
    description: "Failed to create the queued generation record",
  },
  503: {
    ...errorResponse,
    description: "Failed to enqueue the Cloud Tasks job",
  },
};

// Temporary sync endpoint response schemas. Sync variants return the fully
// processed generation in a single response — 200 with outputImageUrl, or
// 502 with a structured failure. Keep separate from `enqueueResponseSchemas`
// so removing the sync routes is a self-contained revert.
const syncResponseSchemas = {
  200: {
    type: "object" as const,
    description: "Generation completed synchronously",
    properties: {
      generationId: { type: "string" as const },
      status: {
        type: "string" as const,
        enum: ["completed"] as const,
      },
      outputImageUrl: { type: "string" as const, nullable: true },
      outputImageCDNUrl: {
        type: "string" as const,
        nullable: true,
        description:
          "CloudFront-fronted URL for the same object as outputImageUrl. Null when CloudFront is not configured.",
      },
      provider: { type: "string" as const, nullable: true },
      durationMs: { type: "number" as const, nullable: true },
      toolType: { type: "string" as const },
    },
    required: ["generationId", "status", "toolType"] as const,
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
    type: "object" as const,
    description: "Rate limit exceeded",
    properties: {
      error: { type: "string" as const },
      message: { type: "string" as const },
      retryAfterMs: { type: "number" as const },
    },
    required: ["error", "message"] as const,
  },
  500: {
    ...errorResponse,
    description: "Internal error during sync generation",
  },
  502: {
    type: "object" as const,
    description: "Upstream (AI provider or storage) failure",
    properties: {
      generationId: { type: "string" as const },
      status: { type: "string" as const, enum: ["failed"] as const },
      errorCode: { type: "string" as const },
      errorMessage: { type: "string" as const },
    },
    required: ["generationId", "status", "errorCode", "errorMessage"] as const,
  },
};

const historyResponseSchemas = {
  200: {
    type: "object" as const,
    description: "Generation history retrieved successfully",
    properties: {
      generations: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const, description: "Generation record ID" },
            toolType: { type: "string" as const, description: "Tool type used" },
            roomType: {
              type: "string" as const,
              nullable: true,
              description: "Legacy interior-only room type mirror",
            },
            designStyle: {
              type: "string" as const,
              nullable: true,
              description: "Legacy interior-only design style mirror",
            },
            toolParams: {
              type: "object" as const,
              additionalProperties: true,
              nullable: true,
              description:
                "Tool-agnostic parameters blob — carries exterior/garden/future-tool fields",
            },
            inputImageUrl: {
              type: "string" as const,
              description: "Original input photo URL",
            },
            outputImageUrl: {
              type: "string" as const,
              nullable: true,
              description: "Generated image URL (native S3)",
            },
            outputImageCDNUrl: {
              type: "string" as const,
              nullable: true,
              description:
                "CloudFront-fronted URL for the same object as outputImageUrl. Null on legacy records or deploys without CloudFront.",
            },
            status: {
              type: "string" as const,
              enum: [
                "pending",
                "queued",
                "processing",
                "completed",
                "failed",
              ] as const,
              description: "Generation lifecycle status",
            },
            provider: {
              type: "string" as const,
              description: "AI provider used",
            },
            durationMs: {
              type: "number" as const,
              nullable: true,
              description: "Generation duration in ms",
            },
            createdAt: {
              type: "string" as const,
              nullable: true,
              format: "date-time",
              description: "ISO 8601 timestamp",
            },
          },
          required: [
            "id",
            "toolType",
            "inputImageUrl",
            "status",
            "provider",
          ] as const,
        },
      },
    },
    required: ["generations"] as const,
  },
  400: { ...errorResponse, description: "Invalid limit parameter" },
  401: {
    ...errorResponse,
    description: "Missing, invalid, or expired Firebase token",
  },
  403: { ...errorResponse, description: "Invalid User-Agent header" },
  500: { ...errorResponse, description: "Failed to fetch generation history" },
};

// ─── Routes ────────────────────────────────────────────────────────────────

const designRoutes: FastifyPluginAsync = async (app) => {
  // Registry-driven enqueue routes. Adding a new tool is a config-only change:
  // register it in `TOOL_TYPES` and this loop produces the route.
  //
  // Widened iteration type: `Object.values(TOOL_TYPES)` narrows to the first
  // entry's parameter shape, but at the route layer we don't need per-tool
  // param types — the handler closure carries them internally.
  const tools: ReadonlyArray<ToolTypeConfig<unknown>> = Object.values(
    TOOL_TYPES,
  ) as unknown as ReadonlyArray<ToolTypeConfig<unknown>>;
  for (const tool of tools) {
    app.post(
      tool.routePath,
      {
        schema: {
          tags: ["Design"],
          summary: tool.summary,
          description: tool.description,
          security: [{ bearerAuth: [] }, { apiKey: [] }],
          body: tool.bodyJsonSchema,
          response: enqueueResponseSchemas,
        },
        preHandler: [
          app.authenticate,
          createRateLimitPreHandler(tool.rateLimitKey),
        ],
      },
      makeCreateGenerationHandler(tool),
    );

    // Temporary sync variant for manual testing of tool features. Shares
    // validation, Firestore, AI, and S3 pipeline with the async path but
    // blocks the request until processing completes. Remove alongside
    // `makeSyncGenerationHandler` when done testing.
    app.post(
      `${tool.routePath}/sync`,
      {
        schema: {
          tags: ["Design", "Sync (Testing Only)"],
          summary: `${tool.summary} (SYNC — test only)`,
          description:
            "Temporary sync variant of the async tool endpoint for testing. " +
            "Blocks until AI generation and S3 upload finish, then returns the final outputImageUrl.",
          security: [{ bearerAuth: [] }, { apiKey: [] }],
          body: tool.bodyJsonSchema,
          response: syncResponseSchemas,
        },
        preHandler: [
          app.authenticate,
          createRateLimitPreHandler(tool.rateLimitKey),
        ],
      },
      makeSyncGenerationHandler(tool),
    );
  }

  app.get(
    "/history",
    {
      schema: {
        tags: ["Design"],
        summary: "Get generation history",
        description:
          "Returns the authenticated user's past generations across all tools, ordered by creation date (newest first).",
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
        response: historyResponseSchemas,
      },
      preHandler: [app.authenticate],
    },
    getHistory,
  );
};

export default designRoutes;
