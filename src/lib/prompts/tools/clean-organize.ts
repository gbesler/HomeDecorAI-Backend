/**
 * Clean & Organize prompt builder (SAM 3 + LaMa pipeline).
 *
 * The builder's only real output is the SAM 3 concept prompt. LaMa doesn't
 * accept a prompt, so `prompt` is set to an empty string — it only exists to
 * satisfy the `PromptResult` shape.
 *
 * Concept mapping:
 *   - `full`  → "clutter"
 *       SAM 3 understands "clutter" as a concept natively (Meta paper, Nov
 *       2025). No taxonomy list needed; the model groups loose items on
 *       surfaces, floor debris, and miscellaneous small objects without us
 *       having to enumerate them.
 *   - `light` → "trash . empty bottles . dirty dishes"
 *       Narrow, high-precision object concepts for a "picked-up but
 *       lived-in" result. "." separator is the SAM 3 convention for
 *       multi-concept prompts.
 *
 * The legacy taxonomy dictionary (`src/lib/prompts/dictionaries/clutter-
 * taxonomy.ts`) was deleted when this file was rewritten for SAM 3.
 */

import type { z } from "zod";
import { KLEIN_GUIDANCE_BANDS } from "../../ai-providers/capabilities.js";
import type { PromptResult } from "../types.js";
import type { CreateCleanOrganizeBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "cleanOrganize/v3.0-sam3-lama";

export type CleanOrganizeParams = z.infer<typeof CreateCleanOrganizeBody>;

export function buildCleanOrganizePrompt(
  params: CleanOrganizeParams,
): PromptResult {
  const segmentTextPrompt =
    params.declutterLevel === "full"
      ? "clutter"
      : "trash . empty bottles . dirty dishes";

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
