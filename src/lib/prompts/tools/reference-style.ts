/**
 * Reference-style prompt builder.
 *
 * Unlike interior/exterior/garden, this tool has no dictionaries — the style
 * is carried entirely by the reference image (image 2). The prompt's job is
 * to direct the model to:
 *   1. Restyle image 1 to match image 2's aesthetic
 *   2. Preserve image 1's geometry (walls, windows, layout)
 *   3. Adopt only image 2's palette, materials, lighting, and mood
 *
 * Producers: Pruna `p-image-edit` (images[0]=target, images[1]=reference,
 * `reference_image: "2"`) and fal `flux-2/klein/9b/edit` (image_urls=[target,
 * ref] when capabilities.supportsReferenceImage=true). Both accept explicit
 * "image 1 / image 2" references in the prompt text.
 *
 * Phrasing rule: Flux-2 models are not trained to interpret negative
 * instructions ("do not", "avoid", "without") — those bias the model toward
 * the negated content. Every directive in this builder is positively framed,
 * mirroring the invariant in `primitives/positive-avoidance.ts`.
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

const PROMPT_VERSION = "referenceStyle/v1.0";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

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

  // Tightened action+focus to leave token budget headroom for the
  // photography-quality and positive-avoidance layers.
  const actionDirective =
    `Restyle image 1 (the ${scopeNoun}) to match the aesthetic of image 2 (the reference). ` +
    `Apply image 2's color palette, materials, finishes, and lighting mood to image 1.`;

  const focusDirective =
    spaceType === "interior"
      ? `Use image 2 as a vocabulary source for wall finishes, flooring, textiles, ` +
        `lighting fixtures, and accent decor. Keep image 1's existing furniture in place ` +
        `and merely restyle their materials and colors to match image 2's language.`
      : `Use image 2 as a vocabulary source for facade materials, cladding, trim colors, ` +
        `window frame finishes, roofing character, and landscaping mood. Keep image 1's ` +
        `building shape, openings, and surrounding hardscape positions intact.`;

  const styleCore =
    `Confine the palette, materials, and mood to those visible in image 2.`;

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
    // Reference-style is geometry-sensitive — bias toward faithful guidance
    // on providers that honor it. Pruna ignores the value entirely.
    guidanceScale: KLEIN_GUIDANCE_BANDS.faithful,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion: PROMPT_VERSION,
  };
}
