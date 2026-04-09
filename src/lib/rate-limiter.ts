import type { FastifyRequest, FastifyReply } from "fastify";
import type { RateLimitConfig } from "../config/rate-limits.js";
import { rateLimits } from "../config/rate-limits.js";

type LimitWindow = "minute" | "hourly" | "daily";

interface RateLimitResult {
  allowed: boolean;
  remaining: {
    minute: number;
    hourly: number;
    daily: number;
  };
  exceededWindow?: LimitWindow;
  resetAt?: number;
}

const userRequests: Map<string, number[]> = new Map();

const WINDOWS = {
  minute: 60 * 1000,
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

function checkRateLimit(
  userId: string,
  endpoint: string,
  config: RateLimitConfig,
): RateLimitResult {
  const now = Date.now();
  const key = `${userId}:${endpoint}`;

  let timestamps = userRequests.get(key);
  if (!timestamps) {
    timestamps = [];
    userRequests.set(key, timestamps);
  }

  // Clean expired entries (older than daily window)
  const dailyWindowStart = now - WINDOWS.daily;
  const filtered = timestamps.filter((t) => t > dailyWindowStart);
  userRequests.set(key, filtered);
  timestamps = filtered;

  const minuteCount = timestamps.filter(
    (t) => t > now - WINDOWS.minute,
  ).length;
  const hourlyCount = timestamps.filter(
    (t) => t > now - WINDOWS.hourly,
  ).length;
  const dailyCount = timestamps.length;

  const remaining = {
    minute: Math.max(0, config.minuteLimit - minuteCount),
    hourly: Math.max(0, config.hourlyLimit - hourlyCount),
    daily: Math.max(0, config.dailyLimit - dailyCount),
  };

  if (minuteCount >= config.minuteLimit) {
    const oldestInMinute = timestamps.find(
      (t) => t > now - WINDOWS.minute,
    );
    return {
      allowed: false,
      remaining,
      exceededWindow: "minute",
      resetAt: oldestInMinute
        ? oldestInMinute + WINDOWS.minute
        : now + WINDOWS.minute,
    };
  }

  if (hourlyCount >= config.hourlyLimit) {
    const oldestInHour = timestamps.find(
      (t) => t > now - WINDOWS.hourly,
    );
    return {
      allowed: false,
      remaining,
      exceededWindow: "hourly",
      resetAt: oldestInHour
        ? oldestInHour + WINDOWS.hourly
        : now + WINDOWS.hourly,
    };
  }

  if (dailyCount >= config.dailyLimit) {
    const oldestInDay = timestamps[0];
    return {
      allowed: false,
      remaining,
      exceededWindow: "daily",
      resetAt: oldestInDay ? oldestInDay + WINDOWS.daily : now + WINDOWS.daily,
    };
  }

  timestamps.push(now);

  return {
    allowed: true,
    remaining: {
      minute: config.minuteLimit - minuteCount - 1,
      hourly: config.hourlyLimit - hourlyCount - 1,
      daily: config.dailyLimit - dailyCount - 1,
    },
  };
}

export function createRateLimitPreHandler(endpoint: string) {
  const config = rateLimits[endpoint];
  if (!config) {
    throw new Error(`No rate limit config for endpoint: ${endpoint}`);
  }

  return async function rateLimitHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({
        error: "Unauthorized",
        message: "User ID is required for rate limiting",
      });
      return;
    }

    const result = checkRateLimit(userId, endpoint, config);

    if (!result.allowed) {
      request.log.warn(
        {
          userId,
          exceededWindow: result.exceededWindow,
          remaining: result.remaining,
        },
        "Rate limit exceeded",
      );
      reply.code(429).send({
        error: "Too Many Requests",
        message: `Rate limit exceeded (${result.exceededWindow}). Try again later.`,
        retryAfter: Math.ceil(
          ((result.resetAt ?? Date.now()) - Date.now()) / 1000,
        ),
      });
    }
  };
}

// Periodic cleanup: remove expired entries every 60 seconds
export const rateLimiterCleanupInterval = setInterval(() => {
  const now = Date.now();
  const dailyWindowStart = now - WINDOWS.daily;

  for (const [key, timestamps] of userRequests.entries()) {
    const filtered = timestamps.filter((t) => t > dailyWindowStart);
    if (filtered.length === 0) {
      userRequests.delete(key);
    } else {
      userRequests.set(key, filtered);
    }
  }
}, 60_000);
