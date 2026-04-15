/**
 * Paint-walls prompt builder.
 *
 * Two mutually exclusive modes mirroring the iOS wizard:
 *   1. `texture`: one of the 18 preset finishes (matte, venetianPlaster,
 *      brick, shiplap, geometric, ...). Dictionary-driven.
 *   2. `customStyle`: freeform user prompt + optional reference image.
 *      Freeform text is inlined into the action directive; when a reference
 *      image is provided, the request becomes a multi-image call and the
 *      prompt references "image 2" as the style source for the walls.
 *
 * Every prompt is wrapped with the shared `structural-preservation`,
 * `positive-avoidance`, and `photography-quality` primitives so the output
 * preserves room geometry regardless of mode.
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
import { wallTextures } from "../dictionaries/wall-textures.js";
import { buildPhotographyQuality } from "../primitives/photography-quality.js";
import { buildPositiveAvoidance } from "../primitives/positive-avoidance.js";
import { buildStructuralPreservation } from "../primitives/structural-preservation.js";
import { trimLayersToBudget, type PromptLayer } from "../token-budget.js";
import type { PromptResult, WallTextureEntry } from "../types.js";
import type { CreatePaintWallsBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "paintWalls/v1.0";
const PROMPT_VERSION_FALLBACK = "paintWalls/fallback-v1";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

/**
 * Character ceiling for the user-supplied custom prompt. The Zod schema
 * already caps at 500 chars; this cap is defensive against a drift in the
 * schema and keeps the action directive from blowing past the token budget.
 */
const CUSTOM_PROMPT_MAX_CHARS = 500;

export type PaintWallsParams = z.infer<typeof CreatePaintWallsBody>;

export function buildPaintWallsPrompt(params: PaintWallsParams): PromptResult {
  if (params.wallStyleMode === "texture") {
    const entry = params.textureId
      ? wallTextures[params.textureId]
      : undefined;
    if (!entry) {
      logger.warn(
        {
          event: "prompt.unknown_texture",
          textureId: params.textureId,
          fallback: "generic",
        },
        "Unknown textureId — using generic paint-walls fallback",
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
        fallback: "generic",
      },
      "Empty customPrompt on paint-walls request — using generic fallback",
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

function composeTextureMode(entry: WallTextureEntry): PromptResult {
  const actionDirective =
    `Restyle the wall surfaces in this room to a ${entry.label} finish. ${entry.description}`;

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
    ? `Restyle the wall surfaces in this room (image 1) to match the aesthetic ` +
      `described as: "${customPrompt}". Use image 2 as the primary style reference ` +
      `for the wall finish and palette.`
    : `Restyle the wall surfaces in this room to match the aesthetic described ` +
      `as: "${customPrompt}".`;

  const styleCore = hasReference
    ? `Confine the wall material, color, and pattern to what is visible in image 2.`
    : `Apply the described finish consistently across every wall plane.`;

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
    "Restyle the wall surfaces in this room with a tasteful, neutral, matte-finish paint.";
  const styleCore =
    "Finish character: soft velvet-like, non-reflective, balanced warm neutral.";
  const lighting =
    "Soft even daylight; the wall surface absorbs light without specular highlights.";

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
    "Keep every other element in image 1 identical — furniture, flooring, " +
    "ceiling, fixtures, artwork, and decor stay exactly as they are; only the " +
    "wall surfaces receive the new finish.";

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
        tool: "paintWalls",
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Paint-walls prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
    );
  }

  return {
    prompt: trimResult.composed,
    positiveAvoidance,
    // Paint-walls is geometry-sensitive — only wall surfaces change.
    guidanceScale: KLEIN_GUIDANCE_BANDS.faithful,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion,
  };
}
