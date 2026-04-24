import type { FastifyPluginAsync } from "fastify";
import { registerFcmTokenHandler } from "../controllers/users.controller.js";

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
          "Stores an FCM registration token on the authenticated user's document so the backend can deliver push notifications for async generation events. Called by iOS on launch and on token refresh. Idempotent — repeat calls with the same token are no-ops.",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        body: {
          type: "object",
          required: ["token"],
          properties: {
            token: {
              type: "string",
              description: "FCM registration token issued by FirebaseMessaging",
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
};

export default usersRoutes;
