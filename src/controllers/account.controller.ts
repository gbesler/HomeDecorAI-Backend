import type { FastifyRequest, FastifyReply } from "fastify";
import admin from "firebase-admin";
import {
  CascadeDeadlineExceededError,
  deleteUserData,
} from "../lib/account/cascade.js";

/// Reauth freshness window. Firebase ID tokens live for ~1 hour, but
/// `auth_time` records when the user last actually authenticated; we
/// require that to be within this window before accepting an irreversible
/// account deletion. Without this check, a token stolen days ago (still
/// inside its 1h validity, refreshable indefinitely from the refresh
/// token) could wipe an account in one call. 30 minutes is a generous
/// envelope: a user who just signed up or signed in is well inside it; a
/// dormant token from a compromised device is not.
const REAUTH_FRESHNESS_SECONDS = 30 * 60;

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

  // Re-verify the ID token specifically for this destructive endpoint.
  // The shared `app.authenticate` middleware does NOT pass `checkRevoked`,
  // so a token belonging to an admin-revoked session would still pass
  // there. Re-verify here with `checkRevoked: true` AND inspect
  // `auth_time` to require a recent reauthentication.
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    reply.code(401);
    return { error: "Unauthorized", message: "Missing bearer token." };
  }
  const token = authHeader.slice(7);
  let decodedToken: admin.auth.DecodedIdToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(token, true);
  } catch (error) {
    request.log.warn(
      { userId, error: error instanceof Error ? error.message : String(error) },
      "Account delete rejected: token revoked or invalid",
    );
    reply.code(401);
    return {
      error: "Unauthorized",
      message: "Token has been revoked. Sign in again to continue.",
    };
  }
  if (decodedToken.uid !== userId) {
    // Defence in depth: middleware already pinned `request.userId` to
    // the same token's uid, but a future change that decoupled them
    // could let a request smuggle a different uid through. Reject.
    reply.code(401);
    return { error: "Unauthorized", message: "Token uid mismatch." };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const authAge = nowSeconds - decodedToken.auth_time;
  if (authAge > REAUTH_FRESHNESS_SECONDS) {
    request.log.info(
      { userId, authAge, threshold: REAUTH_FRESHNESS_SECONDS },
      "Account delete rejected: stale auth_time",
    );
    reply.code(401);
    return {
      error: "ReauthRequired",
      message:
        "Please sign in again before deleting your account. " +
        "For your security, deletion requires a recent sign-in.",
    };
  }

  // Cascade Firestore.
  let generationsDeleted = 0;
  try {
    const result = await deleteUserData(userId);
    generationsDeleted = result.generationsDeleted;
  } catch (error) {
    if (error instanceof CascadeDeadlineExceededError) {
      // The cascade is idempotent — partial progress was made and the
      // remaining docs will be drained on the next call. Surface a 503
      // with a Retry-After hint so the client can resume cleanly without
      // colliding with our rate limit.
      request.log.warn(
        { userId, generationsDeleted: error.generationsDeleted },
        "Account cascade hit deadline; client should retry",
      );
      reply.header("Retry-After", "5");
      reply.code(503);
      return {
        error: "ServiceUnavailable",
        message: "Account deletion is taking longer than expected. Please retry.",
      };
    }
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

  // Drop Firebase Auth user.
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
