export interface RateLimitConfig {
  minuteLimit: number;
  hourlyLimit: number;
  dailyLimit: number;
}

/**
 * Per-tool rate limits. Keys match `ToolTypeConfig.rateLimitKey` in
 * `src/lib/tool-types.ts`. Per-tool keys (rather than a shared key) so one
 * expensive tool cannot block another. Defaults are identical across tools
 * because we have no usage data yet — revisit after the first 30 days of
 * telemetry.
 */
export const rateLimits: Record<string, RateLimitConfig> = {
  interiorDesign: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
  exteriorDesign: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
  gardenDesign: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
};
