import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { registerFcmToken } from "../lib/notifications/token-store.js";
import { updatePremiumState } from "../lib/notifications/user-state.js";
import { schedulePreLaunchCampaign } from "../services/pre-launch-campaign.service.js";

// FCM tokens are opaque strings but never huge — bound the body size to
// catch obviously wrong input early.
//
// `timezone` is validated against the runtime's IANA zone list. Accepts
// single-component zones like "UTC" as well as "Area/Location" forms,
// and rejects every zone the runtime cannot resolve — so the scheduler's
// silent Istanbul fallback cannot be reached through a typo.
const SUPPORTED_TIMEZONES = new Set(
  (() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      // Extremely old runtimes without supportedValuesOf — skip validation
      // and let the scheduler's Intl try/catch handle bad zones.
      return [] as string[];
    }
  })(),
);

const RegisterFcmTokenBody = z.object({
  token: z.string().min(1).max(4096),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine(
      (tz) => SUPPORTED_TIMEZONES.size === 0 || SUPPORTED_TIMEZONES.has(tz),
      { message: "unsupported IANA timezone" },
    )
    .optional(),
  language: z.enum(["tr", "en"]).optional(),
});

const PremiumStateBody = z.object({
  isPremium: z.boolean(),
  productId: z.string().max(256).nullable().optional(),
  expiresAt: z.number().int().nonnegative().nullable().optional(),
});

/**
 * POST /api/users/me/fcm-token
 *
 * Called by iOS when a fresh FCM registration token is issued (app launch,
 * token refresh). Writes to `users/{uid}.fcmTokens` via arrayUnion so the
 * push layer always picks up the most recent token without client-side
 * bookkeeping. Caller must be authenticated.
 *
 * Also the trigger point for the 14-day pre-purchase notification campaign:
 * once a token is persisted we fire-and-forget the scheduler. It is
 * idempotent, so repeat launches are safe.
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
    await registerFcmToken(userId, parsed.data.token, {
      timezone: parsed.data.timezone,
      language: parsed.data.language,
    });

    // Schedule the pre-launch campaign out-of-band. A scheduling failure
    // must not fail the token registration — the FCM pipeline is the
    // critical path for this endpoint. `void` makes the fire-and-forget
    // intent explicit to readers and to the no-floating-promises lint.
    void schedulePreLaunchCampaign(userId).catch((err) => {
      request.log.error(
        {
          event: "campaign.schedule.failed",
          userId,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to schedule pre-launch campaign",
      );
    });

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

/**
 * PATCH /api/users/me/premium-state
 *
 * iOS pushes RevenueCat entitlement changes here so the backend can gate
 * notification dispatch on premium status. Idempotent — repeated calls
 * with the same state overwrite the same fields.
 */
export async function updatePremiumStateHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) {
    reply.code(401);
    return { error: "Unauthorized", message: "Authentication required" };
  }

  const parsed = PremiumStateBody.safeParse(request.body);
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
    await updatePremiumState({
      userId,
      isPremium: parsed.data.isPremium,
      productId: parsed.data.productId ?? undefined,
      expiresAt: parsed.data.expiresAt ?? undefined,
    });
    reply.code(204);
    return;
  } catch (err) {
    request.log.error(
      {
        event: "premium.state.update_failed",
        userId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to update premium state",
    );
    reply.code(500);
    return {
      error: "Internal Error",
      message: "Failed to update premium state.",
    };
  }
}
