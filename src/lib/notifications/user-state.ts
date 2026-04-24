import admin from "firebase-admin";
import { logger } from "../logger.js";
import type { SupportedLanguage } from "../generation/types.js";

const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ["tr", "en"];

function isSupportedLanguage(v: unknown): v is SupportedLanguage {
  return (
    typeof v === "string" &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(v)
  );
}

/**
 * User-document helpers for notification-campaign concerns:
 * premium state (gate) and pre-launch campaign scheduling stamp.
 *
 * Lives under `notifications/` because both pieces exist only to support
 * the push-notification subsystem — premium to gate dispatch, campaign
 * stamp to guarantee one-time scheduling per user.
 */

const USERS_COLLECTION = "users";

function getFirestore(): admin.firestore.Firestore {
  return admin.firestore();
}

export interface UpdatePremiumStateInput {
  userId: string;
  isPremium: boolean;
  productId?: string | null;
  expiresAt?: number | null; // epoch ms
}

export async function updatePremiumState(
  input: UpdatePremiumStateInput,
): Promise<void> {
  const { userId, isPremium, productId, expiresAt } = input;
  const db = getFirestore();
  const payload: Record<string, unknown> = {
    isPremium,
    premiumUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (productId !== undefined) payload["premiumProductId"] = productId;
  if (expiresAt !== undefined) {
    payload["premiumExpiresAt"] =
      expiresAt === null ? null : admin.firestore.Timestamp.fromMillis(expiresAt);
  }

  await db.collection(USERS_COLLECTION).doc(userId).set(payload, { merge: true });

  logger.info(
    { event: "premium.state.updated", userId, isPremium },
    "Premium state updated",
  );
}

export async function isUserPremium(userId: string): Promise<boolean> {
  const db = getFirestore();
  const snap = await db.collection(USERS_COLLECTION).doc(userId).get();
  if (!snap.exists) return false;
  const data = snap.data() ?? {};
  return data["isPremium"] === true;
}

export interface UserCampaignContext {
  tokens: string[];
  isPremium: boolean;
  language: SupportedLanguage | null;
  timezone: string | null;
  preLaunchScheduledAt: admin.firestore.Timestamp | null;
}

export async function getUserCampaignContext(
  userId: string,
): Promise<UserCampaignContext | null> {
  const db = getFirestore();
  const snap = await db.collection(USERS_COLLECTION).doc(userId).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};

  const tokensRaw = data["fcmTokens"];
  const tokens = Array.isArray(tokensRaw)
    ? tokensRaw.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];

  const language = isSupportedLanguage(data["language"]) ? data["language"] : null;

  const timezone =
    typeof data["timezone"] === "string" ? data["timezone"] : null;

  // Runtime-guard the nested map. If a future migration writes a different
  // shape, the guard rejects it rather than letting a bad value flow into
  // the idempotency check.
  const preLaunchRaw = data["preLaunchCampaign"];
  const scheduledAt =
    preLaunchRaw !== null &&
    typeof preLaunchRaw === "object" &&
    "scheduledAt" in preLaunchRaw &&
    preLaunchRaw.scheduledAt instanceof admin.firestore.Timestamp
      ? preLaunchRaw.scheduledAt
      : null;

  return {
    tokens,
    isPremium: data["isPremium"] === true,
    language,
    timezone,
    preLaunchScheduledAt: scheduledAt,
  };
}

/**
 * Write the initial scheduling stamp.
 *
 * Both this function and `recordCampaignFire` write into the same
 * `preLaunchCampaign` map with `{ merge: true }`. Firestore deep-merges
 * nested maps under merge:true, so sibling keys (e.g., `scheduledAt`
 * written here, `lastFiredDay` written by `recordCampaignFire`) coexist
 * across calls. Switching to `update()` without dot-notation, or to
 * `set()` without merge, would destroy the idempotency stamp — do not.
 */
export async function markPreLaunchCampaignScheduled(
  userId: string,
  days: readonly number[],
): Promise<void> {
  const db = getFirestore();
  await db
    .collection(USERS_COLLECTION)
    .doc(userId)
    .set(
      {
        preLaunchCampaign: {
          scheduledAt: admin.firestore.FieldValue.serverTimestamp(),
          version: 1,
          days,
        },
      },
      { merge: true },
    );
}

export async function recordCampaignFire(
  userId: string,
  day: number,
): Promise<void> {
  // See merge-semantics note on `markPreLaunchCampaignScheduled`.
  const db = getFirestore();
  await db
    .collection(USERS_COLLECTION)
    .doc(userId)
    .set(
      {
        preLaunchCampaign: {
          lastFiredDay: day,
          lastFiredAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: true },
    );
}
