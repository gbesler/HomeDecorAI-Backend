import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import type { RateLimitConfig } from "../config/rate-limits.js";
import { rateLimits } from "../config/rate-limits.js";

// ─── Types ────────────────────────────────────────────────────────────────

type LimitWindow = "minute" | "hourly" | "daily";

export interface RateLimitState {
  limit: number;
  remaining: number;
  resetAfterSeconds: number;
}

interface CheckResult extends RateLimitState {
  allowed: boolean;
  exceededWindow?: LimitWindow;
}

// Marker placed on every preHandler returned by `createRateLimitPreHandler`.
// The boot-time guard in `app.ts` looks for this symbol to verify every
// `/api/*` route carries a rate-limit gate. Do not export the value — only
// the symbol — so external code cannot synthesize a fake tag.
export const RATE_LIMIT_TAG: unique symbol = Symbol("rateLimitHandler");

declare module "fastify" {
  interface FastifyRequest {
    rateLimitState?: RateLimitState;
    concurrencyOwner?: string;
  }
  interface FastifyContextConfig {
    /**
     * Opt-out flag for the boot-time rate-limit guard. Use only for
     * intentionally unmetered `/api/*` routes (currently none).
     */
    noRateLimit?: boolean;
  }
}

// ─── Sliding-window bucket store ───────────────────────────────────────────
//
// Keyed by `${scope}:${id}:${endpoint}`. `scope` is `user` or `ip` so the
// two domains share one cleanup loop without colliding.

const buckets: Map<string, number[]> = new Map();

const WINDOWS = {
  minute: 60 * 1000,
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

function checkBucket(
  bucketKey: string,
  config: RateLimitConfig,
): CheckResult {
  const now = Date.now();

  let timestamps = buckets.get(bucketKey);
  if (!timestamps) {
    timestamps = [];
    buckets.set(bucketKey, timestamps);
  }

  // Drop entries older than the longest window we track (daily).
  const dailyWindowStart = now - WINDOWS.daily;
  timestamps = timestamps.filter((t) => t > dailyWindowStart);
  buckets.set(bucketKey, timestamps);

  const minuteCount = timestamps.filter(
    (t) => t > now - WINDOWS.minute,
  ).length;
  const hourlyCount = timestamps.filter(
    (t) => t > now - WINDOWS.hourly,
  ).length;
  const dailyCount = timestamps.length;

  if (minuteCount >= config.minuteLimit) {
    const oldest = timestamps.find((t) => t > now - WINDOWS.minute) ?? now;
    return {
      allowed: false,
      limit: config.minuteLimit,
      remaining: 0,
      resetAfterSeconds: Math.max(
        1,
        Math.ceil((oldest + WINDOWS.minute - now) / 1000),
      ),
      exceededWindow: "minute",
    };
  }

  if (hourlyCount >= config.hourlyLimit) {
    const oldest = timestamps.find((t) => t > now - WINDOWS.hourly) ?? now;
    return {
      allowed: false,
      limit: config.hourlyLimit,
      remaining: 0,
      resetAfterSeconds: Math.max(
        1,
        Math.ceil((oldest + WINDOWS.hourly - now) / 1000),
      ),
      exceededWindow: "hourly",
    };
  }

  if (dailyCount >= config.dailyLimit) {
    const oldest = timestamps[0] ?? now;
    return {
      allowed: false,
      limit: config.dailyLimit,
      remaining: 0,
      resetAfterSeconds: Math.max(
        1,
        Math.ceil((oldest + WINDOWS.daily - now) / 1000),
      ),
      exceededWindow: "daily",
    };
  }

  // Allowed: record this hit and report the minute window (most actionable
  // signal for clients pacing requests).
  timestamps.push(now);
  const minuteOldest = timestamps.find((t) => t > now - WINDOWS.minute);
  return {
    allowed: true,
    limit: config.minuteLimit,
    remaining: Math.max(0, config.minuteLimit - minuteCount - 1),
    resetAfterSeconds: minuteOldest
      ? Math.max(
          1,
          Math.ceil((minuteOldest + WINDOWS.minute - now) / 1000),
        )
      : 60,
  };
}

// ─── Header helpers ────────────────────────────────────────────────────────

function applyHeaders(reply: FastifyReply, state: RateLimitState): void {
  // IETF draft-ietf-httpapi-ratelimit-headers field names.
  reply.header("RateLimit-Limit", state.limit.toString());
  reply.header("RateLimit-Remaining", state.remaining.toString());
  reply.header("RateLimit-Reset", state.resetAfterSeconds.toString());
}

// ─── Per-user, per-endpoint rate-limit preHandler ─────────────────────────

export function createRateLimitPreHandler(endpoint: string) {
  const config = rateLimits[endpoint];
  if (!config) {
    throw new Error(`No rate limit config for endpoint: ${endpoint}`);
  }

  async function rateLimitHandler(
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

    const result = checkBucket(`user:${userId}:${endpoint}`, config);
    const state: RateLimitState = {
      limit: result.limit,
      remaining: result.remaining,
      resetAfterSeconds: result.resetAfterSeconds,
    };
    request.rateLimitState = state;
    applyHeaders(reply, state);

    if (!result.allowed) {
      request.log.warn(
        {
          userId,
          endpoint,
          exceededWindow: result.exceededWindow,
        },
        "Rate limit exceeded",
      );
      reply.header("Retry-After", state.resetAfterSeconds.toString());
      reply.code(429).send({
        error: "Too Many Requests",
        message: `Rate limit exceeded (${result.exceededWindow}). Try again later.`,
        retryAfter: state.resetAfterSeconds,
      });
    }
  }

  // Tag for the boot-time guard.
  (rateLimitHandler as unknown as { [RATE_LIMIT_TAG]: true })[
    RATE_LIMIT_TAG
  ] = true;

  return rateLimitHandler;
}

// ─── Pre-auth IP throttle ─────────────────────────────────────────────────
//
// Used inside `firebase-auth.ts` to gate (a) requests with no Bearer token
// and (b) requests whose Bearer fails verifyIdToken. Authenticated users
// never count against this bucket so NAT-shared clients are not penalized.

interface IpThrottleResult {
  allowed: boolean;
  state: RateLimitState;
}

export function checkIpThrottle(ip: string): IpThrottleResult {
  const config = rateLimits.unauthenticatedIp;
  if (!config) {
    throw new Error("Missing rate-limit config: unauthenticatedIp");
  }
  const result = checkBucket(`ip:${ip}:unauth`, config);
  return {
    allowed: result.allowed,
    state: {
      limit: result.limit,
      remaining: result.remaining,
      resetAfterSeconds: result.resetAfterSeconds,
    },
  };
}

export function applyIpThrottleHeaders(
  reply: FastifyReply,
  state: RateLimitState,
  exhausted: boolean,
): void {
  applyHeaders(reply, state);
  if (exhausted) {
    reply.header("Retry-After", state.resetAfterSeconds.toString());
  }
}

// ─── Per-user concurrency limiter ─────────────────────────────────────────
//
// Caps in-flight HTTP requests per user (async tool POSTs + retry).
// Protects the Render worker pool from a single user holding many enqueue
// requests open at once. Decrement runs in `onResponse` so handler
// exceptions still release the slot.

const inFlight: Map<string, number> = new Map();

const DEFAULT_CONCURRENCY_CAP = 2;
// Sufficient hint for clients that are about to retry; the real reset is
// when an in-flight request actually finishes. iOS treats Retry-After as a
// minimum wait, which is the right semantic here.
const CONCURRENCY_RETRY_AFTER_SECONDS = 5;

export function createConcurrencyPreHandler(
  cap: number = DEFAULT_CONCURRENCY_CAP,
) {
  return async function concurrencyHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({
        error: "Unauthorized",
        message: "User ID is required for concurrency control",
      });
      return;
    }

    const current = inFlight.get(userId) ?? 0;
    if (current >= cap) {
      request.log.warn(
        { userId, cap, current },
        "Concurrency cap exceeded",
      );
      reply.header("Retry-After", CONCURRENCY_RETRY_AFTER_SECONDS.toString());
      reply.code(429).send({
        error: "Too Many Requests",
        message:
          "Concurrent generation limit reached. Wait for the previous request to finish.",
        retryAfter: CONCURRENCY_RETRY_AFTER_SECONDS,
      });
      return;
    }

    inFlight.set(userId, current + 1);
    request.concurrencyOwner = userId;
  };
}

