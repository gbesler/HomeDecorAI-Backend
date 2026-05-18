import type { FastifyPluginAsync } from "fastify";

import {
  bulkSeedObjectInspirationsHandler,
  bulkUpdateObjectInspirationTitlesHandler,
} from "../controllers/objectInspiration.controller.js";
import { createRateLimitPreHandler } from "../lib/rate-limiter.js";
import { errorResponse } from "./shared-schemas.js";

const objectInspirationSeedLimit = createRateLimitPreHandler(
  "objectInspirationSeed",
);

/** Operational guard mirroring `explore.ts`: per-row `imageUrl` validation
 *  uses the same `isAllowedInspirationUrl` allow-list, which silently
 *  rejects every CloudFront-hosted URL when `AWS_CLOUDFRONT_HOST` is unset.
 *  Surface that loudly at boot rather than letting authors hit a confusing
 *  per-row 400. */
function logSeedEnvWarningsIfNeeded(app: import("fastify").FastifyInstance) {
  if (!process.env.AWS_CLOUDFRONT_HOST) {
    app.log.warn(
      { event: "objectInspirationSeed.cloudfront_host_unset" },
      "AWS_CLOUDFRONT_HOST is not configured — POST /object-inspirations/bulk-seed will reject every CloudFront imageUrl with 'host not allowed'. Set the env var or only seed bucket-hosted URLs.",
    );
  }
}

/** Per-row issue shape returned alongside 400 validation envelopes. */
const seedIssueSchema = {
  type: "object" as const,
  properties: {
    kind: { type: "string" as const, enum: ["category", "item"] as const },
    id: { type: "string" as const },
    message: { type: "string" as const },
  },
  required: ["kind", "id", "message"] as const,
};

/** Per-row outcome shape returned in the 200 summary response. */
const seedOutcomeSchema = {
  type: "object" as const,
  properties: {
    kind: { type: "string" as const, enum: ["category", "item"] as const },
    id: { type: "string" as const },
    status: {
      type: "string" as const,
      enum: ["created", "updated", "skipped", "failed"] as const,
    },
    reason: { type: "string" as const },
    ts: { type: "string" as const },
  },
  required: ["kind", "id", "status", "ts"] as const,
};

const seedSummarySchema = {
  type: "object" as const,
  properties: {
    total: { type: "integer" as const },
    created: { type: "integer" as const },
    updated: { type: "integer" as const },
    skipped: { type: "integer" as const },
    failed: { type: "integer" as const },
  },
  required: ["total", "created", "updated", "skipped", "failed"] as const,
};

const objectInspirationsRoutes: FastifyPluginAsync = async (app) => {
  logSeedEnvWarningsIfNeeded(app);

  app.post(
    "/bulk-seed",
    {
      schema: {
        tags: ["Object Inspirations"],
        summary:
          "Bulk-seed object-inspiration catalog. Body matches the offline manifest format ({categories?, items?}).",
        description:
          "Accepts the same manifest the offline seed script consumes. Both `categories` and `items` are optional but at least one must be present, so operators can update them independently. When `items` references a categoryId not inlined in `categories`, the foreign-key check falls back to a Firestore lookup. Per-row validation uses the same zod schemas. Set `X-Seed-Mode: overwrite` to replace existing prompts on re-seed; absent/other values preserve them.",
        security: [{ bearerAuth: [] }],
        headers: {
          type: "object",
          properties: {
            "x-seed-mode": {
              type: "string",
              description:
                "Set to 'overwrite' to replace existing prompts on re-seed. Absent or any other value preserves existing prompts.",
            },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            // Outer-array caps + element shape gates run at the Fastify layer;
            // per-field validation runs in zod inside the handler. Limits are
            // sized for the documented design ceiling (40 categories × 20 items
            // = 800 items) with headroom so a content team isn't blocked by a
            // tight cap, but a runaway/abusive payload is rejected before it
            // can fan out 5,000+ Firestore transactions.
            categories: {
              type: "array",
              maxItems: 200,
              items: { type: "object" },
            },
            items: {
              type: "array",
              maxItems: 5000,
              items: { type: "object" },
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              summary: seedSummarySchema,
              outcomes: { type: "array", items: seedOutcomeSchema },
            },
            required: ["summary", "outcomes"],
          },
          400: {
            type: "object",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
              issues: { type: "array", items: seedIssueSchema },
            },
            required: ["error", "message"],
          },
          401: { ...errorResponse, description: "Unauthorized" },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Internal error" },
        },
      },
      preHandler: [app.authenticate, objectInspirationSeedLimit],
    },
    bulkSeedObjectInspirationsHandler,
  );

  app.post(
    "/bulk-update-titles",
    {
      schema: {
        tags: ["Object Inspirations"],
        summary:
          "Bulk-update only the localized `title` field on existing object-inspiration items.",
        description:
          "Title-only ops path: patches `title.{en,tr}` on existing items, leaving prompt/image/order/active/categoryId untouched. Missing items report `failed` (no upsert) — use POST /bulk-seed for new rows.",
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["titleUpdates"],
          properties: {
            titleUpdates: {
              type: "array",
              maxItems: 5000,
              items: { type: "object" },
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              summary: seedSummarySchema,
              outcomes: { type: "array", items: seedOutcomeSchema },
            },
            required: ["summary", "outcomes"],
          },
          400: {
            type: "object",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
              issues: { type: "array", items: seedIssueSchema },
            },
            required: ["error", "message"],
          },
          401: { ...errorResponse, description: "Unauthorized" },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Internal error" },
        },
      },
      preHandler: [app.authenticate, objectInspirationSeedLimit],
    },
    bulkUpdateObjectInspirationTitlesHandler,
  );
};

export default objectInspirationsRoutes;
