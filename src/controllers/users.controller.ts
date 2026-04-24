import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { registerFcmToken } from "../lib/notifications/token-store.js";

// FCM tokens are opaque strings but never huge — bound the body size to
// catch obviously wrong input early.
const RegisterFcmTokenBody = z.object({
  token: z.string().min(1).max(4096),
});

/**
 * POST /api/users/me/fcm-token
 *
 * Called by iOS when a fresh FCM registration token is issued (app launch,
 * token refresh). Writes to `users/{uid}.fcmTokens` via arrayUnion so the
 * push layer always picks up the most recent token without client-side
 * bookkeeping. Caller must be authenticated.
 */
export async function registerFcmTokenHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) {
    reply.code(401);
    return { error: "Unauthorized", message: "Authentication required" };
  }

  const parsed = RegisterFcmTokenBody.safeParse(request.body);
  if (!parsed.success) {
    reply.code(400);
    return {
      error: "Validation Error",
      message: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(", "),
    };
  }

  try {
    await registerFcmToken(userId, parsed.data.token);
    reply.code(204);
    return;
  } catch (err) {
    request.log.error(
      {
        event: "fcm.token.register_failed",
        userId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to register FCM token",
    );
    reply.code(500);
    return {
      error: "Internal Error",
      message: "Failed to register FCM token.",
    };
  }
}
