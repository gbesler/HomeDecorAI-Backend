/**
 * Garden design prompt builder — mirrors the interior 7-layer composition
 * with a garden-specific items layer (multi-select).
 *
 * Reuses:
 * - `buildPhotographyQuality("garden")`, `buildStructuralPreservation("garden")`,
 *   `buildPositiveAvoidance()` primitives.
 *
 * Garden-specific:
 * - `gardenStyles` dictionary (10 entries shaped as StyleEntry).
 * - `gardenPalettes` overrides the style's native palette when not `surpriseMe`.
 * - `gardenItems` dictionary provides phrases for the multi-select items layer.
 * - `colorMode === "landscapePreservation"` forces `guidanceBand: "faithful"`
 *   and keeps the existing layout. `fullRedesign` uses the style's native band.
 *
 * `surpriseMe` in gardenItems short-circuits the items layer — the style's
 * signatureItems drive the composition instead.
 */

import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { gardenPalettes } from "../dictionaries/color-palettes.js";
import { gardenItems } from "../dictionaries/garden-items.js";
import { gardenStyles } from "../dictionaries/garden-styles.js";
import { buildPhotographyQuality } from "../primitives/photography-quality.js";
import { buildPositiveAvoidance } from "../primitives/positive-avoidance.js";
import { buildStructuralPreservation } from "../primitives/structural-preservation.js";
import { trimLayersToBudget, type PromptLayer } from "../token-budget.js";
import type {
  ColorPaletteEntry,
  GardenItemEntry,
  GuidanceBand,
  PromptResult,
  StyleEntry,
} from "../types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const PROMPT_VERSION_CURRENT = "gardenDesign/v1.0";
const PROMPT_VERSION_FALLBACK = "gardenDesign/fallback-v1";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

const SURPRISE_ME = "surpriseMe";

// ─── Public API ─────────────────────────────────────────────────────────────

export interface GardenParams {
  gardenStyle: string;
  colorMode: "landscapePreservation" | "fullRedesign";
  colorPalette: string;
  gardenItems: string[];
}

export function buildGardenPrompt(params: GardenParams): PromptResult {
  const {
    gardenStyle,
    colorMode,
    colorPalette,
    gardenItems: selectedItems,
  } = params;

  const styleEntry = gardenStyles[gardenStyle as keyof typeof gardenStyles];
  const paletteEntry =
    gardenPalettes[colorPalette as keyof typeof gardenPalettes];

  if (!styleEntry) {
    logger.warn(
      {
        event: "prompt.unknown_style",
        tool: "gardenDesign",
        gardenStyle,
        fallback: "generic",
      },
      "Unknown gardenStyle — using generic fallback",
    );
    return buildGardenGenericFallback(colorMode);
  }

  const resolvedPalette = paletteEntry ?? null;
  const resolvedItems = resolveItems(selectedItems);

  return compose(styleEntry, colorMode, resolvedPalette, resolvedItems);
}

// ─── Item resolution ───────────────────────────────────────────────────────

function resolveItems(selected: string[]): GardenItemEntry[] {
  // `surpriseMe` short-circuits the items layer.
  if (selected.includes(SURPRISE_ME)) return [];

  const resolved: GardenItemEntry[] = [];
  for (const key of selected) {
    const entry = gardenItems[key as keyof typeof gardenItems];
    if (entry && entry.phrase) {
      resolved.push(entry);
    }
  }
  return resolved;
}

// ─── Composition ───────────────────────────────────────────────────────────

