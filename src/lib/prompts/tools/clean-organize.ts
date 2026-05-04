/**
 * Clean & Organize prompt builder (single-step instruction edit).
 *
 * Migrated from the SAM 3 + LaMa segment-remove pipeline in v4.0
 * (May 2026). The two-stage approach was structurally untenable —
 * SAM 3 returned all-zero masks for clutter-class concepts on real
 * user rooms regardless of taxonomy, and prompt engineering across
 * three variants and two providers couldn't move the needle. The new
 * pipeline reuses the design-tools' instruction-edit path (Pruna
 * primary, Klein fallback). See
 * `~/.claude/plans/bence-yol-b-yi-velvet-badger.md` for full migration
 * notes.
 *
 * Prompt design:
 *   - The "Keep ... unchanged" clause is load-bearing for both Pruna
 *     and Klein. Both are FLUX-family models and respond to explicit
 *     preservation language; without it they will restyle the room
 *     instead of just removing clutter.
 *   - Klein doesn't accept negative prompts, so structural avoidance
 *     is pushed into the positive prompt as an explicit "Keep …"
 *     clause rather than a separate negative-prompt field.
 *   - `guidanceBand: "faithful"` (5.0) matches the user intent — same
 *     room, fewer items.
 */

import type { z } from "zod";
import { KLEIN_GUIDANCE_BANDS } from "../../ai-providers/capabilities.js";
import type { PromptResult } from "../types.js";
import type { CreateCleanOrganizeBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "cleanOrganize/v4.0-edit-instruction";

const FULL_DECLUTTER_PROMPT =
  "Tidy and declutter this room. Remove all visible clutter: " +
  "scattered objects, piles of clothes, laundry, dirty dishes, " +
  "empty bottles, cans, cups, crumpled papers, trash, plastic bags, " +
  "cardboard boxes, loose cables and wires, and toys on the floor " +
  "and surfaces. Keep all furniture, walls, flooring, ceiling, " +
  "lighting, windows, decor, and the room's exact layout and " +
  "composition completely unchanged. Photorealistic result. " +
  "Same camera angle. Same lighting and time of day.";

const LIGHT_DECLUTTER_PROMPT =
  "Pick up the after-use trash from this room: empty bottles, cans, " +
  "dirty dishes, crumpled papers, food wrappers. Leave clothes, " +
  "books, and personal items in place. Keep all furniture, walls, " +
  "flooring, lighting, decor, and the room's layout and composition " +
  "completely unchanged. Photorealistic result. Same camera angle. " +
  "Same lighting.";

export type CleanOrganizeParams = z.infer<typeof CreateCleanOrganizeBody>;

export function buildCleanOrganizePrompt(
  params: CleanOrganizeParams,
): PromptResult {
  const prompt =
    params.declutterLevel === "full"
      ? FULL_DECLUTTER_PROMPT
      : LIGHT_DECLUTTER_PROMPT;

  return {
    prompt,
    // Klein has no negative-prompt input; preservation language lives
    // inline in `prompt`. Empty string here keeps the metric/log
    // pipeline happy without sending anything model-side.
    positiveAvoidance: "",
    guidanceScale: KLEIN_GUIDANCE_BANDS.faithful,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion: PROMPT_VERSION_CURRENT,
  };
}
