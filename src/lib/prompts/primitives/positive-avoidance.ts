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
 * Subject-aware: the avoidance vocabulary differs by scene type. An indoor
 * "unoccupied room" phrase is meaningless on a facade or in a garden; a
 * "natural daylight direction" anchor contradicts dusk-lit outdoor scenes.
 *
 * @see https://docs.bfl.ml/guides/prompting_guide_flux2
 */

export type AvoidanceSubject =
  | "interior"
  | "exterior"
  | "garden"
  | "patio"
  | "pool"
  | "outdoor-lighting";

/**
 * Per-subject base avoidance string. Each phrase is a positive description
 * of the absence of a common Flux failure mode (clutter, blur, fisheye,
 * oversaturation, people, watermarks, warped proportions, lighting drift).
 *
 * INVARIANT: these strings MUST NOT contain the words "avoid", "no",
 * "not", or "without" — those trigger the anti-pattern this primitive
 * exists to prevent. The same constraint is enforced at runtime on
 * `extraTokens` (see `assertPositive`).
 */
const BASE_BY_SUBJECT: Record<AvoidanceSubject, string> = {
  interior:
    "Minimal clutter, sharp focus, rectilinear verticals, natural color balance, " +
    "unoccupied room, clean photographic frame, realistic proportions, " +
    "uncluttered surfaces, natural daylight direction consistent with input.",

  exterior:
    "Minimal clutter, sharp focus, rectilinear verticals, natural color balance, " +
    "unoccupied facade, clean photographic frame, realistic proportions, " +
    "uncluttered grounds, natural daylight direction consistent with input.",

  garden:
    "Minimal clutter, sharp focus, natural color balance, unoccupied scene, " +
    "clean photographic frame, realistic proportions, healthy planting, " +
    "natural daylight direction consistent with input.",

  patio:
    "Minimal clutter, sharp focus, natural color balance, unoccupied scene, " +
    "clean photographic frame, realistic proportions, tidy seating arrangement, " +
    "natural daylight direction consistent with input.",

  pool:
    "Minimal clutter, sharp focus, natural color balance, unoccupied scene, " +
    "clean photographic frame, realistic proportions, calm water surface, " +
    "natural daylight direction consistent with input.",

  // Outdoor lighting scenes are typically dusk/evening — daylight anchor
  // would contradict the chosen lighting character. We anchor to the
  // chosen scheme instead.
  "outdoor-lighting":
    "Sharp focus, natural color balance, unoccupied scene, " +
    "clean photographic frame, realistic proportions, " +
    "physically plausible light falloff, lighting consistent with the chosen scheme.",
};

const NEGATION_PATTERN = /\b(avoid|no|not|without|never|none)\b/i;

function assertPositive(token: string): void {
  if (NEGATION_PATTERN.test(token)) {
    throw new Error(
      `positive-avoidance: extraToken "${token}" contains a negation word. ` +
        `Rephrase as a positive description of the desired output.`,
    );
  }
}

/**
 * Backwards-compatible export. New code should call `buildPositiveAvoidance`
 * with an explicit subject. Defaults to interior, matching the historical
 * behavior of the un-parameterized base.
 */
export const POSITIVE_AVOIDANCE_BASE = BASE_BY_SUBJECT.interior;

/**
 * Build the positive-avoidance clause for a given scene subject, optionally
 * adding caller-specific extra tokens. Extra tokens are validated against
 * the negation pattern at runtime — passing "no clutter" or "avoid x" will
 * throw rather than silently produce a biased prompt.
 */
export function buildPositiveAvoidance(
  subject: AvoidanceSubject,
  extraTokens?: readonly string[],
): string {
  const base = BASE_BY_SUBJECT[subject];
  if (!extraTokens || extraTokens.length === 0) {
    return base;
  }
  for (const token of extraTokens) assertPositive(token);
  return `${base} ${extraTokens.join(", ")}.`;
}
