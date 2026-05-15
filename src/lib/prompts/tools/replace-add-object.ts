/**
 * Replace & Add Object prompt builder (inpaint-with-prompt pipeline, Flux Fill).
 *
 * `normalizeInspirationNoun` cleans the seed-template noun phrase
 * (`scripts/manifests/object-inspirations.full.json` ships
 * `"A <noun> suitable for interior design placement."`) — strips the
 * boilerplate, repairs the indefinite article ("a arc"→"an arc",
 * "a hourglass"→"an hourglass").
 *
 * `buildReplaceAddObjectPrompt` wraps the result in a noun-first
 * sentence. Spatial language ("in the masked area") is intentionally
 * omitted: the mask is Flux Fill's spatial signal, the prompt only
 * describes the subject. "Prominently visible" is the load-bearing
 * commitment token — without it, an empty-mask "add" case (mask over
 * blank wall/floor) leaves Flux Fill biased toward extending the
 * surrounding texture instead of drawing the object.
 *
 * Guidance scale uses the 0 sentinel; the Replicate adapter resolves
 * the real value from `capabilities.defaultGuidanceScale` (Flux Fill
 * Dev=60, Pro=30) so flipping `REPLICATE_INPAINT_MODEL` picks the
 * right value automatically.
 */

import type { z } from "zod";
import type { PromptResult } from "../types.js";
import type { CreateReplaceAddObjectBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "replaceAddObject/v1.3-fluxfill-visible";

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
    // Latin vowels including accented forms — the catalog ships
    // `étagère` (vowel sound) and `bouclé`/`bergère`/`café`
    // (consonant-initial despite later accents). The `i` flag covers
    // both cases without listing each variant twice.
    const startsWithVowelSound =
      /^[aeiouéèêëáàâäíìîïóòôöúùûü]/i.test(rest) ||
      SILENT_H_PREFIX.test(rest);
    return `${startsWithVowelSound ? "an" : "a"} ${rest}`;
  }
  return stripped;
}

export function buildReplaceAddObjectPrompt(
  params: ReplaceAddObjectParams,
): PromptResult {
  const noun = normalizeInspirationNoun(params.prompt);
  // Capitalize the leading "a "/"an " so the noun reads as a sentence
  // opener — Flux Fill weighs leading tokens highest, and "A cactus, …"
  // is the form the model was trained on for object-centered prompts.
  const subject = noun.charAt(0).toUpperCase() + noun.slice(1);
  const prompt = `${subject}, photorealistic, prominently visible and naturally integrated with the surrounding room.`;

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
