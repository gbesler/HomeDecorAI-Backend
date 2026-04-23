import { env } from "./env.js";
import { logger } from "./logger.js";
import type { CircuitState, CircuitBreakerStats } from "./circuit-breaker.js";

async function notifySlack(text: string): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return;

  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.error(
        { status: res.status },
        "Slack webhook returned error",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to send Slack notification");
  }
}

/**
 * Labels identifying the breaker's primary and fallback providers. Used by
 * circuit-breaker notifications so messages say the right thing regardless
 * of which breaker (Replicate-primary or fal-primary) flipped.
 */
export interface BreakerProviders {
  primary: string;
  fallback: string;
}

export function notifyCircuitTripped(
  name: string,
  providers: BreakerProviders,
  stats: CircuitBreakerStats,
): void {
  const text =
    `:red_circle: *Requests redirected to ${providers.fallback} for ${name}*\n` +
    `${providers.primary} error rate hit ${stats.errorRate}% (${stats.errors}/${stats.bufferSize} requests failed).`;
  notifySlack(text);
}

export function notifyCircuitHalfOpen(
  name: string,
  providers: BreakerProviders,
): void {
  const text =
    `:large_yellow_circle: *${providers.primary} responding again for ${name} — testing recovery*\n` +
    `Probe succeeded. Sending recovery probes every 30s before switching back.`;
  notifySlack(text);
}

export function notifyCircuitRecovered(
  name: string,
  providers: BreakerProviders,
): void {
  const text =
    `:white_check_mark: *Requests back on ${providers.primary} for ${name}*\n` +
    `Recovery probes passed. All clear.`;
  notifySlack(text);
}

export function notifyCircuitStatus(
  name: string,
  providers: BreakerProviders,
  state: CircuitState,
  stats: CircuitBreakerStats,
): void {
  // During CLOSED traffic rides on the primary; OPEN and HALF_OPEN both
  // route real traffic to the fallback (probes still hit the primary, but
  // user-facing serving is on the fallback until the breaker closes).
  const provider = state === "CLOSED" ? providers.primary : providers.fallback;
  const text =
    `:bar_chart: *Failover status update — ${name}*\n` +
    `Using ${provider} (${state}) — error rate ${stats.errorRate}%, probes ${stats.probeSuccesses}/${stats.probeBufferSize}`;
  notifySlack(text);
}
