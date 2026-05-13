import type { FastifyPluginAsync } from "fastify";
import { deleteAccount } from "../controllers/account.controller.js";
import { createRateLimitPreHandler } from "../lib/rate-limiter.js";

const errorResponse = {
  type: "object" as const,
  properties: {
    error: { type: "string" as const },
    message: { type: "string" as const },
  },
  required: ["error", "message"] as const,
};

const accountRoutes: FastifyPluginAsync = async (app) => {
  app.delete(
    "/",
    {
      schema: {
        tags: ["Account"],
        summary: "Delete the authenticated user's account",
        description:
          "Cascades the entire Firestore tree owned by the caller " +
          "(`users/{uid}` and subcollections plus every `generations/*` doc " +
          "with `userId == uid`) and removes the Firebase Auth user. " +
          "Idempotent — retrying after a partial failure converges on a " +
          "fully deleted account.",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        response: {
          200: {
            type: "object" as const,
            description: "Account deleted",
            properties: {
              success: { type: "boolean" as const },
              generationsDeleted: {
                type: "number" as const,
                description: "Number of `generations/*` docs removed",
              },
            },
            required: ["success", "generationsDeleted"] as const,
          },
          401: {
            ...errorResponse,
            description:
              "Missing/invalid token, revoked session, or stale auth_time. " +
              "When `error == \"ReauthRequired\"`, the client should " +
              "reauthenticate (e.g., re-prompt for password / Apple / " +
              "Google) before retrying.",
          },
          429: { ...errorResponse, description: "Rate limit exceeded" },
          500: { ...errorResponse, description: "Failed to delete account" },
          503: {
            ...errorResponse,
            description:
              "Cascade hit its deadline; the cascade is idempotent so the " +
              "client should retry after the `Retry-After` interval.",
          },
        },
      },
      preHandler: [
        app.authenticate,
        createRateLimitPreHandler("deleteAccount"),
      ],
    },
    deleteAccount,
  );
};

export default accountRoutes;
