/**
 * Exterior painting prompt builder — simpler sibling of exterior-design.
 *
 * Exterior painting only repaints the building and (optionally) swaps the
 * cladding/material. Unlike exterior-design there is no `designStyle` or
 * `buildingType` input — the prompt is driven by the chosen palette and
 * the cladding material directive.
 *
 * Reuses:
 * - `exteriorPalettes` dictionary (same 12 palettes as exterior-design).
 * - `buildPhotographyQuality("exterior")`, `buildStructuralPreservation("exterior")`,
 *   `buildPositiveAvoidance()` primitives.
 * - The standard token-budgeted `trimLayersToBudget` pipeline.
 *
 * Guidance is pinned to `"faithful"` (`KLEIN_GUIDANCE_BANDS["faithful"]`)
 * because the intent is to preserve the exact building geometry and only
 * restyle surface treatments — the same policy exterior-design uses in
 * structuralPreservation mode.
 *
 * `material === "keepOriginal"` emits "keep existing cladding, only change
 * paint color"; any other id emits "swap the cladding to {label}".
 *
 * R24 graceful fallback for unknown enums (colorPalette, material): returns a
 * generic exterior-painting fallback prompt.
 */

import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { exteriorPalettes } from "../dictionaries/color-palettes.js";
import { buildPhotographyQuality } from "../primitives/photography-quality.js";
import { buildPositiveAvoidance } from "../primitives/positive-avoidance.js";
import { buildStructuralPreservation } from "../primitives/structural-preservation.js";
import { trimLayersToBudget, type PromptLayer } from "../token-budget.js";
import type {
  ColorPaletteEntry,
  GuidanceBand,
  PromptResult,
} from "../types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const PROMPT_VERSION_CURRENT = "exteriorPainting/v1.0";
const PROMPT_VERSION_FALLBACK = "exteriorPainting/fallback-v1";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

// Exterior painting pins guidance to faithful — the whole point of the tool
// is to preserve building geometry and only restyle surface treatments.
const GUIDANCE_BAND: GuidanceBand = "faithful";

// ─── Material labels ───────────────────────────────────────────────────────

/**
 * Human-readable labels for the 9 cladding materials the iOS wizard exposes
 * (plus the `keepOriginal` sentinel). Mirrors
 * `HomeDecorAI/Features/Wizard/Models/ExteriorMaterial.swift`. Kept as a
 * local map rather than a shared dictionary — no other tool consumes these
 * today, and the set is small/stable enough that the cost of indirection
 * outweighs the reuse benefit.
 */
const MATERIAL_LABELS: Record<string, string> = {
  keepOriginal: "original cladding",
  texturedBrick: "textured brick cladding",
  vinylSiding: "vinyl siding",
  smoothStucco: "smooth stucco finish",
  naturalStone: "natural stone cladding",
  woodCladding: "wood cladding",
  metalPanel: "metal panel cladding",
  fiberCement: "fiber cement cladding",
  limestoneFacade: "limestone facade",
  concreteFacade: "concrete facade",
};

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ExteriorPaintingParams {
  colorPalette: string;
  material: string;
}

export function buildExteriorPaintingPrompt(
  params: ExteriorPaintingParams,
): PromptResult {
  const { colorPalette, material } = params;

  const paletteEntry =
    exteriorPalettes[colorPalette as keyof typeof exteriorPalettes];
  const materialLabel = MATERIAL_LABELS[material];

  if (!materialLabel) {
    logger.warn(
      {
        event: "prompt.unknown_material",
        tool: "exteriorPainting",
        material,
        fallback: "generic",
      },
      "Unknown exterior material — using generic fallback",
    );
    return buildExteriorPaintingGenericFallback();
  }

  // Missing palette is not fatal — fall back to a tasteful default below.
  const resolvedPalette = paletteEntry ?? null;

  return compose(material, materialLabel, resolvedPalette);
}

// ─── Composition ───────────────────────────────────────────────────────────

function compose(
  materialId: string,
  materialLabel: string,
  palette: ColorPaletteEntry | null,
): PromptResult {
  const keepMaterial = materialId === "keepOriginal";

  // Action directive differs by whether we swap cladding or only repaint.
  const actionDirective = keepMaterial
    ? `Repaint the exterior of this building while keeping the existing cladding and material intact — only change the paint colors and trim finishes. ` +
      `Keep the exact same building shape, roof line, window positions, door placements, and camera angle.`
    : `Swap the cladding and surface material of this building to ${materialLabel} and repaint it with a coordinated finish. ` +
      `Keep the exact same building shape, roof line, window positions, door placements, and camera angle.`;

  const materialFocus = keepMaterial
    ? `Preserve the existing cladding texture and layout; only the paint color layer changes.`
    : `Apply ${materialLabel} consistently across the main wall surfaces, respecting the building's existing geometry and trim breaks.`;

  // Color palette: when the user picked a concrete palette use its swatch;
  // otherwise (surpriseMe or unknown) fall back to a safe neutral.
  const effectivePalette =
    palette && palette.swatch.length > 0
      ? palette.swatch
      : ["warm stone", "soft cream", "charcoal trim", "oak accents"];
  const effectiveMood =
    palette && palette.mood ? palette.mood : "calm, balanced, approachable";
  const styleCore = `Color palette: ${effectivePalette.join(", ")}. Mood: ${effectiveMood}.`;

  const lighting = `Natural exterior daylight consistent with the input photograph, with clean, even light on the facade.`;

  return composeLayers(
    actionDirective,
    materialFocus,
    styleCore,
    lighting,
    PROMPT_VERSION_CURRENT,
  );
}

function buildExteriorPaintingGenericFallback(): PromptResult {
  const actionDirective =
    `Repaint the exterior of this building with a tasteful, timeless palette while keeping the exact same building shape, ` +
    `roof line, window positions, door placements, and camera angle. Only restyle surface treatments and paint colors.`;

  const materialFocus = `Preserve the existing cladding texture and layout; only the paint color layer changes.`;

  const styleCore = `Color palette: warm stone, soft cream, charcoal trim, oak accents. Mood: calm, balanced, approachable.`;

  const lighting = `Natural exterior daylight consistent with the input photograph.`;

  return composeLayers(
    actionDirective,
    materialFocus,
    styleCore,
    lighting,
    PROMPT_VERSION_FALLBACK,
  );
}

// ─── Shared composition pipeline ───────────────────────────────────────────

function composeLayers(
  actionDirective: string,
  materialFocus: string,
  styleCore: string,
  lighting: string,
  promptVersion: string,
): PromptResult {
  const positiveAvoidance = buildPositiveAvoidance([
    "clean architectural lines",
    "intact roof line",
    "consistent paint finish",
  ]);

  const layers: PromptLayer[] = [
    {
      name: "action+focus",
      priority: 1,
      text: `${actionDirective} ${materialFocus}`,
    },
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
      `Exterior painting prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
    );
  }

  return {
    prompt: trimResult.composed,
    positiveAvoidance,
    guidanceScale: KLEIN_GUIDANCE_BANDS[GUIDANCE_BAND],
    actionMode: "transform",
    guidanceBand: GUIDANCE_BAND,
    promptVersion,
  };
}
