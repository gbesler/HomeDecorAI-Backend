// Validate env vars first — fail fast on missing config
import { env } from "./lib/env.js";

import { buildApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { validateDictionaries } from "./lib/prompts/validate.js";
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

function wireBreakerNotifications(
  breaker: typeof designCircuitBreaker,
): void {
  const providers = {
    primary: breaker.primaryProvider,
    fallback: breaker.fallbackProvider,
  };
  breaker.onTransition = (name, from, to, stats) => {
    if (to === CircuitState.OPEN) {
      notifyCircuitTripped(name, providers, stats);
    } else if (to === CircuitState.HALF_OPEN) {
      notifyCircuitHalfOpen(name, providers);
    } else if (to === CircuitState.CLOSED && from !== CircuitState.CLOSED) {
      notifyCircuitRecovered(name, providers);
    }
  };
}

wireBreakerNotifications(designCircuitBreaker);

// ─── Server ─────────────────────────────────────────────────────────────────

const port = env.PORT;
const app = buildApp();

// Validate prompt dictionaries before accepting traffic. In strict mode
// (default) this throws on incomplete entries and crashes the process
// before Fastify binds — matching env.ts fail-fast pattern. In degraded
// mode (D17 F2 safety valve) this logs and continues, and affected
// style/room combinations use the runtime fallback path.
try {
  validateDictionaries({ mode: env.DICTIONARY_STRICT_MODE });
} catch (error) {
  logger.error(
    {
      event: "prompt.dictionary_validation_failed",
      error: error instanceof Error ? error.message : String(error),
    },
    "Dictionary validation failed — refusing to start",
  );
  process.exit(1);
}

// Start intervals only after validation passes
const breakers = [designCircuitBreaker];

const statusInterval = setInterval(() => {
  for (const breaker of breakers) {
    const state = breaker.getState();
    if (state !== CircuitState.CLOSED) {
      // OPEN: all traffic on fallback, no probing. HALF_OPEN: traffic still
      // on fallback but probes testing primary recovery. Spell out both so
      // an on-call reader doesn't conflate probe activity with user-facing
      // serving.
      const servingProvider = breaker.fallbackProvider;
      const probing =
        state === CircuitState.HALF_OPEN
          ? ` (probing ${breaker.primaryProvider} for recovery)`
          : "";
      logger.info(
        `Circuit breaker [${breaker.name}]: serving ${servingProvider} (${state})${probing}`,
      );
    }
  }
}, 30_000);

const slackStatusInterval = setInterval(() => {
  for (const breaker of breakers) {
    const state = breaker.getState();
    if (state !== CircuitState.CLOSED) {
      notifyCircuitStatus(
        breaker.name,
        { primary: breaker.primaryProvider, fallback: breaker.fallbackProvider },
        state,
        breaker.getStats(),
      );
    }
  }
}, 30 * 60 * 1000);

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