function compose(
  style: StyleEntry,
  colorMode: GardenParams["colorMode"],
  palette: ColorPaletteEntry | null,
  items: GardenItemEntry[],
): PromptResult {
  const preservationMode = colorMode === "landscapePreservation";
  const guidanceBand: GuidanceBand = preservationMode
    ? "faithful"
    : style.guidanceBand;

  const actionDirective = preservationMode
    ? `Refresh the planting and surface treatments of this garden in a ${style.coreAesthetic} direction ` +
      `while keeping the existing layout, paths, and plot shape exactly as they are.`
    : `Restyle this garden to a ${style.coreAesthetic} landscape aesthetic ` +
      `while keeping the existing plot boundaries and camera angle. ` +
      `Change the planting, hardscape finishes, and signature features.`;

  const itemsLayer = composeItemsLayer(items);

  const effectivePalette =
    palette && palette.swatch.length > 0 ? palette.swatch : style.colorPalette;
  const effectiveMood =
    palette && palette.mood ? palette.mood : style.moodKeywords.join(", ");
  const styleCore = `Color palette: ${effectivePalette.join(", ")}. Mood: ${effectiveMood}.`;

  const styleDetail = `Hardscape materials: ${style.materials.join(", ")}. Signature planting and features: ${style.signatureItems.join(", ")}.`;

  // Lighting anchors to the input photograph. In `fullRedesign` mode we
  // allow the style's lighting character to colour the scene since the
  // user opted into a full restyle; in `landscapePreservation` mode we
  // stay strictly consistent with the input frame to avoid contradictions
  // between "keep the garden as-is" and a style-defined time-of-day cue.
  const lighting = preservationMode
    ? `Natural outdoor daylight consistent with the input photograph.`
    : `Natural outdoor daylight consistent with the input photograph, with ${style.lightingCharacter}.`;

  return composeLayers(
    actionDirective,
    itemsLayer,
    styleCore,
    styleDetail,
    lighting,
    style.actionMode,
    guidanceBand,
    PROMPT_VERSION_CURRENT,
  );
}

function composeItemsLayer(items: GardenItemEntry[]): string {
  if (items.length === 0) return "";
  const phrases = items.map((it) =>
    it.placementHint ? `${it.phrase} ${it.placementHint}` : it.phrase,
  );
  return `Include ${phrases.join(", ")}.`;
}

function buildGardenGenericFallback(
  colorMode: GardenParams["colorMode"],
): PromptResult {
  const preservationMode = colorMode === "landscapePreservation";

  const actionDirective = preservationMode
    ? `Refresh the planting and surface treatments of this garden with tasteful natural planting ` +
      `while keeping the existing layout exactly as it is.`
    : `Restyle this garden to a tasteful, timeless landscape with natural materials and a balanced planting scheme ` +
      `while keeping the existing plot boundaries and camera angle.`;

  const styleCore = `Color palette: deep green, warm stone, soft cream, natural timber. Mood: calm, natural, balanced.`;

  const styleDetail = `Hardscape materials: weathered stone pavers, natural gravel, aged timber. Signature planting: layered perennials, ornamental grasses, a small specimen tree.`;

  const lighting = `Natural outdoor daylight consistent with the input photograph.`;

  return composeLayers(
    actionDirective,
    "",
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
  itemsLayer: string,
  styleCore: string,
  styleDetail: string,
  lighting: string,
  actionMode: StyleEntry["actionMode"],
  guidanceBand: GuidanceBand,
  promptVersion: string,
): PromptResult {
  const positiveAvoidance = buildPositiveAvoidance([
    "healthy mature plants",
    "natural texture variation",
  ]);

  // items layer (when present) sits in priority slot 1.5 — concatenated
  // into the head layer so it survives token trimming alongside the
  // action directive.
  const headText = itemsLayer
    ? `${actionDirective} ${itemsLayer}`
    : actionDirective;

  const layers: PromptLayer[] = [
    { name: "action+items", priority: 1, text: headText },
    { name: "style-core", priority: 2, text: styleCore },
    {
      name: "structural-preservation",
      priority: 3,
      text: buildStructuralPreservation("garden"),
    },
    { name: "positive-avoidance", priority: 4, text: positiveAvoidance },
    { name: "style-detail", priority: 5, text: styleDetail },
    {
      name: "photography-quality",
      priority: 6,
      text: buildPhotographyQuality("garden"),
    },
    { name: "lighting", priority: 7, text: lighting },
  ];

  const trimResult = trimLayersToBudget(layers, PRIMARY_MAX_TOKENS);

  if (trimResult.droppedLayers.length > 0) {
    logger.warn(
      {
        event: "prompt.token_truncation",
        tool: "gardenDesign",
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Garden prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
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
