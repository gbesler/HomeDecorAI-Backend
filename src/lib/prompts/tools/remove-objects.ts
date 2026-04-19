/**
 * Remove Objects prompt builder (remove-only pipeline, LaMa).
 *
 * LaMa takes `image + mask` only — no prompt. The builder exists only to
 * satisfy the `PromptResult` shape for the tool-types registry; all fields
 * are inert for the LaMa path.
 *
 * The iOS `prompt?` body field is accepted at the API boundary for
 * backward-compat but is not forwarded to LaMa. Remove in a future iOS
 * release.
 */

import type { z } from "zod";
import { KLEIN_GUIDANCE_BANDS } from "../../ai-providers/capabilities.js";
import type { PromptResult } from "../types.js";
import type { CreateRemoveObjectsBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "removeObjects/v2.0-lama";

export type RemoveObjectsParams = z.infer<typeof CreateRemoveObjectsBody>;

export function buildRemoveObjectsPrompt(
  _params: RemoveObjectsParams,
): PromptResult {
  return {
    prompt: "",
    positiveAvoidance: "",
    guidanceScale: KLEIN_GUIDANCE_BANDS.faithful,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion: PROMPT_VERSION_CURRENT,
  };
}
