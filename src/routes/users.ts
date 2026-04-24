import type { FastifyPluginAsync } from "fastify";
import {
  registerFcmTokenHandler,
  updatePremiumStateHandler,
} from "../controllers/users.controller.js";

const errorResponse = {
  type: "object" as const,
  properties: {
    error: { type: "string" as const },
    message: { type: "string" as const },
  },
  required: ["error", "message"] as const,
};

const usersRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/me/fcm-token",
    {
      schema: {
        tags: ["Users"],
        summary: "Register or refresh the caller's FCM device token",
        description:
          "Stores an FCM registration token on the authenticated user's document so the backend can deliver push notifications for async generation events. Called by iOS on launch and on token refresh. Idempotent — repeat calls with the same token are no-ops. Optional `timezone` and `language` fields are persisted for notification-slot localization.",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        body: {
          type: "object",
          required: ["token"],
          properties: {
            token: {
              type: "string",
              description: "FCM registration token issued by FirebaseMessaging",
            },
            timezone: {
              type: "string",
              description: "IANA timezone identifier, e.g. Europe/Istanbul",
            },
            language: {
              type: "string",
              enum: ["tr", "en"],
              description: "Preferred notification language",
            },
          },
        },
        response: {
          204: {
            type: "null",
            description: "Token registered",
          },
          400: { ...errorResponse, description: "Invalid body" },
          401: { ...errorResponse, description: "Missing or invalid auth token" },
          403: { ...errorResponse, description: "Invalid User-Agent header" },
          500: { ...errorResponse, description: "Failed to persist token" },
        },
      },
      preHandler: [app.authenticate],
    },
    registerFcmTokenHandler,
  );

  app.patch(
    "/me/premium-state",
    {
      schema: {
        tags: ["Users"],
        summary: "Report the caller's premium entitlement state",
        description:
          "Called by iOS when the RevenueCat entitlement listener observes a change. The backend uses this flag to gate pre-purchase notification campaign dispatch.",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        body: {
          type: "object",
          required: ["isPremium"],
          properties: {
            isPremium: { type: "boolean" },
            productId: { type: ["string", "null"] },
            expiresAt: {
              type: ["number", "null"],
              multipleOf: 1,
              minimum: 0,
              description: "Epoch milliseconds; null clears the field",
            },
          },
        },
        response: {
          204: { type: "null", description: "State recorded" },
          400: { ...errorResponse, description: "Invalid body" },
          401: { ...errorResponse, description: "Missing or invalid auth token" },
          403: { ...errorResponse, description: "Invalid User-Agent header" },
          500: { ...errorResponse, description: "Failed to persist state" },
        },
      },
      preHandler: [app.authenticate],
    },
    updatePremiumStateHandler,
  );
};

export default usersRoutes;
