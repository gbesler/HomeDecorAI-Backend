import type { FastifyPluginAsync } from "fastify";
import { processGenerationHandler } from "../controllers/internal.controller.js";

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
};

export default internalRoutes;
