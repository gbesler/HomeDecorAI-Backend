/**
 * Floor-restyle prompt builder.
 *
 * Two mutually exclusive modes mirroring the iOS wizard:
 *   1. `texture`: one of the 16 preset finishes (oakWood, walnut,
 *      whiteMarble, hexagon, herringbone, ...). Dictionary-driven.
 *   2. `customStyle`: freeform user prompt + optional reference image.
 *      Freeform text is inlined into the action directive; when a reference
 *      image is provided, the request becomes a multi-image call and the
 *      prompt references "image 2" as the style source for the flooring.
 *
 * Every prompt is wrapped with the shared `structural-preservation`,
 * `positive-avoidance`, and `photography-quality` primitives so the output
 * preserves room geometry regardless of mode. The focus directive explicitly
 * lists walls, furniture, ceiling, fixtures, artwork, and decor as preserved
 * — only the flooring receives the new finish.
 *
 * Phrasing rule: Flux models do not honor negation. Every directive is
 * written as a positive description of the desired output.
 */

import type { z } from "zod";
import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { floorTextures } from "../dictionaries/floor-textures.js";
import { buildPhotographyQuality } from "../primitives/photography-quality.js";
import { buildPositiveAvoidance } from "../primitives/positive-avoidance.js";
import { buildStructuralPreservation } from "../primitives/structural-preservation.js";
import { trimLayersToBudget, type PromptLayer } from "../token-budget.js";
import type { PromptResult, FloorTextureEntry } from "../types.js";
import type { CreateFloorRestyleBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "floorRestyle/v1.0";
const PROMPT_VERSION_FALLBACK = "floorRestyle/fallback-v1";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

/**
 * Character ceiling for the user-supplied custom prompt. The Zod schema
 * already caps at 500 chars; this cap is defensive against a drift in the
 * schema and keeps the action directive from blowing past the token budget.
 */
const CUSTOM_PROMPT_MAX_CHARS = 500;

export type FloorRestyleParams = z.infer<typeof CreateFloorRestyleBody>;

export function buildFloorRestylePrompt(
  params: FloorRestyleParams,
): PromptResult {
  if (params.floorStyleMode === "texture") {
    const entry = params.textureId
      ? floorTextures[params.textureId]
      : undefined;
    if (!entry) {
      logger.warn(
        {
          event: "prompt.unknown_texture",
          tool: "floorRestyle",
          textureId: params.textureId,
          fallback: "generic",
        },
        "Unknown textureId — using generic floor-restyle fallback",
      );
      return buildGenericFallback();
    }
    return composeTextureMode(entry);
  }

  // customStyle mode — freeform prompt, optional reference image.
  const raw = (params.customPrompt ?? "").trim();
  if (raw.length === 0) {
    logger.warn(
      {
        event: "prompt.empty_custom_prompt",
        tool: "floorRestyle",
        fallback: "generic",
      },
      "Empty customPrompt on floor-restyle request — using generic fallback",
    );
    return buildGenericFallback();
  }
  const clipped = raw.slice(0, CUSTOM_PROMPT_MAX_CHARS);
  const hasReference =
    typeof params.referenceImageUrl === "string" &&
    params.referenceImageUrl.length > 0;
  return composeCustomMode(clipped, hasReference);
}

// ─── Texture mode ─────────────────────────────────────────────────────────

function composeTextureMode(entry: FloorTextureEntry): PromptResult {
  const actionDirective =
    `Restyle the flooring in this room to ${entry.label}. ${entry.description}`;

  const styleCore = `Finish character: ${entry.descriptors.join(", ")}.`;

  const lighting = entry.lightingCharacter;

  return composeLayers(
    actionDirective,
    styleCore,
    lighting,
    PROMPT_VERSION_CURRENT,
  );
}

// ─── Custom mode ──────────────────────────────────────────────────────────

function composeCustomMode(
  customPrompt: string,
  hasReference: boolean,
): PromptResult {
  const actionDirective = hasReference
    ? `Restyle the flooring in this room (image 1) to match the aesthetic ` +
      `described as: "${customPrompt}". Use image 2 as the primary style reference ` +
      `for the floor finish and palette.`
    : `Restyle the flooring in this room to match the aesthetic described ` +
      `as: "${customPrompt}".`;

  const styleCore = hasReference
    ? `Confine the floor material, color, and pattern to what is visible in image 2.`
    : `Apply the described finish consistently across every floor plane.`;

  const lighting =
    "Maintain the original room's daylight direction and overall warmth.";

  return composeLayers(
    actionDirective,
    styleCore,
    lighting,
    PROMPT_VERSION_CURRENT,
  );
}

// ─── Generic fallback (unknown texture / empty custom prompt) ────────────

function buildGenericFallback(): PromptResult {
  const actionDirective =
    "Restyle the flooring in this room with a tasteful, natural oak hardwood finish.";
  const styleCore =
    "Finish character: warm honey tone, visible grain, matte satin surface.";
  const lighting =
    "Soft warm daylight; the grain reads as a gentle rhythm across the floor.";

  return composeLayers(
    actionDirective,
    styleCore,
    lighting,
    PROMPT_VERSION_FALLBACK,
  );
}

// ─── Shared composition ──────────────────────────────────────────────────

function composeLayers(
  actionDirective: string,
  styleCore: string,
  lighting: string,
  promptVersion: string,
): PromptResult {
  const focusDirective =
    "Keep every other element in image 1 identical — furniture, walls, " +
    "ceiling, fixtures, artwork, and decor stay exactly as they are; only " +
    "the flooring receives the new finish.";

  const positiveAvoidance = buildPositiveAvoidance([
    "faithful to original room geometry",
    "faithful to original furniture and decor",
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
        tool: "floorRestyle",
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Floor-restyle prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
    );
  }

  return {
    prompt: trimResult.composed,
    positiveAvoidance,
    // Floor-restyle is geometry-sensitive — only floor surfaces change.
    guidanceScale: KLEIN_GUIDANCE_BANDS.faithful,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion,
  };
}
