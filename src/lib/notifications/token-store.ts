import admin from "firebase-admin";
import { logger } from "../logger.js";
import type { SupportedLanguage } from "../generation/types.js";

/**
 * Per-user FCM token store backed by `users/{uid}.fcmTokens` array.
 *
 * Tokens are stored as an array (not map) because FCM tokens themselves are
 * opaque strings — the only operation we need is set-membership and removal.
 * We use Firestore arrayUnion/arrayRemove to avoid read-modify-write races
 * across concurrent device registrations.
 */

const USERS_COLLECTION = "users";

function getFirestore(): admin.firestore.Firestore {
  return admin.firestore();
}

export interface RegisterFcmTokenOptions {
  timezone?: string;
  language?: SupportedLanguage;
}

/**
 * Register (or re-register) an FCM token for a user. Safe to call on every
 * app launch — arrayUnion dedupes.
 *
 * When `timezone` or `language` are provided, they are persisted onto the
 * user doc so the campaign scheduler and dispatch layers can localize
 * content and slot timing without making a second round-trip.
 */
export async function registerFcmToken(
  userId: string,
  token: string,
  options: RegisterFcmTokenOptions = {},
): Promise<void> {
  const db = getFirestore();
  const payload: Record<string, unknown> = {
    fcmTokens: admin.firestore.FieldValue.arrayUnion(token),
    fcmTokensUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (options.timezone) payload["timezone"] = options.timezone;
  if (options.language) payload["language"] = options.language;

  await db
    .collection(USERS_COLLECTION)
    .doc(userId)
    .set(payload, { merge: true });

  logger.info(
    { event: "fcm.token.registered", userId, tokenSuffix: token.slice(-8) },
    "FCM token registered",
  );
}

/**
 * Remove a list of tokens from a user's token array. Used by the FCM layer
 * after a multicast response reports invalid/not-registered tokens.
 */
export async function removeFcmTokens(
  userId: string,
  tokens: readonly string[],
): Promise<void> {
  if (tokens.length === 0) return;
  const db = getFirestore();
  await db
    .collection(USERS_COLLECTION)
    .doc(userId)
    .update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokens),
    })
    .catch((err) => {
      // Not fatal — the user doc may not exist yet. Log and continue.
      logger.warn(
        {
          event: "fcm.token.remove_failed",
          userId,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to remove FCM tokens",
      );
    });
}

/** Read all FCM tokens currently registered for a user. */
export async function getFcmTokens(userId: string): Promise<string[]> {
  const db = getFirestore();
  const snap = await db.collection(USERS_COLLECTION).doc(userId).get();
  if (!snap.exists) return [];
  const data = snap.data() ?? {};
  const raw = data["fcmTokens"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string" && t.length > 0);
}
