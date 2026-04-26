/**
 * Exterior Painting prompt builder.
 *
 * Narrower scope than exterior-design: the iOS wizard collects only a photo,
 * a color palette (12 presets shared with exterior-design), and a material
 * choice (9 concrete materials + the `keepOriginal` sentinel). There is no
 * designStyle and no buildingType.
 *
 * Two modes mirror the iOS `ExteriorMaterial.keepOriginal` sentinel:
 *   1. `keepOriginal`: paint-only — repaint exterior surfaces with the
 *      chosen palette, preserving the existing cladding material identically.
 *   2. any other material id: material swap + paint — replace the exterior
 *      cladding with the selected material, finished in the chosen palette.
 *
 * Reuses:
 * - `exteriorPalettes` dictionary for palette → swatch + mood.
 * - `exteriorMaterials` dictionary for material → label + descriptors.
 * - `buildStructuralPreservation("exterior")`, `buildPhotographyQuality("exterior")`,
 *   `buildPositiveAvoidance()` primitives.
 *
 * Guidance band is always `faithful`: this is a surface/material edit and
 * the building massing, roof line, openings, and camera angle must survive.
 *
 * Phrasing rule: Flux models do not honor negation. Every directive is
 * written as a positive description of the desired output; geometry
 * preservation is delegated to `buildStructuralPreservation("exterior")`.
 */

import type { z } from "zod";
import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { exteriorPalettes } from "../dictionaries/color-palettes.js";
import { exteriorMaterials } from "../dictionaries/exterior-materials.js";
import { buildPhotographyQuality } from "../primitives/photography-quality.js";
import { buildPositiveAvoidance } from "../primitives/positive-avoidance.js";
import { buildStructuralPreservation } from "../primitives/structural-preservation.js";
import { trimLayersToBudget, type PromptLayer } from "../token-budget.js";
import type {
  ColorPaletteEntry,
  ExteriorMaterialEntry,
  PromptResult,
} from "../types.js";
import type { CreateExteriorPaintingBody } from "../../../schemas/generated/api.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const PROMPT_VERSION_CURRENT = "exteriorPainting/v1.0";
const PROMPT_VERSION_FALLBACK = "exteriorPainting/fallback-v1";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

// ─── Public API ─────────────────────────────────────────────────────────────

export type ExteriorPaintingParams = z.infer<typeof CreateExteriorPaintingBody>;

export function buildExteriorPaintingPrompt(
  params: ExteriorPaintingParams,
): PromptResult {
  const paletteEntry =
    exteriorPalettes[params.colorPalette as keyof typeof exteriorPalettes] ??
    null;

  const isKeepOriginal = params.material === "keepOriginal";

  if (isKeepOriginal) {
    return composePaintOnly(paletteEntry);
  }

  const materialEntry =
    exteriorMaterials[params.material as keyof typeof exteriorMaterials];

  if (!materialEntry) {
    logger.warn(
      {
        event: "prompt.unknown_material",
        tool: "exteriorPainting",
        material: params.material,
        fallback: "generic",
      },
      "Unknown exterior material — using generic fallback",
    );
    return composeGenericFallback(paletteEntry);
  }

  return composeMaterialSwap(paletteEntry, materialEntry);
}

// ─── Paint-only mode (keepOriginal) ────────────────────────────────────────

function composePaintOnly(palette: ColorPaletteEntry | null): PromptResult {
  const { styleCore, paletteDescriptor } = resolvePalette(palette);

  const actionDirective =
    `Repaint the exterior surfaces of this building in ${paletteDescriptor}. ` +
    `Keep the existing cladding material, surface texture, and finish identical — ` +
    `only the paint color changes.`;

  return compose(actionDirective, styleCore, PROMPT_VERSION_CURRENT);
}

// ─── Material swap mode (any other material) ────────────────────────────────

function composeMaterialSwap(
  palette: ColorPaletteEntry | null,
  material: ExteriorMaterialEntry,
): PromptResult {
  const { styleCore, paletteDescriptor } = resolvePalette(palette);

  const actionDirective =
    `Reclad the exterior surfaces of this building with ${material.label}, finished in ${paletteDescriptor}. ` +
    `${material.description} ` +
    `Material character: ${material.descriptors.join(", ")}.`;

  return compose(actionDirective, styleCore, PROMPT_VERSION_CURRENT);
}

// ─── Generic fallback (unknown material) ───────────────────────────────────

function composeGenericFallback(
  palette: ColorPaletteEntry | null,
): PromptResult {
  const { styleCore, paletteDescriptor } = resolvePalette(palette);

  const actionDirective =
    `Repaint and refinish the exterior surfaces of this building in ${paletteDescriptor} ` +
    `using tasteful, timeless material finishes.`;

  return compose(actionDirective, styleCore, PROMPT_VERSION_FALLBACK);
}

// ─── Shared composition ──────────────────────────────────────────────────

function compose(
  actionDirective: string,
  styleCore: string,
  promptVersion: string,
): PromptResult {
  const positiveAvoidance = buildPositiveAvoidance("exterior", [
    "intact roof line",
    "clean architectural lines",
    "faithful to original building massing",
  ]);

  const lighting =
    "Natural exterior daylight consistent with the input photograph.";

  const layers: PromptLayer[] = [
    { name: "action+focus", priority: 1, text: actionDirective },
    { name: "style-core", priority: 2, text: styleCore },
    {
      name: "structural-preservation",
      priority: 3,
      text: buildStructuralPreservation("exterior"),
    },
    { name: "positive-avoidance", priority: 4, text: positiveAvoidance },
    {
      name: "photography-quality",
      priority: 5,
      text: buildPhotographyQuality("exterior"),
    },
    { name: "lighting", priority: 6, text: lighting },
  ];

  const trimResult = trimLayersToBudget(layers, PRIMARY_MAX_TOKENS);

  if (trimResult.droppedLayers.length > 0) {
    logger.warn(
      {
        event: "prompt.token_truncation",
        tool: "exteriorPainting",
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Exterior-painting prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
    );
  }

  return {
    prompt: trimResult.composed,
    positiveAvoidance,
    guidanceScale: KLEIN_GUIDANCE_BANDS.faithful,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion,
  };
}

// ─── Palette resolution ────────────────────────────────────────────────────

/**
 * Resolve the color palette for the prompt. The `surpriseMe` sentinel has
 * an empty swatch — in that case we ask for a "tasteful, balanced" palette
 * and leave the model to choose.
 */
function resolvePalette(
  palette: ColorPaletteEntry | null,
): { paletteDescriptor: string; styleCore: string } {
  if (!palette || palette.swatch.length === 0) {
    return {
      paletteDescriptor: "a tasteful, balanced palette",
      styleCore:
        "Color palette: tasteful, balanced, harmonious with the building's surroundings.",
    };
  }
  return {
    paletteDescriptor: `a ${palette.mood} palette of ${palette.swatch.join(", ")}`,
    styleCore: `Color palette: ${palette.swatch.join(", ")}. Mood: ${palette.mood}.`,
  };
}
