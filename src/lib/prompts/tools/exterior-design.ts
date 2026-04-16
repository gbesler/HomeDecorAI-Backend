/**
 * Exterior design prompt builder — mirrors the interior 7-layer composition
 * pattern with exterior-specific subject + dictionaries.
 *
 * Reuses:
 * - `designStyles` dictionary (same 18 styles as interior; exterior drops
 *   the interior-only `signatureItems` slot from the composition).
 * - `buildPhotographyQuality("exterior")`, `buildStructuralPreservation("exterior")`,
 *   `buildPositiveAvoidance()` primitives.
 *
 * Exterior-specific:
 * - `buildingTypes` dictionary provides massing + signature features for
 *   the action directive and focus layer.
 * - `exteriorPalettes` overrides the style's native palette when not `surpriseMe`.
 * - `colorMode === "structuralPreservation"` forces `guidanceBand: "faithful"`
 *   and prepends a geometry-preserving directive. `renovationDesign` uses
 *   the style's native band.
 *
 * R24 graceful fallback for unknown enums (buildingType, designStyle,
 * colorPalette): returns a generic exterior fallback prompt.
 */

import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { buildingTypes } from "../dictionaries/building-types.js";
import { exteriorPalettes } from "../dictionaries/color-palettes.js";
import { designStyles } from "../dictionaries/design-styles.js";
import { buildPhotographyQuality } from "../primitives/photography-quality.js";
import { buildPositiveAvoidance } from "../primitives/positive-avoidance.js";
import { buildStructuralPreservation } from "../primitives/structural-preservation.js";
import { trimLayersToBudget, type PromptLayer } from "../token-budget.js";
import type {
  BuildingEntry,
  ColorPaletteEntry,
  GuidanceBand,
  PromptResult,
  StyleEntry,
} from "../types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const PROMPT_VERSION_CURRENT = "exteriorDesign/v1.0";
const PROMPT_VERSION_FALLBACK = "exteriorDesign/fallback-v1";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ExteriorParams {
  buildingType: string;
  designStyle: string;
  colorMode: "structuralPreservation" | "renovationDesign";
  colorPalette: string;
}

export function buildExteriorPrompt(params: ExteriorParams): PromptResult {
  const { buildingType, designStyle, colorMode, colorPalette } = params;

  const styleEntry = designStyles[designStyle as keyof typeof designStyles];
  const buildingEntry =
    buildingTypes[buildingType as keyof typeof buildingTypes];
  const paletteEntry =
    exteriorPalettes[colorPalette as keyof typeof exteriorPalettes];

  if (!styleEntry || !buildingEntry) {
    if (!styleEntry) {
      logger.warn(
        {
          event: "prompt.unknown_style",
          tool: "exteriorDesign",
          designStyle,
          buildingType,
          fallback: "generic",
        },
        "Unknown designStyle for exterior — using generic fallback",
      );
    }
    if (!buildingEntry) {
      logger.warn(
        {
          event: "prompt.unknown_building",
          tool: "exteriorDesign",
          buildingType,
          fallback: "generic",
        },
        "Unknown buildingType — using generic fallback",
      );
    }
    return buildExteriorGenericFallback(buildingType, colorMode);
  }

  // Missing palette is not fatal — fall back to the style's native palette.
  const resolvedPalette = paletteEntry ?? null;

  return compose(
    buildingType,
    styleEntry,
    buildingEntry,
    colorMode,
    resolvedPalette,
  );
}

// ─── Composition ───────────────────────────────────────────────────────────

