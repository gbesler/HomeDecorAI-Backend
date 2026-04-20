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
  // Patio design is a single-style transform on top of a single input image;
  // same cost profile as garden. Same envelope pending usage telemetry.
  patioDesign: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
  // Pool design mirrors patio: single-style transform on top of a single
  // input image. Same envelope pending usage telemetry.
  poolDesign: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
  // Outdoor lighting mirrors patio/pool: single-style overlay on top of a
  // single input image. Same envelope pending usage telemetry.
  outdoorLightingDesign: {
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
  // Remove Objects runs one LaMa call per submission (no segmentation).
  // Pipeline cost profile similar to clean-organize; keep the same envelope
  // pending usage telemetry.
  removeObjects: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
  // Replace & Add Object runs one Flux Fill call per submission. Flux Fill
  // Dev is ~$0.04/run, Pro ~$0.20. Same starting envelope as the rest; if
  // ops flips REPLICATE_INPAINT_MODEL to Pro, halve dailyLimit to 50.
  replaceAddObject: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
  // Exterior painting is single-image input on the same Pruna/Klein stack
  // (surface / material edit). Same envelope pending usage telemetry.
  exteriorPainting: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
  // Album writes — cheap Firestore ops, but the add-generation endpoint
  // performs an extra `assertGenerationOwnedBy` read that an attacker could
  // abuse to enumerate other users' generationIds. Cap aggressively but
  // still leave headroom for legitimate batch usage from the AddToAlbumSheet.
  albumWrite: {
    minuteLimit: 30,
    hourlyLimit: 200,
    dailyLimit: 1000,
  },
  // Album reads — pure list/get. Loose envelope; pull-to-refresh from iOS
  // can fire several times per minute under normal use.
  albumRead: {
    minuteLimit: 60,
    hourlyLimit: 500,
    dailyLimit: 2000,
  },
  // Failed-generation retry. Skips the per-tool freemium meter, so a
  // tight cap on abuse: a user who really wants more retries is going to
  // generate new jobs instead. A legitimate "oh no try again" pattern
  // is <3 retries per minute in practice; 10/min leaves headroom for
  // frustrated mashing without opening a provider-cost DoS vector.
  retry: {
    minuteLimit: 10,
    hourlyLimit: 50,
    dailyLimit: 200,
  },
};
