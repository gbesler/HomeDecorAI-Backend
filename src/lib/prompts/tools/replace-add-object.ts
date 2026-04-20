/**
 * Replace & Add Object prompt builder (inpaint-with-prompt pipeline, Flux Fill).
 *
 * Pass-through. The inspiration library on the iOS client curates authored
 * per-item prompts (e.g. "A modern velvet sofa — Sofas."). Appending
 * quality modifiers from the backend would stack a second author's
 * fingerprint and degrade consistency across the 800-item library; Flux Fill
 * already biases toward photorealistic output without extra nudging.
 *
 * If product later wants a global suffix, add a single
 * REPLACE_ADD_OBJECT_PROMPT_SUFFIX env var and append once here. Cheap to add,
 * expensive to un-add.
 */

import type { z } from "zod";
import type { PromptResult } from "../types.js";
import type { CreateReplaceAddObjectBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "replaceAddObject/v1.0-fluxfill";

/**
 * Flux Fill's "guidance" parameter is on a different scale than classic CFG.
 * Model-card defaults: Dev ~60, Pro ~30. We start conservative (30) so Pro
 * can be adopted via env flip without behaviour change; Dev will likely want
 * higher in staging QA. Tune via open-questions loop.
 */
const DEFAULT_GUIDANCE_SCALE = 30;

export type ReplaceAddObjectParams = z.infer<typeof CreateReplaceAddObjectBody>;

export function buildReplaceAddObjectPrompt(
  params: ReplaceAddObjectParams,
): PromptResult {
  return {
    prompt: params.prompt,
    positiveAvoidance: "",
    guidanceScale: DEFAULT_GUIDANCE_SCALE,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion: PROMPT_VERSION_CURRENT,
  };
}
