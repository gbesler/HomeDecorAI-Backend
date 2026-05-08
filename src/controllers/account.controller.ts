import type { FastifyRequest, FastifyReply } from "fastify";
import admin from "firebase-admin";
import { deleteUserData } from "../lib/account/cascade.js";

/**
 * `DELETE /api/account` handler.
 *
 * Order is load-bearing: cascade Firestore data first, then drop the auth
 * user. If we deleted the auth user first and the cascade failed, security
 * rules would block the client from retrying (the new ID token is gone),
 * leaving a half-deleted account no one can clean up.
 *
 * Idempotent: a retry after a half-completed run finds an empty user tree
 * and an `auth/user-not-found` error from `deleteUser`, both treated as
 * success.
 */
export async function deleteAccount(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const userId = request.userId;
  if (!userId) {
    reply.code(401);
    return { error: "Unauthorized", message: "Missing user identity." };
  }

  let generationsDeleted = 0;
  try {
    const result = await deleteUserData(userId);
    generationsDeleted = result.generationsDeleted;
  } catch (error) {
    request.log.error(
      { userId, error: error instanceof Error ? error.message : String(error) },
      "Account cascade failed",
    );
    reply.code(500);
    return {
      error: "Internal Error",
      message: "Failed to delete account data. Please retry.",
    };
  }

  try {
    await admin.auth().deleteUser(userId);
  } catch (error) {
    // `auth/user-not-found` means a previous attempt already removed the
    // auth record; the cascade we just ran was a no-op cleanup of any
    // residual Firestore data. Treat as success so retries converge.
    const code = (error as { code?: string } | null)?.code;
    if (code === "auth/user-not-found") {
      request.log.info(
        { userId, event: "account.auth_already_deleted" },
        "Auth user already deleted; cascade finished cleanup",
      );
    } else {
      request.log.error(
        {
          userId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to delete Firebase Auth user",
      );
      reply.code(500);
      return {
        error: "Internal Error",
        message: "Failed to delete auth user. Please retry.",
      };
    }
  }

  request.log.info(
    { userId, event: "account.deleted", generationsDeleted },
    "Account deleted",
  );

  return { success: true, generationsDeleted };
}
