/**
 * Replace & Add Object prompt builder (inpaint-with-prompt pipeline, Flux Fill).
 *
 * `normalizeInspirationNoun` cleans the seed-template noun phrase
 * (`scripts/manifests/object-inspirations.full.json` ships
 * `"A <noun> suitable for interior design placement."`) — strips the
 * boilerplate, repairs the indefinite article ("a arc"→"an arc",
 * "a hourglass"→"an hourglass").
 *
 * `buildReplaceAddObjectPrompt` branches on `params.mode`:
 *   - `"replace"` → "Completely replace the masked region with …" override
 *     wording. The previous v1.3 single-wrapper used "naturally integrated
 *     with the surrounding room" which biased Flux Fill toward preserving
 *     the masked silhouette (e.g. asking for a cactus over a flower in a
 *     vase rendered a flower variant). The replace branch removes that
 *     phrasing and instead anchors the model with explicit removal +
 *     replacement language so the existing object inside the mask is
 *     overwritten rather than reinterpreted.
 *   - `"add"` → placement-focused wording that tells the model the masked
 *     area is empty. "Prominently visible" alone (the v1.3 token) was not
 *     enough to overcome Flux Fill Dev's tendency to extend surrounding
 *     texture when the mask covers blank wall/floor; the add branch
 *     restates emptiness explicitly so the model commits to drawing the
 *     object instead of inpainting the wall texture.
 *
 * Guidance scale: v2.0 emits concrete per-mode values
 * (REPLACE_GUIDANCE=75, ADD_GUIDANCE=70) rather than the v1.3 `0`-as-
 * sentinel "defer to capability default" pattern. Both values are above
 * the adapter's `> 0` filter so they pass through to Flux Fill directly.
 * The capability matrix's `defaultGuidanceScale` (Dev=60, Pro=30) is no
 * longer consulted for this tool. Replace mode needs the 75 to keep
 * Flux Fill anchored to the prompt token rather than the surrounding
 * silhouette; add mode uses 70 to commit to drawing into empty space
 * without over-saturating contrast.
 *
 * Paired tuning: per-mode mask dilation (replace=10px, add=8px) lives
 * in `src/lib/generation/prompt-inpaint.ts` (`REPLACE_DILATION_PX` /
 * `ADD_DILATION_PX`). Tune those together with `REPLACE_GUIDANCE` /
 * `ADD_GUIDANCE` below when revisiting the mode-aware experiment.
 */

import type { z } from "zod";
import type { PromptResult } from "../types.js";
import type { CreateReplaceAddObjectBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "replaceAddObject/v2.1-fluxfill-integration";

export type ReplaceAddObjectParams = z.infer<typeof CreateReplaceAddObjectBody>;

// Silent-h words where "an" is the correct article despite the leading
// consonant letter. The catalog ships `hourglass` today; the rest are
// included defensively for any future seed additions. No word boundary
// so compounds (`hourglass`, `heirloom`) also match — every English
// word with these prefixes happens to be silent-h.
const SILENT_H_PREFIX = /^(hour|honest|heir|honor|herb)/i;

// Latin vowels including accented forms. The catalog ships `étagère`
// (vowel sound) and `bouclé` / `bergère` / `café` (consonant-initial
// despite later accents). Case-insensitive so the same pattern matches
// "Ottoman" and "ottoman".
const VOWEL_INITIAL = /^[aeiouéèêëáàâäíìîïóòôöúùûü]/i;

/**
 * Single source of truth for the indefinite-article heuristic. Used by
 * both `normalizeInspirationNoun` (which repairs misspelled `"a"`/`"an"`
 * on seed-template prompts) and `articleFor` (which re-derives the
 * article for the mode-aware wrapper sentences). Extracting it here
 * keeps the vowel-set + silent-h list in one place — divergence
 * between the two call sites used to be a silent failure mode (a new
 * accented vowel could be added to one and not the other).
 */
function startsWithVowelSound(word: string): boolean {
  return VOWEL_INITIAL.test(word) || SILENT_H_PREFIX.test(word);
}

// Per-mode guidance overrides for Flux Fill. Higher values pull the
// generation toward the prompt and away from the scene context;
// lower values let the model lean on surrounding pixels for
// integration cues (lighting, perspective, color grading).
//
// v2.1 drops the Pro values from 38/35 down to Pro's documented BFL
// default (30) with a small per-mode lift. Staging on v2.0 produced
// "sticker" output — the object was rendered but looked pasted onto
// the scene rather than embedded in it. Root cause was guidance
// overshoot combined with commitment-heavy prompt tokens
// ("prominently visible", "sharp focus") that pushed the model to
// emphasize the object at the expense of scene blending.
//
// Replace mode keeps the lift (30 vs 28 for add) because it still has
// to overcome the masked object's silhouette; add mode sits at Pro's
// default to maximize integration on blank-area placements.
//
// If reverting to `flux-fill-dev` via env override, raise these to
// REPLACE_GUIDANCE=60 / ADD_GUIDANCE=56 (Dev's default ~60 with the
// same ratios); the historical Dev v2.0 values (75/70) over-shot on
// Dev too and produced the same sticker artefact at lower magnitude.
//
// Paired with `REPLACE_DILATION_PX` / `ADD_DILATION_PX` in
// `src/lib/generation/prompt-inpaint.ts` — tune both together when
// revisiting the mode-aware experiment.
const REPLACE_GUIDANCE = 30;
const ADD_GUIDANCE = 28;

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
    return `${startsWithVowelSound(rest) ? "an" : "a"} ${rest}`;
  }
  return stripped;
}

