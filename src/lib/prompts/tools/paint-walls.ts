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
 * Layer assembly + token-budget enforcement is delegated to the shared
 * `composeSurfaceRestyleLayers` helper. Per-subject strings (action
 * directives, style cores, lighting copy, generic fallback, focus
 * directive) stay local so the prompt content for paint-walls is readable
 * in one place.
 *
 * Phrasing rule: Flux models do not honor negation. Every directive is
 * written as a positive description of the desired output.
 */

import type { z } from "zod";
import { logger } from "../../logger.js";
import { wallTextures } from "../dictionaries/wall-textures.js";
import type { PromptResult, WallTextureEntry } from "../types.js";
import type { CreatePaintWallsBody } from "../../../schemas/generated/api.js";
import {
  composeSurfaceRestyleLayers,
  type SurfaceRestyleConfig,
} from "./_surface-restyle-base.js";

const PROMPT_VERSION_CURRENT = "paintWalls/v1.0";
const PROMPT_VERSION_FALLBACK = "paintWalls/fallback-v1";

/**
 * Character ceiling for the user-supplied custom prompt. The Zod schema
 * already caps at 500 chars; this cap is defensive against a drift in the
 * schema and keeps the action directive from blowing past the token budget.
 */
const CUSTOM_PROMPT_MAX_CHARS = 500;

const SURFACE_CONFIG: SurfaceRestyleConfig = {
  tool: "paintWalls",
  humanLabel: "Paint-walls",
  focusDirective:
    "Keep every other element in image 1 identical — furniture, flooring, " +
    "ceiling, fixtures, artwork, and decor stay exactly as they are; only the " +
    "wall surfaces receive the new finish.",
};

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
          tool: "paintWalls",
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
        tool: "paintWalls",
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

  return composeSurfaceRestyleLayers(
    actionDirective,
    styleCore,
    lighting,
    PROMPT_VERSION_CURRENT,
    SURFACE_CONFIG,
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

  return composeSurfaceRestyleLayers(
    actionDirective,
    styleCore,
    lighting,
    PROMPT_VERSION_CURRENT,
    SURFACE_CONFIG,
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

  return composeSurfaceRestyleLayers(
    actionDirective,
    styleCore,
    lighting,
    PROMPT_VERSION_FALLBACK,
    SURFACE_CONFIG,
  );
}
