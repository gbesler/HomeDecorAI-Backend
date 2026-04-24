import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CAMPAIGN_DAYS,
  PRE_LAUNCH_TEMPLATES,
  type CampaignDay,
} from "../lib/notifications/campaign-templates.js";
import { sendCampaignNotification } from "../lib/notifications/fcm.js";
import {
  getUserCampaignContext,
  recordCampaignFire,
} from "../lib/notifications/user-state.js";

// `day` is a union of 13 integer literals (1-6, 8-14). Encoding it as a
// z.union of z.literal values makes `parsed.data.day` flow through as
// CampaignDay without a cast — if CAMPAIGN_DAYS ever changes, TypeScript
// catches every downstream consumer that assumed a specific day exists.
const DAY_SCHEMA = z.union(
  CAMPAIGN_DAYS.map((d) => z.literal(d)) as unknown as readonly [
    z.ZodLiteral<CampaignDay>,
    z.ZodLiteral<CampaignDay>,
    ...z.ZodLiteral<CampaignDay>[],
  ],
);

const CampaignFireBody = z.object({
  userId: z.string().min(1).max(256),
  day: DAY_SCHEMA,
});

type CampaignFireResponse =
  | { error: string; message: string }
  | {
      skipped:
        | "user-missing"
        | "premium"
        | "no-tokens"
        | "context-read-error";
    }
  | { dispatched: number; failed: number };

/**
 * POST /internal/notifications/campaign-fire
 *
 * Invoked by Cloud Tasks at the scheduled slot. Gates on premium state
 * and token availability before dispatching a localized push. Always
 * returns 200 to prevent Cloud Tasks retries on benign skip reasons
 * (premium, no tokens, user deleted). True errors return 5xx so the
 * queue retries per its configured policy.
 *
 * `recordCampaignFire` failures after a successful send are caught and
 * logged rather than propagated — letting the stamp write fail would
 * return 500, Cloud Tasks would retry, and the user would receive a
 * duplicate push.
 */
export async function campaignFireHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<CampaignFireResponse> {
  const parsed = CampaignFireBody.safeParse(request.body);
  if (!parsed.success) {
    request.log.warn(
      {
        event: "campaign.fire.validation_failed",
        issues: parsed.error.issues,
      },
      "Invalid campaign-fire body",
    );
    reply.code(400);
    return {
      error: "Validation Error",
      message: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(", "),
    };
  }

  const { userId, day } = parsed.data;
  let ctx;
  try {
    ctx = await getUserCampaignContext(userId);
  } catch (err) {
    // Firestore read failure: returning 5xx would make Cloud Tasks retry
    // this task, and since we have not sent anything yet the retry is
    // safe — but a transient Firestore blip would produce a 5xx storm.
    // Returning 200 drops the task silently; Ops alerts on this event.
    request.log.error(
      {
        event: "campaign.fire.context_read_failed",
        userId,
        day,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to read user campaign context — dropping task",
    );
    reply.code(200);
    return { skipped: "context-read-error" };
  }
  if (!ctx) {
    request.log.info(
      { event: "campaign.fire.user_missing", userId, day },
      "User doc not found — skipping",
    );
    reply.code(200);
    return { skipped: "user-missing" };
  }

  if (ctx.isPremium) {
    request.log.info(
      { event: "campaign.fire.premium", userId, day },
      "User is premium — skipping campaign push",
    );
    reply.code(200);
    return { skipped: "premium" };
  }

  if (ctx.tokens.length === 0) {
    request.log.info(
      { event: "campaign.fire.no_tokens", userId, day },
      "No FCM tokens — skipping",
    );
    reply.code(200);
    return { skipped: "no-tokens" };
  }

  const language = ctx.language ?? "tr";
  const template = PRE_LAUNCH_TEMPLATES[day];

  const result = await sendCampaignNotification({
    userId,
    day,
    language,
    deepLink: template.deepLink,
    tokens: ctx.tokens,
  });

  // Only stamp when at least one push actually reached a device.
  // `result === null` means FCM was disabled or threw at the top level.
  // `result.sent === 0` means every token failed (all-invalid-tokens case) —
  // nothing was delivered, so recording a fire would lie in the audit trail.
  // Stamp failures are swallowed so they cannot propagate as 5xx and
  // trigger a Cloud Tasks retry that would duplicate the push.
  if (result !== null && result.sent > 0) {
    try {
      await recordCampaignFire(userId, day);
    } catch (err) {
      request.log.error(
        {
          event: "campaign.fire.stamp_failed",
          userId,
          day,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to stamp campaign fire — push already delivered, skipping retry",
      );
    }
  } else if (result !== null && result.sent === 0) {
    request.log.warn(
      {
        event: "campaign.fire.zero_sent",
        userId,
        day,
        failed: result.failed,
      },
      "Campaign fire dispatched but all tokens failed — stamp withheld",
    );
  }

  reply.code(200);
  return {
    dispatched: result?.sent ?? 0,
    failed: result?.failed ?? 0,
  };
}
