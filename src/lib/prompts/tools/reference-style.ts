/**
 * Reference-style prompt builder.
 *
 * Unlike interior/exterior/garden, this tool has no dictionaries — the style
 * is carried entirely by the reference image (image 2). The prompt's job is
 * to direct the model to:
 *   1. Restyle image 1 to match image 2's aesthetic
 *   2. Preserve image 1's geometry (walls, windows, layout)
 *   3. Adopt image 2's palette, materials, lighting, and mood
 *
 * Producers: primary is fal `flux-pro/kontext/max/multi` (image_urls=[target,
 * ref]); fallback is Replicate `google/nano-banana` (image_input=[target,
 * ref]). Both understand "image 1 / image 2" references in the prompt text.
 *
 * History: this tool previously shipped on `prunaai/p-image-edit` primary +
 * `fal-ai/flux-2/klein/9b/edit` fallback. Pruna produced near-identity
 * output — a distilled sub-second edit model is not trained for cross-image
 * style transfer. The v2 build retires the "merely restyle materials"
 * hedging that was written to nudge Pruna; Kontext Multi and Nano Banana
 * both handle direct transfer directives.
 *
 * Phrasing rule: Flux-2 and Kontext models are not trained to interpret
 * negative instructions ("do not", "avoid", "without") — those bias the
 * model toward the negated content. Every directive in this builder is
 * positively framed, mirroring the invariant in
 * `primitives/positive-avoidance.ts`.
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
import type { CreateReferenceStyleBody } from "../../../schemas/generated/api.js";
import type { SpaceType } from "../../../schemas/generated/types/spaceType.js";

const PROMPT_VERSION = "referenceStyle/v2.0";

const PRIMARY_MODEL = "fal-ai/flux-pro/kontext/max/multi";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 350;

/**
 * The full validated body shape — declared as the single source of truth for
 * `TParams` so the registry's type contract matches what `fromToolParams`
 * actually returns at runtime. The prompt builder destructures only
 * `spaceType`, but downstream code (processor, tests) sees the full shape.
 */
export type ReferenceStyleParams = z.infer<typeof CreateReferenceStyleBody>;

export function buildReferenceStylePrompt(
  params: ReferenceStyleParams,
): PromptResult {
  const { spaceType }: { spaceType: SpaceType } = params;

  const scopeNoun = spaceType === "interior" ? "room" : "building";

  // Transfer-first directive. Kontext Max Multi and Nano Banana both handle
  // cross-image style transfer natively — there is no need to soften with
  // "merely restyle". The preceding structural-preservation layer supplies
  // the constraint that geometry stays fixed; this layer's job is to push
  // hard on adopting image 2's visual language.
  const actionDirective =
    `Apply the full visual language of image 2 (the reference) to image 1 (the ${scopeNoun}). ` +
    `Adopt image 2's color palette, materials, finishes, textures, and lighting mood as the dominant aesthetic of image 1.`;

  const focusDirective =
    spaceType === "interior"
      ? `Replace image 1's wall finishes, flooring materials, textile colors, lighting fixtures, ` +
        `and accent decor with counterparts drawn from image 2's language. Preserve image 1's ` +
        `furniture shapes and placement; reskin their upholstery, wood tones, and metals to ` +
        `match image 2.`
      : `Replace image 1's facade materials, cladding treatment, trim colors, window frame ` +
        `finishes, and roofing character with counterparts drawn from image 2. Preserve image 1's ` +
        `building silhouette, opening positions, and hardscape layout; reskin only the surfaces.`;

  const styleCore =
    `The result's palette, materials, and lighting should read as image 2's aesthetic applied to image 1's scene.`;

  const positiveAvoidance = buildPositiveAvoidance([
    "faithful to image 2 style",
    "faithful to image 1 geometry",
  ]);

  const layers: PromptLayer[] = [
    { name: "action+focus", priority: 1, text: `${actionDirective} ${focusDirective}` },
    { name: "style-core", priority: 2, text: styleCore },
    {
      name: "structural-preservation",
      priority: 3,
      text: buildStructuralPreservation(spaceType),
    },
    { name: "positive-avoidance", priority: 4, text: positiveAvoidance },
    {
      name: "photography-quality",
      priority: 5,
      text: buildPhotographyQuality(spaceType),
    },
  ];

  const trimResult = trimLayersToBudget(layers, PRIMARY_MAX_TOKENS);

  if (trimResult.droppedLayers.length > 0) {
    logger.warn(
      {
        event: "prompt.token_truncation",
        tool: "referenceStyle",
        spaceType,
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Reference-style prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
    );
  }

  return {
    prompt: trimResult.composed,
    positiveAvoidance,
    // Kontext Max Multi default guidance is 3.5. We ship `balanced` (3.0)
    // because style transfer needs headroom for the model to diverge from
    // image 1's surface appearance while the structural-preservation layer
    // in the prompt handles geometry. `faithful` (5.0) was the Pruna-era
    // setting; with a transfer-capable model it over-preserves the input
    // and reproduces the near-identity failure mode we migrated off of.
    guidanceScale: KLEIN_GUIDANCE_BANDS.balanced,
    actionMode: "transform",
    guidanceBand: "balanced",
    promptVersion: PROMPT_VERSION,
  };
}
