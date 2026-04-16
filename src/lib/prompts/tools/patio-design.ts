/**
 * Patio design prompt builder — mirrors the garden composition with the
 * color-palette and items layers removed. The patio wizard ships a single
 * style selection on top of the uploaded photo, so the builder keeps just
 * the style-core, structural-preservation, photography-quality, and lighting
 * layers.
 *
 * Reuses:
 * - `buildPhotographyQuality("garden")`, `buildStructuralPreservation("garden")`,
 *   `buildPositiveAvoidance()` primitives (patios are outdoor hardscape + planting,
 *   which the garden subject vocabulary already covers).
 *
 * Patio-specific:
 * - `patioStyles` dictionary (8 entries shaped as StyleEntry).
 */

import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { patioStyles } from "../dictionaries/patio-styles.js";
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

const PROMPT_VERSION_CURRENT = "patioDesign/v1.0";
const PROMPT_VERSION_FALLBACK = "patioDesign/fallback-v1";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

// ─── Public API ─────────────────────────────────────────────────────────────

export interface PatioParams {
  patioStyle: string;
}

export function buildPatioPrompt(params: PatioParams): PromptResult {
  const { patioStyle } = params;

  const styleEntry = patioStyles[patioStyle as keyof typeof patioStyles];

  if (!styleEntry) {
    logger.warn(
      {
        event: "prompt.unknown_style",
        tool: "patioDesign",
        patioStyle,
        fallback: "generic",
      },
      "Unknown patioStyle — using generic fallback",
    );
    return buildPatioGenericFallback();
  }

  return compose(styleEntry);
}

// ─── Composition ───────────────────────────────────────────────────────────

function compose(style: StyleEntry): PromptResult {
  const guidanceBand: GuidanceBand = style.guidanceBand;

  const actionDirective = `Restyle this patio as a ${style.coreAesthetic}, keeping the existing layout and structural elements intact.`;

  const styleCore = `Color palette: ${style.colorPalette.join(", ")}. Mood: ${style.moodKeywords.join(", ")}.`;

  const styleDetail = `Materials and furnishings: ${style.materials.join(", ")}. Signature features: ${style.signatureItems.join(", ")}.`;

  const lighting = `Natural outdoor daylight consistent with the input photograph, with ${style.lightingCharacter}.`;

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

function buildPatioGenericFallback(): PromptResult {
  const actionDirective = `Restyle this patio as a tasteful, welcoming outdoor living space with balanced furnishings and natural materials, keeping the existing layout intact.`;

  const styleCore = `Color palette: warm timber, soft cream, muted sage, aged stone. Mood: welcoming, relaxed, balanced.`;

  const styleDetail = `Materials and furnishings: timber or wicker outdoor seating, stone or timber decking, cushioned seating, potted greenery. Signature features: a comfortable seating group, layered outdoor textiles, planters framing the space.`;

  const lighting = `Natural outdoor daylight consistent with the input photograph.`;

  return composeLayers(
    actionDirective,
    styleCore,
    styleDetail,
    lighting,
    "transform",
    "balanced",
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
  ]);

  const layers: PromptLayer[] = [
    { name: "action", priority: 1, text: actionDirective },
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
        tool: "patioDesign",
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Patio prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
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
