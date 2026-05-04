/**
 * Clean & Organize prompt builder (SAM 3 + LaMa pipeline).
 *
 * The builder's only real output is the SAM 3 concept prompt. LaMa doesn't
 * accept a prompt, so `prompt` is set to an empty string — it only exists to
 * satisfy the `PromptResult` shape.
 *
 * Why an explicit taxonomy instead of a single "clutter" abstraction:
 * production logs (May 2026) showed `mattsays/sam3-image` returning all-zero
 * masks for the abstract concept "clutter" on real user rooms — the model
 * refuses to commit when the noun isn't grounded in concrete object
 * categories. Empty-mask rate was ~100% on Clean & Organize, surfacing as a
 * silent no-op (LaMa returns input unchanged when the mask is black). The
 * normalize stage now hard-fails on empty masks
 * (`MIN_MASK_WHITE_FRACTION` in `normalize-image-mask-pair.ts`) but the
 * underlying empty-mask rate is what this prompt change is targeting.
 *
 * Taxonomy selection rules:
 *   - Concrete nouns only — SAM 3 grounds on object categories, not
 *     adjectives or scene descriptors
 *   - Bias toward items that don't overlap with kept-furniture/decor
 *     classes (no "books", "decorative objects", "shoes" — too easy to
 *     false-positive on bookshelves, designed pieces, sneaker collections)
 *   - "." separator is the SAM 3 convention for multi-concept prompts
 *   - "full" gets the broad mess taxonomy (laundry, scattered objects,
 *     packaging); "light" stays narrow (consumable trash only)
 *
 * HARD TOKEN CAP: `mattsays/sam3-image` ships with
 * `max_position_embeddings: 32` — the Replicate fork rejects any prompt
 * that tokenizes longer than that with `Sequence length must be less
 * than max_position_embeddings`. Single-token nouns + ` . ` separators
 * (each a token) keep us well under the cap. Do not add multi-word
 * phrases like "piles of clothes" without re-counting; a 15-concept list
 * blew past 32 in production (May 2026).
 */

import type { z } from "zod";
import { KLEIN_GUIDANCE_BANDS } from "../../ai-providers/capabilities.js";
import type { PromptResult } from "../types.js";
import type { CreateCleanOrganizeBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "cleanOrganize/v3.2-sam3-lama-taxonomy-short";

// Single-token nouns only. Each ` . ` separator is itself a token, so the
// effective budget is ~12-14 concepts at the 32-token cap. We stay
// conservative at 9 to leave headroom for tokenizer drift across SAM 3
// model forks.
const FULL_DECLUTTER_PROMPT = [
  "clutter",
  "laundry",
  "dishes",
  "bottles",
  "cans",
  "cups",
  "trash",
  "wires",
  "toys",
].join(" . ");

const LIGHT_DECLUTTER_PROMPT = [
  "trash",
  "bottles",
  "cans",
  "dishes",
  "wrappers",
].join(" . ");

export type CleanOrganizeParams = z.infer<typeof CreateCleanOrganizeBody>;

export function buildCleanOrganizePrompt(
  params: CleanOrganizeParams,
): PromptResult {
  const segmentTextPrompt =
    params.declutterLevel === "full"
      ? FULL_DECLUTTER_PROMPT
      : LIGHT_DECLUTTER_PROMPT;

  return {
    // LaMa consumes no prompt; this is a placeholder to fit PromptResult.
    prompt: "",
    positiveAvoidance: "",
    // Not consumed by LaMa; kept for record/compat.
    guidanceScale: KLEIN_GUIDANCE_BANDS.faithful,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion: PROMPT_VERSION_CURRENT,
    segmentTextPrompt,
  };
}