function compose(
  buildingType: string,
  style: StyleEntry,
  building: BuildingEntry,
  colorMode: ExteriorParams["colorMode"],
  palette: ColorPaletteEntry | null,
): PromptResult {
  const preservationMode = colorMode === "structuralPreservation";
  const guidanceBand: GuidanceBand = preservationMode
    ? "faithful"
    : style.guidanceBand;

  // Action directive differs by colorMode.
  const actionDirective = preservationMode
    ? `Change the paint and surface finishes of this ${building.label} to a ${style.coreAesthetic} ${style.moodKeywords[0] ?? "balanced"} palette ` +
      `while keeping the exact same building shape, roof line, window positions, door placements, and camera angle. ` +
      `Only restyle the surface treatments, paint colors, cladding finishes, and trim details.`
    : `Restyle the exterior finishes of this ${building.label} to a ${style.coreAesthetic} ${style.moodKeywords[0] ?? "balanced"} aesthetic ` +
      `while keeping the exact same building shape and camera angle. ` +
      `Change the cladding, paint colors, and surface treatments.`;

  const buildingFocus =
    `Characterize it as a ${building.massingDescriptor}. ` +
    `Keep ${building.signatureFeatures.join(", ")}.`;

  // Color palette: override the style's native palette when the user
  // picked a concrete palette (non-empty swatch).
  const effectivePalette =
    palette && palette.swatch.length > 0 ? palette.swatch : style.colorPalette;
  const effectiveMood =
    palette && palette.mood ? palette.mood : style.moodKeywords.join(", ");
  const styleCore = `Color palette: ${effectivePalette.join(", ")}. Mood: ${effectiveMood}.`;

  // Exterior skips the interior-specific `signatureItems` slot (those describe
  // furniture like "low-profile sectional sofa"). Only materials go into
  // styleDetail for exterior.
  const styleDetail = `Materials and surface treatments: ${style.materials.join(", ")}.`;

  // Lighting — use the style's lighting character but anchor it as an
  // exterior natural light cue.
  const lighting =
    `Natural exterior daylight consistent with the input photograph, with ${style.lightingCharacter}.`;

  return composeLayers(
    actionDirective,
    buildingFocus,
    styleCore,
    styleDetail,
    lighting,
    style.actionMode,
    guidanceBand,
    PROMPT_VERSION_CURRENT,
  );
}

function buildExteriorGenericFallback(
  buildingType: string,
  colorMode: ExteriorParams["colorMode"],
): PromptResult {
  const label = buildingType || "building";
  const preservationMode = colorMode === "structuralPreservation";

  const actionDirective = preservationMode
    ? `Change the paint and surface finishes of this ${label} to a tasteful, timeless palette with natural materials ` +
      `while keeping the exact same building shape and camera angle. Only restyle surface treatments.`
    : `Restyle the exterior finishes of this ${label} to a tasteful, timeless look with natural materials and a warm neutral palette ` +
      `while keeping the exact same building shape and camera angle.`;

  const buildingFocus = `Keep the building's characteristic features, entrance, and window rhythm intact.`;

  const styleCore = `Color palette: warm stone, soft cream, charcoal trim, oak accents. Mood: calm, balanced, approachable.`;

  const styleDetail = `Materials and surface treatments: natural stone, brushed wood cladding, painted metal trim, clean stucco.`;

  const lighting = `Natural exterior daylight consistent with the input photograph.`;

  return composeLayers(
    actionDirective,
    buildingFocus,
    styleCore,
    styleDetail,
    lighting,
    "transform",
    preservationMode ? "faithful" : "balanced",
    PROMPT_VERSION_FALLBACK,
  );
}

// ─── Shared composition pipeline ───────────────────────────────────────────

function composeLayers(
  actionDirective: string,
  buildingFocus: string,
  styleCore: string,
  styleDetail: string,
  lighting: string,
  actionMode: StyleEntry["actionMode"],
  guidanceBand: GuidanceBand,
  promptVersion: string,
): PromptResult {
  const positiveAvoidance = buildPositiveAvoidance([
    "clean architectural lines",
    "intact roof line",
  ]);

  const layers: PromptLayer[] = [
    {
      name: "action+focus",
      priority: 1,
      text: `${actionDirective} ${buildingFocus}`,
    },
    { name: "style-core", priority: 2, text: styleCore },
    {
      name: "structural-preservation",
      priority: 3,
      text: buildStructuralPreservation("exterior"),
    },
    { name: "positive-avoidance", priority: 4, text: positiveAvoidance },
    { name: "style-detail", priority: 5, text: styleDetail },
    {
      name: "photography-quality",
      priority: 6,
      text: buildPhotographyQuality("exterior"),
    },
    { name: "lighting", priority: 7, text: lighting },
  ];

  const trimResult = trimLayersToBudget(layers, PRIMARY_MAX_TOKENS);

  if (trimResult.droppedLayers.length > 0) {
    logger.warn(
      {
        event: "prompt.token_truncation",
        tool: "exteriorDesign",
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Exterior prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
    );
  }

  return {
    prompt: trimResult.composed,
    positiveAvoidance,
    guidanceScale: KLEIN_GUIDANCE_BANDS[guidanceBand],
    actionMode,
    guidanceBand,
    promptVersion,
  };
}
