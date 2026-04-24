import { logger } from "../lib/logger.js";
import { enqueueCampaignTask } from "../lib/cloud-tasks.js";
import {
  CAMPAIGN_DAYS,
  PRE_LAUNCH_TEMPLATES,
  type CampaignDay,
} from "../lib/notifications/campaign-templates.js";
import {
  getUserCampaignContext,
  markPreLaunchCampaignScheduled,
} from "../lib/notifications/user-state.js";

/**
 * Fallback timezone used when a user's doc has no `timezone` stored.
 * Hardcoded because our launch market is Turkey — the only reason to
 * override this at runtime would be moving the product to a different
 * region, which is a deploy-worthy decision anyway.
 */
const DEFAULT_TIMEZONE = "Europe/Istanbul";

/**
 * Schedules the 14-day pre-purchase notification campaign for a user.
 *
 * Idempotent: the first call enqueues 13 Cloud Tasks (day 7 is a deliberate
 * rest day) and then stamps `users/{uid}.preLaunchCampaign.scheduledAt`.
 * Subsequent calls short-circuit on the stamp. Task names are deterministic
 * so a caller retry after a stamp-write failure is absorbed by Cloud Tasks
 * ALREADY_EXISTS dedup on the days that did succeed — the failed day re-
 * enqueues cleanly.
 *
 * The stamp is written only if ALL expected days enqueued successfully.
 * Partial failure leaves the stamp absent so the next token registration
 * retries — otherwise a single transient Cloud Tasks error would silently
 * drop that day forever, with no observable recovery path.
 */
export async function schedulePreLaunchCampaign(userId: string): Promise<void> {
  const ctx = await getUserCampaignContext(userId);
  if (!ctx) {
    logger.warn(
      { event: "campaign.schedule.user_missing", userId },
      "Skipping campaign schedule — user doc not found",
    );
    return;
  }
  if (ctx.preLaunchScheduledAt) {
    logger.info(
      { event: "campaign.schedule.already_scheduled", userId },
      "Pre-launch campaign already scheduled for user",
    );
    return;
  }
  if (ctx.isPremium) {
    logger.info(
      { event: "campaign.schedule.user_premium", userId },
      "Skipping campaign schedule — user is premium",
    );
    return;
  }

  const timezone = ctx.timezone ?? DEFAULT_TIMEZONE;
  const nowMs = Date.now();
  const scheduledDays: CampaignDay[] = [];
  const failedDays: CampaignDay[] = [];

  for (const day of CAMPAIGN_DAYS) {
    const template = PRE_LAUNCH_TEMPLATES[day];
    const scheduleTimeMs = computeSlotScheduleTimeMs({
      baselineMs: nowMs,
      dayOffset: day,
      slotHour: template.slotHour,
      slotMinute: template.slotMinute,
      timezone,
    });

    // Skip any slots that land in the past. Happens only when the scheduler
    // is re-invoked after the stamp write was lost and some slots have
    // already been consumed — safe to drop silently.
    if (scheduleTimeMs <= nowMs) {
      logger.warn(
        {
          event: "campaign.schedule.slot_past",
          userId,
          day,
          scheduleTimeMs,
          nowMs,
        },
        "Skipping campaign slot in the past",
      );
      continue;
    }

    try {
      await enqueueCampaignTask({ userId, day, scheduleTimeMs });
      scheduledDays.push(day);
    } catch (err) {
      failedDays.push(day);
      logger.error(
        {
          event: "campaign.schedule.enqueue_failed",
          userId,
          day,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to enqueue campaign task — deferring stamp so the next retry can heal",
      );
    }
  }

  if (failedDays.length > 0) {
    logger.warn(
      {
        event: "campaign.schedule.partial",
        userId,
        scheduledDays,
        failedDays,
      },
      "Partial campaign schedule — stamp withheld; ALREADY_EXISTS will absorb re-enqueued successes on retry",
    );
    return;
  }

  if (scheduledDays.length === 0) {
    logger.warn(
      { event: "campaign.schedule.all_slots_past", userId },
      "All campaign slots landed in the past — nothing to schedule",
    );
    return;
  }

  await markPreLaunchCampaignScheduled(userId, scheduledDays);
  logger.info(
    {
      event: "campaign.schedule.complete",
      userId,
      scheduledDays,
      timezone,
    },
    "Pre-launch campaign scheduled",
  );
}

interface SlotScheduleInput {
  baselineMs: number;
  dayOffset: number;
  slotHour: number;
  slotMinute: number;
  timezone: string;
}

/**
 * Compute the absolute UTC epoch ms for a campaign slot.
 *
 * The baseline is normalized to the user's local date, shifted by
 * `dayOffset` days, and stamped at `slotHour:slotMinute` in that zone.
 * We use a UTC offset extracted from `Intl.DateTimeFormat` so we do not
 * need to pull in a timezone library (luxon/date-fns-tz).
 *
 * Exported for tests.
 */
export function computeSlotScheduleTimeMs(input: SlotScheduleInput): number {
  const { baselineMs, dayOffset, slotHour, slotMinute, timezone } = input;

  // Extract the target zone's current UTC offset (minutes). Good-enough
  // approximation: DST transitions within 14 days may shift a slot by an
  // hour, which is acceptable for marketing sends.
  const offsetMinutes = getUtcOffsetMinutes(baselineMs, timezone);

  // Walk to the target local date at midnight.
  const localMidnight =
    Math.floor((baselineMs + offsetMinutes * 60_000) / 86_400_000) *
      86_400_000 +
    dayOffset * 86_400_000;
  // Convert local midnight back to UTC ms, then add slot time.
  const utcMidnight = localMidnight - offsetMinutes * 60_000;
  return utcMidnight + slotHour * 3_600_000 + slotMinute * 60_000;
}

function getUtcOffsetMinutes(epochMs: number, timezone: string): number {
  // Intl returns a date formatted in `timezone`. We then compare it to
  // the same instant formatted as UTC and derive the offset.
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(epochMs));
    const lookup: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") lookup[part.type] = part.value;
    }
    // Some ICU builds emit `hour === '24'` to mean the same instant as
    // `00:00` on the next day. Reconstruct as `00:00` and let Date.UTC
    // carry the day over — otherwise the resulting asUtc lands 24 hours
    // behind the real instant.
    const rawHour = lookup["hour"] ?? "0";
    const isHour24 = rawHour === "24";
    const asUtc = Date.UTC(
      Number(lookup["year"]),
      Number(lookup["month"]) - 1,
      Number(lookup["day"]) + (isHour24 ? 1 : 0),
      isHour24 ? 0 : Number(rawHour),
      Number(lookup["minute"] ?? "0"),
      Number(lookup["second"] ?? "0"),
    );
    return Math.round((asUtc - epochMs) / 60_000);
  } catch {
    // Unknown zone — fall back to +03:00 (Europe/Istanbul standard).
    return 180;
  }
}
