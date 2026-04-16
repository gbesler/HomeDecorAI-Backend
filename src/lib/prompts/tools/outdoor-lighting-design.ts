/**
 * Outdoor lighting prompt builder — mirrors the patio/pool composition but
 * biases the layer weights toward the lighting character. Most styles are
 * `overlay` (layer lighting onto an unchanged scene) rather than `transform`,
 * so the action directive emphasizes "relight" rather than "restyle".
 *
 * Reuses:
 * - `buildPhotographyQuality("garden")`, `buildStructuralPreservation("garden")`,
 *   `buildPositiveAvoidance()` primitives (outdoor lighting operates over
 *   hardscape + planting, which the garden subject vocabulary covers).
 *
 * Outdoor-lighting-specific:
 * - `outdoorLightingStyles` dictionary (10 entries shaped as StyleEntry).
 */

import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { outdoorLightingStyles } from "../dictionaries/outdoor-lighting-styles.js";
import { buildPhotographyQuality } from "../primitives/photography-quality.js";
import { buildPositiveAvoidance } from "../primitives/positive-avoidance.js";
import { buildStructuralPreservation } from "../primitives/structural-preservation.js";
import { trimLayersToBudget, type PromptLayer } from "../token-budget.js";
import type {
  GuidanceBand,
  PromptResult,
  StyleEntry,
} from "../types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const PROMPT_VERSION_CURRENT = "outdoorLightingDesign/v1.0";
const PROMPT_VERSION_FALLBACK = "outdoorLightingDesign/fallback-v1";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

// ─── Public API ─────────────────────────────────────────────────────────────

export interface OutdoorLightingParams {
  lightingStyle: string;
}

export function buildOutdoorLightingPrompt(
  params: OutdoorLightingParams,
): PromptResult {
  const { lightingStyle } = params;

  const styleEntry =
    outdoorLightingStyles[
      lightingStyle as keyof typeof outdoorLightingStyles
    ];

  if (!styleEntry) {
    logger.warn(
      {
        event: "prompt.unknown_style",
        tool: "outdoorLightingDesign",
        lightingStyle,
        fallback: "generic",
      },
      "Unknown lightingStyle — using generic fallback",
    );
    return buildOutdoorLightingGenericFallback();
  }

  return compose(styleEntry);
}

// ─── Composition ───────────────────────────────────────────────────────────

function compose(style: StyleEntry): PromptResult {
  const guidanceBand: GuidanceBand = style.guidanceBand;

  const actionVerb = style.actionMode === "overlay" ? "Relight" : "Restyle";
  const actionDirective = `${actionVerb} this outdoor scene as a ${style.coreAesthetic}, keeping the existing layout, planting, and hardscape intact.`;

  const styleCore = `Color palette: ${style.colorPalette.join(", ")}. Mood: ${style.moodKeywords.join(", ")}.`;

  const styleDetail = `Fixtures and materials: ${style.materials.join(", ")}. Signature features: ${style.signatureItems.join(", ")}.`;

  const lighting = `Lighting character: ${style.lightingCharacter}.`;

  return composeLayers(
    actionDirective,
    styleCore,
    styleDetail,
    lighting,
    style.actionMode,
    guidanceBand,
    PROMPT_VERSION_CURRENT,
  );
}

function buildOutdoorLightingGenericFallback(): PromptResult {
  const actionDirective = `Relight this outdoor scene with a tasteful warm evening lighting scheme, keeping the existing layout, planting, and hardscape intact.`;

  const styleCore = `Color palette: warm amber, soft candle yellow, deep dusk blue, matte-bronze fixture. Mood: warm, welcoming, ambient.`;

  const styleDetail = `Fixtures and materials: frosted globe lanterns, bronze or matte-black fixtures, low-voltage garden spots, softly illuminated planting. Signature features: clusters of warm lanterns scattered across the yard, a soft amber glow washing seating and planting, low garden spots subtly lighting key foliage.`;

  const lighting = `Lighting character: warm 2700K ambient glow at dusk with soft shadow falloff and a deep-blue sky.`;

  return composeLayers(
    actionDirective,
    styleCore,
    styleDetail,
    lighting,
    "overlay",
    "faithful",
    PROMPT_VERSION_FALLBACK,
  );
}

// ─── Shared composition pipeline ───────────────────────────────────────────

function composeLayers(
  actionDirective: string,
  styleCore: string,
  styleDetail: string,
  lighting: string,
  actionMode: StyleEntry["actionMode"],
  guidanceBand: GuidanceBand,
  promptVersion: string,
): PromptResult {
  const positiveAvoidance = buildPositiveAvoidance([
    "realistic outdoor materials",
    "natural planting textures",
    "physically plausible light falloff and shadows",
  ]);

  const layers: PromptLayer[] = [
    { name: "action", priority: 1, text: actionDirective },
    { name: "lighting", priority: 2, text: lighting },
    { name: "style-core", priority: 3, text: styleCore },
    {
      name: "structural-preservation",
      priority: 4,
      text: buildStructuralPreservation("garden"),
    },
    { name: "positive-avoidance", priority: 5, text: positiveAvoidance },
    { name: "style-detail", priority: 6, text: styleDetail },
    {
      name: "photography-quality",
      priority: 7,
      text: buildPhotographyQuality("garden"),
    },
  ];

  const trimResult = trimLayersToBudget(layers, PRIMARY_MAX_TOKENS);

  if (trimResult.droppedLayers.length > 0) {
    logger.warn(
      {
        event: "prompt.token_truncation",
        tool: "outdoorLightingDesign",
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Outdoor lighting prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
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
