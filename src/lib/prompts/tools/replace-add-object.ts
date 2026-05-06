/**
 * Replace & Add Object prompt builder (inpaint-with-prompt pipeline, Flux Fill).
 *
 * Wraps the iOS-supplied inspiration string in an explicit placement
 * directive. The iOS inspiration library ships noun-phrase prompts of the
 * shape:
 *
 *   "A modern velvet sofa — Sofas."
 *   "A wishbone chair — Dining Chairs."
 *
 * Passing those verbatim to Flux Fill produced a structural failure mode:
 * Flux Fill's "fill the masked region with content described by the prompt"
 * semantics, given a noun-only prompt and a mask painted over an existing
 * object, often re-stylized the existing pixels toward the noun ("turn
 * this chair into a sofa-looking chair") instead of placing a fresh,
 * structurally-distinct object. Users reported this as "it doesn't place
 * the object I picked, it just modifies what's already there."
 *
 * The wrapper here:
 *   1. Strips the trailing " — Category." author signature (the model
 *      doesn't need the category label as a prompt token).
 *   2. Lowercases the leading "A " so it composes inside our sentence.
 *   3. Wraps the result in "Place {noun} in the masked area, naturally
 *      integrated into the existing scene, photorealistic." — gives Flux
 *      Fill an unambiguous action verb plus an integration hint that
 *      reduces ghost-edge artifacts.
 *
 * Guidance scale used to live here as a hard-coded `30`, calibrated for
 * Flux Fill Pro. Production runs `flux-fill-dev` by default, which wants
 * ~60 per BFL's model card — at half the recommended guidance the model
 * leans on existing pixels rather than the prompt, compounding the
 * "modifies instead of places" symptom. Guidance now lives in
 * `capabilities.ts` (`defaultGuidanceScale` per model) so flipping
 * `REPLICATE_INPAINT_MODEL` between Dev and Pro picks the right value
 * without touching this builder.
 */

import type { z } from "zod";
import type { PromptResult } from "../types.js";
import type { CreateReplaceAddObjectBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "replaceAddObject/v1.1-fluxfill-place";

export type ReplaceAddObjectParams = z.infer<typeof CreateReplaceAddObjectBody>;

/**
 * Strip the iOS inspiration signature so the noun composes inside our
 * sentence. Defensive against drift in the iOS template:
 *   - `"A modern velvet sofa — Sofas."` → `"a modern velvet sofa"`
 *   - `"Wishbone chair — Dining Chairs."` → `"wishbone chair"` (no "A " prefix)
 *   - `"A pendant"` (template change, no suffix) → `"a pendant"`
 *
 * Em-dash (—) is the iOS template's separator. Hyphen-minus is also matched
 * to survive a hand-edit that swaps em-dash for "-". Trailing period is
 * dropped — the wrapper sentence supplies its own.
 */
export function normalizeInspirationNoun(raw: string): string {
  // Drop the " — Category." or " - Category." suffix when present. The
  // category label is author signature, not prompt material.
  const withoutCategory = raw.replace(/\s+[—-]\s+[^—-]+\.?\s*$/, "");
  // Drop a trailing period if the suffix regex didn't match (e.g. raw was
  // already noun-only).
  const withoutPeriod = withoutCategory.replace(/\.\s*$/, "");
  // Lowercase a leading "A " or "An " so the noun reads naturally inside
  // "Place {noun}…". Preserves casing of any embedded proper nouns.
  const trimmed = withoutPeriod.trim();
  if (/^An?\s/.test(trimmed)) {
    return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  }
  return trimmed;
}

export function buildReplaceAddObjectPrompt(
  params: ReplaceAddObjectParams,
): PromptResult {
  const noun = normalizeInspirationNoun(params.prompt);
  const prompt = `Place ${noun} in the masked area, naturally integrated into the existing scene, photorealistic.`;

  return {
    prompt,
    positiveAvoidance: "",
    // Sentinel value. The Replicate adapter resolves the real guidance from
    // capabilities.defaultGuidanceScale when the caller passes undefined;
    // we cannot pass undefined here because PromptResult.guidanceScale is
    // typed `number`. The processor treats 0 as "no caller override", and
    // capabilities-by-model is the source of truth (Flux Fill Dev=60,
    // Pro=30). Changing PromptResult to allow optional guidance is a
    // cross-cutting refactor not justified for this single tool.
    guidanceScale: 0,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion: PROMPT_VERSION_CURRENT,
  };
}