/**
 * Strip the leading indefinite article so the noun composes inside a
 * sentence that supplies its own determiner. Example:
 *   "a cactus"           → "cactus"
 *   "an arc floor lamp"  → "arc floor lamp"
 *   "pendant"            → "pendant"  (no article to strip)
 *
 * The mode-aware wrappers below open with "Completely replace the
 * masked region with a cactus." / "Add a cactus inside …" — the
 * article inside those sentences is supplied by the wrapper, not by
 * the normalized noun, so we strip whatever `normalizeInspirationNoun`
 * emitted to avoid "with a a cactus".
 */
function stripLeadingArticle(noun: string): string {
  return noun.replace(/^(an?)\s+/i, "");
}

/**
 * Pick the correct indefinite article for a bare noun phrase. Shares
 * the `startsWithVowelSound` heuristic with `normalizeInspirationNoun`
 * so the mode wrappers stay grammatical for accented and silent-h nouns
 * (e.g. "an étagère", "an hourglass side table") without two copies of
 * the vowel-set + silent-h list drifting apart silently.
 */
function articleFor(bareNoun: string): "a" | "an" {
  return startsWithVowelSound(bareNoun) ? "an" : "a";
}

export function buildReplaceAddObjectPrompt(
  params: ReplaceAddObjectParams,
): PromptResult {
  const normalized = normalizeInspirationNoun(params.prompt);
  const bareNoun = stripLeadingArticle(normalized);
  const article = articleFor(bareNoun);

  let prompt: string;
  let guidanceScale: number;

  if (params.mode === "replace") {
    // Replace wrapper (v2.1) — integration-focused phrasing:
    //   "in place of the object inside the masked region"
    //     keeps the replace intent (swap whatever is there) without
    //     the v2.0 "Completely replace … Remove any existing object"
    //     wording, which read as two commands. Flux Fill is an
    //     inpainter and does not act on "remove" as an instruction —
    //     it only synthesizes what is described, so the redundant
    //     removal clause was contributing prompt-token weight without
    //     adding semantic signal.
    //   "matching the scene's lighting direction, perspective, and
    //    material palette"
    //     replaces v2.0's bare "matching the room's lighting" with
    //     three concrete integration anchors. "scene" (not "room")
    //     because the catalog includes outdoor categories (patio /
    //     garden / outdoor seating) where "room" would mislead the
    //     model. Pairs naturally with the lower guidance below so the
    //     model has room to honor the scene's existing pixels.
    //   No "prominently visible" / "sharp focus" tokens — those
    //     drove the v2.0 sticker effect by over-emphasizing the
    //     object at the expense of scene blending.
    prompt =
      `${article.charAt(0).toUpperCase()}${article.slice(1)} ${bareNoun} in place of the object inside the masked region, ` +
      `matching the scene's lighting direction, perspective, and material palette. ` +
      `Photorealistic, integrated with the surrounding furniture and surfaces.`;
    guidanceScale = REPLACE_GUIDANCE;
  } else {
    // Add wrapper (v2.1) — integration-focused phrasing:
    //   "placed on the floor inside the masked region"
    //     spatial anchor ("on the floor") cues the model to ground
    //     the object in the scene's perspective. The v2.0 wording
    //     ("The masked area is currently empty") was a lie — mask
    //     regions over wall or floor still contain texture pixels,
    //     so the model was being told to ignore real context.
    //   "matching the scene's lighting direction, depth of field,
    //    and color palette so it blends naturally with the
    //    surrounding furniture and surfaces"
    //     three concrete integration anchors plus an explicit
    //     blending instruction. "Scene" (not "room") for outdoor
    //     category support.
    //   No "clearly visible" / "well-lit" / "sharp focus" tokens —
    //     those drove the v2.0 sticker effect.
    prompt =
      `${article.charAt(0).toUpperCase()}${article.slice(1)} ${bareNoun} placed on the floor inside the masked region, ` +
      `matching the scene's lighting direction, depth of field, and color palette so it blends naturally with the surrounding furniture and surfaces. ` +
      `Photorealistic.`;
    guidanceScale = ADD_GUIDANCE;
  }

  return {
    prompt,
    positiveAvoidance: "",
    guidanceScale,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion: PROMPT_VERSION_CURRENT,
  };
}
