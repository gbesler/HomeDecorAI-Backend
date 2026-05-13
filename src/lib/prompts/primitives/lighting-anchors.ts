/**
 * Lighting-anchor primitives — short prompt fragments that tell the model
 * what to preserve about the input photograph's lighting.
 *
 * Two shapes are stable enough to share:
 *
 * 1. `OUTDOOR_INPUT_DAYLIGHT_ANCHOR` — used by every outdoor scene tool
 *    (garden, patio, pool, plus the outdoor branches of exterior tools).
 *    The phrasing is intentionally short; outdoor scenes don't need the
 *    direction/warmth/time-of-day breakdown that interior surface-restyle
 *    benefits from.
 *
 * 2. `surfaceRestyleLightingAnchor(surface)` — used by the surface-restyle
 *    tools (paint-walls, floor-restyle) to instruct Pruna to keep
 *    everything except how the new finish reflects the existing light.
 *    `surface` is interpolated as-is into the prompt (e.g. "wall",
 *    "floor"), so callers control plurality and any qualifiers.
 *
 * The custom-path and generic-fallback variants in paint-walls and
 * floor-restyle deliberately diverge from these (different axis emphasis
 * — "daylight direction, warmth, and time of day" vs the neutral
 * "lighting, daylight direction, and time of day"), and stay inline at
 * their callsites. Centralising them would force a phrasing decision the
 * builders haven't yet committed to.
 */

export const OUTDOOR_INPUT_DAYLIGHT_ANCHOR =
  "Natural outdoor daylight consistent with the input photograph.";

export function surfaceRestyleLightingAnchor(surface: string): string {
  return (
    `Preserve the input photograph's existing lighting, daylight direction, ` +
    `and time of day; only the ${surface} finish responds differently to that light.`
  );
}
