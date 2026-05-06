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
import { surfaceRestyleLightingAnchor } from "../primitives/lighting-anchors.js";
import type { PromptResult, WallTextureEntry } from "../types.js";
import type { CreatePaintWallsBody } from "../../../schemas/generated/api.js";
import {
  composeSurfaceRestyleLayers,
  sanitizeCustomPrompt,
  type SurfaceRestyleConfig,
} from "./_surface-restyle-base.js";

const PROMPT_VERSION_CURRENT = "paintWalls/v1.1";
const PROMPT_VERSION_FALLBACK = "paintWalls/fallback-v1.1";

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
  const sanitized = sanitizeCustomPrompt(params.customPrompt ?? "");
  if (sanitized.length === 0) {
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
  const clipped = sanitized.slice(0, CUSTOM_PROMPT_MAX_CHARS);
  const hasReference =
    typeof params.referenceImageUrl === "string" &&
    params.referenceImageUrl.length > 0;
  return composeCustomMode(clipped, hasReference);
}

// ─── Texture mode ─────────────────────────────────────────────────────────

function composeTextureMode(entry: WallTextureEntry): PromptResult {
  const actionDirective =
    `Restyle the wall surfaces in this room to a ${entry.label} finish. ${entry.description}`;

  // Fold the texture's lightingCharacter into the style-core layer so the
  // model reads it as a property of the painted surface (how the finish
  // responds to light) rather than a directive about the room's lighting.
  // Anchoring the lighting layer to the input photo prevents drift in the
  // room's overall illumination — same fix patio/pool/garden already apply.
  const styleCore =
    `Finish character: ${entry.descriptors.join(", ")}. ` +
    `Surface response: ${entry.lightingCharacter}`;

  const lighting = surfaceRestyleLightingAnchor("wall");

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
  // Defensive scope prefix: the user's freeform prompt is inlined verbatim
  // into the priority-1 layer. An adversarial or careless prompt like
  // "different angle, knock down the wall" would otherwise compete with
  // the priority-3 structural-preservation primitive. Framing the
  // freeform text as a description of the wall finish — rather than a
  // free instruction to the model — keeps the request scoped even when
  // the user fights it.
  const actionDirective = hasReference
    ? `Restyle the wall surfaces in this room (image 1) to match the aesthetic ` +
      `described as: "${customPrompt}". Use image 2 as the primary style reference ` +
      `for the wall finish and palette. Only the wall material, color, and pattern ` +
      `are in scope; the room's geometry, camera angle, and every other surface stay ` +
      `identical to image 1.`
    : `Restyle the wall surfaces in this room to match the aesthetic described ` +
      `as: "${customPrompt}". Only the wall material, color, and pattern are in ` +
      `scope; the room's geometry, camera angle, and every other surface stay ` +
      `identical to the input photograph.`;

  const styleCore = hasReference
    ? `Confine the wall material, color, and pattern to what is visible in image 2.`
    : `Apply the described finish consistently across every wall plane.`;

  const lighting =
    "Preserve the input photograph's existing daylight direction, warmth, and " +
    "time of day; only the wall finish responds differently to that light.";

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
    "Finish character: soft velvet-like, non-reflective, balanced warm neutral. " +
    "Surface response: absorbs light without specular highlights.";
  const lighting =
    "Preserve the input photograph's existing lighting, daylight direction, " +
    "and time of day.";

  return composeSurfaceRestyleLayers(
    actionDirective,
    styleCore,
    lighting,
    PROMPT_VERSION_FALLBACK,
    SURFACE_CONFIG,
  );
}
