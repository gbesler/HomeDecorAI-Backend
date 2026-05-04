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
 */

import type { z } from "zod";
import { KLEIN_GUIDANCE_BANDS } from "../../ai-providers/capabilities.js";
import type { PromptResult } from "../types.js";
import type { CreateCleanOrganizeBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "cleanOrganize/v3.1-sam3-lama-taxonomy";

const FULL_DECLUTTER_PROMPT = [
  "clutter",
  "scattered objects",
  "piles of clothes",
  "laundry",
  "dirty dishes",
  "empty bottles",
  "cans",
  "cups",
  "crumpled papers",
  "trash",
  "plastic bags",
  "cardboard boxes",
  "cables",
  "wires",
  "toys on the floor",
].join(" . ");

const LIGHT_DECLUTTER_PROMPT = [
  "trash",
  "empty bottles",
  "cans",
  "dirty dishes",
  "crumpled papers",
  "food wrappers",
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
