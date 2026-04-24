import admin from "firebase-admin";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { SupportedLanguage } from "../generation/types.js";
import { LOCALIZED_MESSAGES, type NotificationKind } from "./i18n.js";
import {
  getCampaignTemplate,
  type CampaignDay,
} from "./campaign-templates.js";
import { getFcmTokens, removeFcmTokens } from "./token-store.js";

/**
 * FCM push notifications for generation lifecycle events (R4, R9, R10).
 *
 * Content is localized using the snapshot-at-enqueue `language` field on the
 * generation doc. Token invalidation is handled automatically — any token
 * that returns `registration-token-not-registered` or
 * `invalid-registration-token` is removed from the user's token array so the
 * next push attempt stays clean.
 *
 * Failures here are non-fatal: the Firestore listener on iOS is the primary
 * success path. Push is best-effort and never blocks the processor's 200 return.
 */

const DEEP_LINK_BASE = "homedecorai://generation";

// FCM error codes that indicate the token is permanently defective and
// should be pruned from the user doc. Transient or payload-related errors
// (internal, throttled, invalid-argument) are NOT prunable — they indicate
// a server-side problem (e.g., a malformed message) rather than a dead
// device, so pruning would wipe every user's tokens on a template bug.
const PRUNABLE_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

export interface SendGenerationNotificationInput {
  userId: string;
  generationId: string;
  kind: NotificationKind;
  language: SupportedLanguage;
}

/**
 * Send a generation lifecycle push to all of a user's registered FCM tokens.
 * Never throws — errors are logged and swallowed so the caller can still
 * return 200 to Cloud Tasks.
 */
export async function sendGenerationNotification(
  input: SendGenerationNotificationInput,
): Promise<{ sent: number; failed: number } | null> {
  if (!env.FCM_ENABLED) {
    logger.debug(
      { event: "fcm.disabled", generationId: input.generationId },
      "FCM disabled, skipping push",
    );
    return null;
  }

  const tokens = await getFcmTokens(input.userId).catch((err) => {
    logger.warn(
      {
        event: "fcm.token.read_failed",
        userId: input.userId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to read FCM tokens",
    );
    return [] as string[];
  });

  if (tokens.length === 0) {
    logger.info(
      {
        event: "fcm.no_tokens",
        userId: input.userId,
        generationId: input.generationId,
      },
      "No FCM tokens for user — skipping push",
    );
    return null;
  }

  const content = LOCALIZED_MESSAGES[input.language][input.kind];
  const deepLink = `${DEEP_LINK_BASE}/${input.generationId}`;

  const message: admin.messaging.MulticastMessage = {
    tokens,
    notification: {
      title: content.title,
      body: content.body,
    },
    data: {
      generationId: input.generationId,
      kind: input.kind,
      lang: input.language,
      deepLink,
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
          "mutable-content": 1,
        },
      },
    },
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);

    if (response.failureCount > 0) {
      const toPrune: string[] = [];
      response.responses.forEach((result, index) => {
        if (!result.success) {
          const code = result.error?.code;
          const token = tokens[index];
          if (token && code && PRUNABLE_ERROR_CODES.has(code)) {
            toPrune.push(token);
          }
          logger.warn(
            {
              event: "fcm.send.individual_failure",
              generationId: input.generationId,
              tokenSuffix: token?.slice(-8),
              code,
            },
            "FCM individual send failed",
          );
        }
      });

      if (toPrune.length > 0) {
        await removeFcmTokens(input.userId, toPrune);
      }
    }

    logger.info(
      {
        event: "fcm.send.ok",
        generationId: input.generationId,
        sent: response.successCount,
        failed: response.failureCount,
        language: input.language,
        kind: input.kind,
      },
      "FCM push dispatched",
    );

    return {
      sent: response.successCount,
      failed: response.failureCount,
    };
  } catch (err) {
    // Top-level errors (network failure, invalid credentials) — log and
    // continue. The processor will still return 200.
    logger.error(
      {
        event: "fcm.send.failed",
        generationId: input.generationId,
        error: err instanceof Error ? err.message : String(err),
      },
      "FCM push dispatch failed",
    );
    return null;
  }
}

export interface SendCampaignNotificationInput {
  userId: string;
  day: CampaignDay;
  language: SupportedLanguage;
  deepLink: string;
  tokens: string[];
}

/**
 * Dispatch a pre-launch campaign push to a user's registered tokens.
 * Mirrors the generation-push error semantics: never throws, prunes
 * invalid tokens, returns counts.
 *
 * The caller is expected to have already gated on premium status and
 * loaded tokens. Passing tokens explicitly (rather than re-fetching)
 * keeps this callable from a receiver that already read the user doc
 * for other reasons.
 */
export async function sendCampaignNotification(
  input: SendCampaignNotificationInput,
): Promise<{ sent: number; failed: number } | null> {
  if (!env.FCM_ENABLED) {
    logger.debug(
      { event: "fcm.disabled", userId: input.userId, day: input.day },
      "FCM disabled, skipping campaign push",
    );
    return null;
  }
  if (input.tokens.length === 0) return null;

  const content = getCampaignTemplate(input.day, input.language);

  const message: admin.messaging.MulticastMessage = {
    tokens: input.tokens,
    notification: {
      title: content.title,
      body: content.body,
    },
    data: {
      kind: "campaign",
      campaignDay: String(input.day),
      lang: input.language,
      deepLink: input.deepLink,
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
          "mutable-content": 1,
        },
      },
    },
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);

    if (response.failureCount > 0) {
      const toPrune: string[] = [];
      response.responses.forEach((result, index) => {
        if (!result.success) {
          const code = result.error?.code;
          const token = input.tokens[index];
          if (token && code && PRUNABLE_ERROR_CODES.has(code)) {
            toPrune.push(token);
          }
          logger.warn(
            {
              event: "fcm.campaign.individual_failure",
              userId: input.userId,
              day: input.day,
              tokenSuffix: token?.slice(-8),
              code,
            },
            "FCM campaign individual send failed",
          );
        }
      });
      if (toPrune.length > 0) {
        await removeFcmTokens(input.userId, toPrune);
      }
    }

    logger.info(
      {
        event: "fcm.campaign.ok",
        userId: input.userId,
        day: input.day,
        sent: response.successCount,
        failed: response.failureCount,
        language: input.language,
      },
      "FCM campaign push dispatched",
    );

    return { sent: response.successCount, failed: response.failureCount };
  } catch (err) {
    logger.error(
      {
        event: "fcm.campaign.failed",
        userId: input.userId,
        day: input.day,
        error: err instanceof Error ? err.message : String(err),
      },
      "FCM campaign dispatch failed",
    );
    return null;
  }
}
