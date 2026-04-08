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

export function notifyCircuitTripped(
  name: string,
  stats: CircuitBreakerStats,
): void {
  const text =
    `:red_circle: *Requests redirected to fal.ai for ${name}*\n` +
    `Replicate error rate hit ${stats.errorRate}% (${stats.errors}/${stats.bufferSize} requests failed).`;
  notifySlack(text);
}

export function notifyCircuitHalfOpen(name: string): void {
  const text =
    `:large_yellow_circle: *Replicate responding again for ${name} — testing recovery*\n` +
    `Probe succeeded. Sending recovery probes every 30s before switching back.`;
  notifySlack(text);
}

export function notifyCircuitRecovered(name: string): void {
  const text =
    `:white_check_mark: *Requests back on Replicate for ${name}*\n` +
    `Recovery probes passed. All clear.`;
  notifySlack(text);
}

export function notifyCircuitStatus(
  name: string,
  state: CircuitState,
  stats: CircuitBreakerStats,
): void {
  const provider = state === "CLOSED" ? "Replicate" : "fal.ai";
  const text =
    `:bar_chart: *Failover status update — ${name}*\n` +
    `Using ${provider} (${state}) — error rate ${stats.errorRate}%, probes ${stats.probeSuccesses}/${stats.probeBufferSize}`;
  notifySlack(text);
}
