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
  // Reference-style consumes two uploaded images and routes through more
  // expensive multi-reference models (fal-ai/flux-2/edit at ~$0.036/run vs
  // Klein at ~$0.012). Start with the same envelope as the other tools, but
  // tighten if cost telemetry warrants it.
  referenceStyle: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
  // Paint-walls texture mode is single-image (same cost as interior);
  // customStyle mode may add a reference image. Same envelope as the rest.
  paintWalls: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
  // Floor-restyle mirrors paint-walls cost profile: texture mode is
  // single-image; customStyle mode may add a reference image. Same envelope
  // as the rest pending usage telemetry.
  floorRestyle: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
  // Virtual staging is single-image input; same cost profile as interior.
  // Same envelope as the rest pending usage telemetry.
  virtualStaging: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
  // Clean & organize is single-image input on the same Pruna/Klein stack.
  // Same envelope as the rest pending usage telemetry.
  cleanOrganize: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
};
