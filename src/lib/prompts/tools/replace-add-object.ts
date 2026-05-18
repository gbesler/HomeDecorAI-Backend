/**
 * Replace & Add Object prompt builder (v5.0 — crop-composite-refine).
 *
 * v4.x (Nano Banana multi-image instructional) failed twice in production:
 *
 *   - v4.0 (mask-as-image-3): the model ignored the third image slot as
 *     a semantic mask and placed the inspiration in the visual center
 *     of the scene regardless of where the user painted.
 *   - v4.1 (bbox text-spatial): even with explicit percentage
 *     coordinates in the prompt ("the rectangular region from left 10%,
 *     top 62%..."), the model continued to ignore the spatial signal.
 *     Instruction-following multi-image edit models tokenize text-
 *     coordinates as language; they have no grounded spatial decoder.
 *
 * v5.0 moves spatial precision OUT of the model and INTO pixel-level
 * compositing. The pipeline:
 *   1. Background-removes the inspiration object via fal.ai BiRefNet.
 *   2. Scales + alpha-composites the cutout onto the room photo at the
 *      user-painted region — 100% spatial accuracy, no model involved.
 *   3. Runs a LOW-strength SDXL inpaint refine pass over the user's
 *      brush mask zone to blend lighting/shadows/edges. The model's
 *      role narrows to "make the composited cutout look natural in the
 *      room's lighting" — what edit models are actually good at.
 *
 * **What this builder emits.**
 *
 * A scene-level refine prompt directing the inpaint model to blend the
 * already-composited cutout into the room. No "image 1 / image 2 /
 * image 3" references, no bbox coordinates, no "replace the object"
 * instruction — by the time this prompt reaches the model, the object
 * is already pixel-perfect in the right region. The prompt's job is
 * only lighting/shadow/edge harmonization.
 *
 * **No CFG override.** The fal.ai `fal-ai/inpaint` (SDXL) and Replicate
 * `stability-ai/stable-diffusion-inpainting` endpoints both take a
 * `guidance_scale` knob but the adapters pin sensible defaults
 * (strength 0.35, ~7 guidance scale via the model defaults). The
 * builder ships `guidanceScale: 0` as the documented sentinel for "no
 * override required".
 *
 * See `docs/plans/2026-05-18-001-refactor-replace-add-object-v5-crop-composite-refine-plan.md`
 * for the full v4.x failure post-mortem and v5.0 design rationale.
 */

import type { z } from "zod";
import type { PromptResult } from "../types.js";
import type { CreateReplaceAddObjectBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT =
  "replaceAddObject/v6.0-kontext-inpaint";

export type ReplaceAddObjectParams = z.infer<typeof CreateReplaceAddObjectBody>;

// SDXL inpaint refine uses adapter-pinned defaults (strength 0.35,
// 20 inference steps). No caller override needed — shipping 0 here is
// the documented sentinel that means "use provider adapter defaults".
const REFINE_NO_OVERRIDE = 0;

// Fallback noun phrase when `inspirationTitle` reaches the builder
// empty. `preEnqueueValidate` in `src/lib/tool-types.ts` 409-rejects
// any inspiration with an empty title, but the type system can't
// enforce that, so a defensive default keeps a stray code path from
// emitting `${undefined}` in the prompt.
const FALLBACK_CATEGORY = "object";

/**
 * Build the v6.0 prompt for Flux Kontext LoRA Inpaint.
 *
 * Researcher's recommendation for Kontext-style endpoints: keep the
 * prompt SHORT and category-anchored. The reference image is the
 * authoritative identity signal — long descriptive prompts dilute it
 * because they fight the cross-attention conditioning that Kontext
 * uses to align the reference into the masked region. We name the
 * category (so the model knows what kind of object it is), keep the
 * scene-integration phrases brief, and let the reference image carry
 * color/material/proportions.
 */
export function buildReplaceAddObjectPrompt(
  params: ReplaceAddObjectParams,
): PromptResult {
  const category = params.inspirationTitle?.trim() || FALLBACK_CATEGORY;

  const prompt = (() => {
    switch (params.mode) {
      case "replace":
        return `place this ${category} in the masked region, replacing the existing object; match scene lighting, perspective, and shadows; preserve product color, material, and proportions`;
      case "add":
        return `place this ${category} in the masked region; match scene lighting, perspective, and shadows; preserve product color, material, and proportions`;
    }
    const _exhaustive: never = params.mode;
    throw new Error(
      `unreachable replaceAddObject mode: ${_exhaustive as string}`,
    );
  })();

  return {
    prompt,
    positiveAvoidance: "",
    guidanceScale: REFINE_NO_OVERRIDE,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion: PROMPT_VERSION_CURRENT,
  };
}
