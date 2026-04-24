import type { FastifyPluginAsync } from "fastify";
import { processGenerationHandler } from "../controllers/internal.controller.js";
import { campaignFireHandler } from "../controllers/campaign.controller.js";

/**
 * Internal routes invoked by Cloud Tasks (or other trusted backends).
 *
 * This plugin deliberately does NOT use the global Firebase auth decorator.
 * Instead each route attaches `verifyCloudTask` which validates an OIDC
 * bearer token signed by Google for our service account.
 *
 * Register this plugin under a distinct prefix (`/internal`) so it's obvious
 * in logs and can be firewalled separately from `/api/*` if needed.
 */
const internalRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/process-generation",
    {
      // Swagger intentionally omitted — this endpoint is not part of the
      // public surface and should not appear in `/docs`.
      schema: {
        hide: true,
        body: {
          type: "object",
          required: ["generationId"],
          properties: {
            generationId: { type: "string" },
          },
        },
      },
      preHandler: [app.verifyCloudTask],
    },
    processGenerationHandler,
  );

  app.post(
    "/notifications/campaign-fire",
    {
      schema: {
        hide: true,
        body: {
          type: "object",
          required: ["userId", "day"],
          properties: {
            userId: { type: "string" },
            day: {
              type: "integer",
              enum: [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14],
            },
          },
        },
      },
      preHandler: [app.verifyCloudTask],
    },
    campaignFireHandler,
  );
};

export default internalRoutes;
