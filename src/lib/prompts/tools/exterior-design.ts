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
import { exteriorStyleOverrides } from "../dictionaries/exterior-style-overrides.js";
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
  // Exterior is geometry-sensitive — the structural-preservation primitive
  // already locks massing/openings, so cap at `balanced` even in renovation
  // mode to prevent style-native `creative` bands from drifting the facade.
  const guidanceBand: GuidanceBand = preservationMode ? "faithful" : "balanced";

  // `buildingType` is the iOS building id (e.g. "house") — kept in the
  // signature for parity with the generic fallback and as a future hook for
  // building-aware overrides.
  void buildingType;

  // Action directive differs by colorMode. Both modes use a single
  // aesthetic descriptor (previously mixed `coreAesthetic + moodKeywords[0]`
  // which produced clumsy "clean, intentional, architecturally honest
  // sophisticated" concatenations).
  const actionDirective = preservationMode
    ? `Repaint this ${building.label} in a ${style.coreAesthetic} palette ` +
      `while keeping the existing cladding material, surface texture, roof line, ` +
      `window and door placements, and camera angle identical. Only the paint colors and trim finishes change.`
    : `Reclad and restyle the exterior of this ${building.label} to a ${style.coreAesthetic} aesthetic ` +
      `while keeping the building massing, roof line, window and door placements, and camera angle intact. ` +
      `Update the cladding material, paint colors, trim, and surface treatments.`;

  // In preservation mode the primitive + action directive fully lock geometry,
  // so mentioning signatureFeatures here is redundant and over-constrains the
  // renovation scope. In renovation mode we want the model to emphasize the
  // building's massing, not re-list features that might otherwise be restyled.
  const buildingFocus = preservationMode
    ? `The building reads as a ${building.massingDescriptor}.`
    : `Emphasize the ${building.massingDescriptor}.`;

  // Color palette: concrete palette wins; else fall back to the style's
  // exterior-appropriate palette when present; else interior palette as a
  // last resort.
  const fallbackPalette = resolveStylePalette(
    style,
    styleKeyFromEntry(style),
  );
  const effectivePalette =
    palette && palette.swatch.length > 0 ? palette.swatch : fallbackPalette;
  const effectiveMood =
    palette && palette.mood ? palette.mood : style.moodKeywords.join(", ");
  const styleCore = `Color palette: ${effectivePalette.join(", ")}. Mood: ${effectiveMood}.`;

  // Materials come from the exterior override where available; fall back to
  // the interior list only when no override is registered.
  const exteriorMaterials = resolveStyleMaterials(
    style,
    styleKeyFromEntry(style),
  );
  const styleDetail = `Materials and surface treatments: ${exteriorMaterials.join(", ")}.`;

  // Lighting — anchor to the input photograph's existing natural light.
  // Previously appended `style.lightingCharacter` which is interior-biased
  // ("warm pendant glow", "bright overcast morning") and contradicted the
  // input-consistent framing.
  const lighting =
    "Natural exterior daylight consistent with the input photograph.";

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

// ─── Style-keyed lookup helpers ─────────────────────────────────────────────
//
// The builder receives a `StyleEntry` (the dictionary value) but the exterior
// override table is keyed by the design-style *id*. We resolve the id by
// reverse lookup on the shared `designStyles` dictionary — O(n) on 18
// entries per call, acceptable at prompt-build frequency.

function styleKeyFromEntry(style: StyleEntry): string | null {
  for (const [key, entry] of Object.entries(designStyles)) {
    if (entry === style) return key;
  }
  return null;
}

function resolveStyleMaterials(
  style: StyleEntry,
  styleKey: string | null,
): string[] {
  if (styleKey) {
    const override =
      exteriorStyleOverrides[styleKey as keyof typeof exteriorStyleOverrides];
    if (override && override.materials.length > 0) return override.materials;
  }
  return style.materials;
}

function resolveStylePalette(
  style: StyleEntry,
  styleKey: string | null,
): string[] {
  if (styleKey) {
    const override =
      exteriorStyleOverrides[styleKey as keyof typeof exteriorStyleOverrides];
    if (override && override.colorPalette && override.colorPalette.length > 0) {
      return override.colorPalette;
    }
  }
  return style.colorPalette;
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