export function registerConcurrencyHook(app: FastifyInstance): void {
  app.addHook("onResponse", async (request) => {
    const owner = request.concurrencyOwner;
    if (!owner) return;
    const current = inFlight.get(owner) ?? 0;
    if (current <= 1) {
      inFlight.delete(owner);
    } else {
      inFlight.set(owner, current - 1);
    }
  });
}

// ─── Boot-time route guard ─────────────────────────────────────────────────
//
// Fails fast at boot if any `/api/*` route lacks a rate-limit preHandler.
// `noRateLimit: true` in the route's config object opts out (none today).
// `/internal/*` and root paths (`/`, `/health`, `/docs/*`) are out of scope.

export function registerRateLimitGuard(app: FastifyInstance): void {
  app.addHook("onRoute", (routeOptions) => {
    const url = routeOptions.url ?? "";
    if (!url.startsWith("/api/") && url !== "/api") return;

    const cfg = (routeOptions.config ?? {}) as { noRateLimit?: boolean };
    if (cfg.noRateLimit === true) return;

    const handlers: unknown[] = ([] as unknown[]).concat(
      routeOptions.preHandler ?? [],
    );
    const hasRateLimit = handlers.some((h) => {
      if (typeof h !== "function") return false;
      return (h as { [RATE_LIMIT_TAG]?: boolean })[RATE_LIMIT_TAG] === true;
    });

    if (!hasRateLimit) {
      const method = Array.isArray(routeOptions.method)
        ? routeOptions.method.join(",")
        : routeOptions.method;
      throw new Error(
        `[rate-limit-guard] Route ${method} ${url} is missing a rate-limit preHandler. ` +
          `Add createRateLimitPreHandler(...) to its preHandler chain, ` +
          `or set { config: { noRateLimit: true } } to opt out explicitly.`,
      );
    }
  });
}

// ─── Periodic cleanup ─────────────────────────────────────────────────────
//
// Sweep both user and IP buckets — same daily window applies to both.

export const rateLimiterCleanupInterval = setInterval(() => {
  const now = Date.now();
  const dailyWindowStart = now - WINDOWS.daily;

  for (const [key, timestamps] of buckets.entries()) {
    const filtered = timestamps.filter((t) => t > dailyWindowStart);
    if (filtered.length === 0) {
      buckets.delete(key);
    } else {
      buckets.set(key, filtered);
    }
  }
}, 60_000);
