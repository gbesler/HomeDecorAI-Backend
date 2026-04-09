// Validate env vars first — fail fast on missing config
import { env } from "./lib/env.js";

import { buildApp } from "./app.js";
import { logger } from "./lib/logger.js";
import {
  designCircuitBreaker,
  CircuitState,
} from "./lib/circuit-breaker.js";
import {
  notifyCircuitTripped,
  notifyCircuitHalfOpen,
  notifyCircuitRecovered,
  notifyCircuitStatus,
} from "./lib/slack.js";
import { rateLimiterCleanupInterval } from "./lib/rate-limiter.js";

// ─── Circuit Breaker Notifications ──────────────────────────────────────────

designCircuitBreaker.onTransition = (name, from, to, stats) => {
  if (to === CircuitState.OPEN) {
    notifyCircuitTripped(name, stats);
  } else if (to === CircuitState.HALF_OPEN) {
    notifyCircuitHalfOpen(name);
  } else if (to === CircuitState.CLOSED && from !== CircuitState.CLOSED) {
    notifyCircuitRecovered(name);
  }
};

// Periodic circuit breaker status log (every 30 seconds, only when not healthy)
const statusInterval = setInterval(() => {
  const state = designCircuitBreaker.getState();
  if (state !== CircuitState.CLOSED) {
    const provider = designCircuitBreaker.shouldUseFallback()
      ? "fal.ai"
      : "replicate";
    logger.info(
      `Circuit breaker: ${provider} (${state})`,
    );
  }
}, 30_000);

// Periodic Slack status report (every 30 minutes) when circuit is not CLOSED
const slackStatusInterval = setInterval(() => {
  const state = designCircuitBreaker.getState();
  if (state !== CircuitState.CLOSED) {
    notifyCircuitStatus(
      designCircuitBreaker.name,
      state,
      designCircuitBreaker.getStats(),
    );
  }
}, 30 * 60 * 1000);

// ─── Server ─────────────────────────────────────────────────────────────────

const port = env.PORT;
const app = buildApp();

// Cleanup on shutdown
app.addHook("onClose", async () => {
  clearInterval(statusInterval);
  clearInterval(slackStatusInterval);
  clearInterval(rateLimiterCleanupInterval);
});

app.listen({ port, host: "0.0.0.0" }, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
