/**
 * Positive-avoidance primitive — R7 (reframed per plan D1).
 *
 * Flux models (both Pruna p-image-edit and fal-ai/flux-2/klein/9b/edit) do
 * NOT support negative_prompt. BFL: "FLUX.2 does not support negative
 * prompts. Focus on describing what you want, not what you don't want."
 *
 * Inline "avoid: ..." syntax is also harmful — the model is not trained to
 * interpret it as negation and the presence of the forbidden tokens can
 * bias the output toward them. The correct pattern is to rephrase every
 * negative as a positive description of the desired opposite.
 *
 * @see https://docs.bfl.ml/guides/prompting_guide_flux2
 */

/**
 * Universal positive-avoidance tail. Applied to every prompt composed by
 * `buildInteriorPrompt`.
 *
 * Each phrase is a positive description of the absence of a common Flux
 * failure mode:
 * - "minimal clutter" → no clutter
 * - "sharp focus" → not blurry
 * - "rectilinear verticals" → no fisheye distortion
 * - "natural color balance" → not oversaturated
 * - "unoccupied room" → no people
 * - "clean photographic frame" → no watermark/text
 * - "realistic proportions" → no warped furniture
 * - "uncluttered surfaces" → no mess
 * - "natural daylight direction consistent with input" → lighting preserved
 *
 * This string MUST NOT contain the words "avoid", "no", "not", or "without" —
 * those trigger the anti-pattern the primitive exists to prevent.
 */
export const POSITIVE_AVOIDANCE_BASE =
  "Minimal clutter, sharp focus, rectilinear verticals, natural color balance, " +
  "unoccupied room, clean photographic frame, realistic proportions, " +
  "uncluttered surfaces, natural daylight direction consistent with input.";

/**
 * Build the positive-avoidance clause, optionally adding style-specific
 * extra tokens. Target-mode styles (airbnb) can add extras like
 * "neutralized" or "universally inviting".
 */
export function buildPositiveAvoidance(extraTokens?: readonly string[]): string {
  if (!extraTokens || extraTokens.length === 0) {
    return POSITIVE_AVOIDANCE_BASE;
  }
  return `${POSITIVE_AVOIDANCE_BASE} ${extraTokens.join(", ")}.`;
}
