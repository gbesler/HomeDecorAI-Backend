/**
 * Clean & Organize prompt builder.
 *
 * Subtractive edit — removes clutter and tidies existing items without
 * transforming style, furniture, materials, or geometry. Two levels mirror
 * the iOS wizard:
 *   1. `full`: complete tidy-up, every surface cleared and neatly organized.
 *   2. `light`: gentle declutter, lived-in character intact.
 *
 * No dictionary (no style/room/palette) — the iOS wizard only collects a
 * photo and a declutter level. Every other aspect of the room must be
 * preserved, so the prompt leans on the shared structural-preservation and
 * positive-avoidance primitives and keeps the tool-local directives short
 * enough to stay inside the 200-token budget alongside the guardrail layer.
 *
 * Phrasing rule: Flux models do not honor negation. Every directive is
 * written as a positive description of the desired output; element-level
 * preservation is delegated to `buildStructuralPreservation("interior")`.
 */

import type { z } from "zod";
import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { buildPhotographyQuality } from "../primitives/photography-quality.js";
import { buildPositiveAvoidance } from "../primitives/positive-avoidance.js";
import { buildStructuralPreservation } from "../primitives/structural-preservation.js";
import { trimLayersToBudget, type PromptLayer } from "../token-budget.js";
import type { PromptResult } from "../types.js";
import type { CreateCleanOrganizeBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "cleanOrganize/v1.0";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

export type CleanOrganizeParams = z.infer<typeof CreateCleanOrganizeBody>;

export function buildCleanOrganizePrompt(
  params: CleanOrganizeParams,
): PromptResult {
  const isFull = params.declutterLevel === "full";

  const actionDirective = isFull
    ? "Remove all visible clutter from this room and neatly organize every remaining item " +
      "with intentional, minimal placement on clear surfaces."
    : "Moderately reduce visible clutter and tidy loose items while keeping a natural, " +
      "lived-in character across all surfaces.";

  const focusDirective =
    "Only clutter and loose items change. Keep every existing furniture piece in place " +
    "with its original colors, materials, shapes, and styling.";

  const styleCore = isFull
    ? "Surfaces are clean and uncluttered. Items are grouped with care. " +
      "The room feels calm, intentional, and effortlessly tidy."
    : "Surfaces look picked-up but relaxed. A lived-in feel remains — " +
      "an everyday item where it naturally belongs.";

  const lighting =
    "Preserve the original room's daylight direction, color temperature, and overall exposure.";

  const positiveAvoidance = buildPositiveAvoidance([
    "faithful to original room geometry",
    "faithful to original furniture and decor",
    "faithful to original materials and colors",
  ]);

  const layers: PromptLayer[] = [
    {
      name: "action+focus",
      priority: 1,
      text: `${actionDirective} ${focusDirective}`,
    },
    { name: "style-core", priority: 2, text: styleCore },
    {
      name: "structural-preservation",
      priority: 3,
      text: buildStructuralPreservation("interior"),
    },
    { name: "positive-avoidance", priority: 4, text: positiveAvoidance },
    {
      name: "photography-quality",
      priority: 5,
      text: buildPhotographyQuality("interior"),
    },
    { name: "lighting", priority: 6, text: lighting },
  ];

  const trimResult = trimLayersToBudget(layers, PRIMARY_MAX_TOKENS);

  if (trimResult.droppedLayers.length > 0) {
    logger.warn(
      {
        event: "prompt.token_truncation",
        tool: "cleanOrganize",
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Clean-organize prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
    );
  }

  return {
    prompt: trimResult.composed,
    positiveAvoidance,
    // Subtractive edit — geometry, furniture, materials must all survive.
    guidanceScale: KLEIN_GUIDANCE_BANDS.faithful,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion: PROMPT_VERSION_CURRENT,
  };
}
