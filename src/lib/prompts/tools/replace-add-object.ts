/**
 * Replace & Add Object prompt builder (inpaint-with-prompt pipeline, Flux Fill).
 *
 * Wraps the seeded inspiration string in an explicit placement directive.
 * The seed manifest (`scripts/manifests/object-inspirations.full.json`)
 * ships prompts of the form:
 *
 *   "A arc floor lamp suitable for interior design placement."
 *   "A cactus suitable for interior design placement."
 *
 * Passing those verbatim to Flux Fill re-stylizes the existing pixels
 * toward the noun ("turn this chair into a sofa-looking chair") instead
 * of placing a fresh object — users reported it as "I picked a cactus
 * and got a different plant." Two manifest-side defects compound that:
 * a generic "suitable for interior design placement." suffix dilutes
 * the noun, and the hard-coded "A " article mismatches vowel-initial
 * nouns (~10% of the catalog: "A arc floor lamp", "A outdoor pillow").
 * `normalizeInspirationNoun` below strips the suffix, fixes the
 * article, and the wrapper sentence supplies an unambiguous "Place …"
 * verb plus an integration hint.
 *
 * Guidance scale is sourced from `capabilities.defaultGuidanceScale`
 * via the 0 sentinel below; flipping `REPLICATE_INPAINT_MODEL` between
 * Flux Fill Dev (60) and Pro (30) picks the right value automatically.
 */

import type { z } from "zod";
import type { PromptResult } from "../types.js";
import type { CreateReplaceAddObjectBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "replaceAddObject/v1.2-fluxfill-place";

export type ReplaceAddObjectParams = z.infer<typeof CreateReplaceAddObjectBody>;

// Silent-h words where "an" is the correct article despite the leading
// consonant letter. The catalog ships `hourglass` today; the rest are
// included defensively for any future seed additions. No word boundary
// so compounds (`hourglass`, `heirloom`) also match — every English
// word with these prefixes happens to be silent-h.
const SILENT_H_PREFIX = /^(hour|honest|heir|honor|herb)/i;

/**
 * Strip the seed-template boilerplate so the noun composes inside the
 * wrapper sentence and emits a grammatical indefinite article:
 *   - "A arc floor lamp suitable for interior design placement." → "an arc floor lamp"
 *   - "A cactus suitable for interior design placement."         → "a cactus"
 *   - "A hourglass side table suitable for …"                    → "an hourglass side table"
 *   - "A pendant" (operator override, no suffix)                 → "a pendant"
 */
export function normalizeInspirationNoun(raw: string): string {
  // The seed-template " ... suitable for interior design placement."
  // suffix is identical across all 800 manifest rows and adds no
  // useful signal — it dilutes the noun for Flux Fill. Anchored to
  // end-of-string so a real prompt that happens to contain the phrase
  // mid-sentence ("lamp suitable for outdoor use") is unaffected.
  const stripped = raw
    .replace(/\s+suitable\s+for\s+interior\s+design\s+placement\.?\s*$/i, "")
    .replace(/\.\s*$/, "")
    .trim();

  const articleMatch = stripped.match(/^(An?)\s+(.+)$/);
  if (articleMatch) {
    const [, , rest = ""] = articleMatch;
    const startsWithVowelSound =
      /^[aeiouAEIOU]/.test(rest) || SILENT_H_PREFIX.test(rest);
    return `${startsWithVowelSound ? "an" : "a"} ${rest}`;
  }
  return stripped;
}

export function buildReplaceAddObjectPrompt(
  params: ReplaceAddObjectParams,
): PromptResult {
  const noun = normalizeInspirationNoun(params.prompt);
  const prompt = `Place ${noun} in the masked area, naturally integrated into the existing scene, photorealistic.`;

  return {
    prompt,
    positiveAvoidance: "",
    // 0 = "no caller override"; the Replicate adapter resolves the real
    // guidance from `capabilities.defaultGuidanceScale` (Flux Fill
    // Dev=60, Pro=30). PromptResult.guidanceScale is typed `number`, so
    // undefined isn't an option here without a cross-cutting refactor.
    guidanceScale: 0,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion: PROMPT_VERSION_CURRENT,
  };
}
