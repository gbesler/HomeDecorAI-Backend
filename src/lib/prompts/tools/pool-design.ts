/**
 * Pool design prompt builder — mirrors the patio composition. The pool
 * wizard ships a single style selection on top of the uploaded photo, so
 * the builder keeps just the style-core, structural-preservation,
 * photography-quality, and lighting layers.
 *
 * Reuses:
 * - `buildPhotographyQuality("garden")`, `buildStructuralPreservation("garden")`,
 *   `buildPositiveAvoidance()` primitives (pools are outdoor hardscape + water
 *   + planting, which the garden subject vocabulary already covers).
 *
 * Pool-specific:
 * - `poolStyles` dictionary (4 entries shaped as StyleEntry).
 */

import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { poolStyles } from "../dictionaries/pool-styles.js";
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

const PROMPT_VERSION_CURRENT = "poolDesign/v1.1";
const PROMPT_VERSION_FALLBACK = "poolDesign/fallback-v1.1";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

// ─── Public API ─────────────────────────────────────────────────────────────

export interface PoolParams {
  poolStyle: string;
}

export function buildPoolPrompt(params: PoolParams): PromptResult {
  const { poolStyle } = params;

  const styleEntry = poolStyles[poolStyle as keyof typeof poolStyles];

  if (!styleEntry) {
    logger.warn(
      {
        event: "prompt.unknown_style",
        tool: "poolDesign",
        poolStyle,
        fallback: "generic",
      },
      "Unknown poolStyle — using generic fallback",
    );
    return buildPoolGenericFallback();
  }

  return compose(styleEntry);
}

// ─── Composition ───────────────────────────────────────────────────────────

function compose(style: StyleEntry): PromptResult {
  const guidanceBand: GuidanceBand = style.guidanceBand;

  // Apply the aesthetic to finishes and surround only. Structural-preservation
  // primitive locks the pool shape, edges, and camera angle; this directive
  // scopes the restyle so the model does not alter geometry or composition.
  const actionDirective =
    `Apply a ${style.coreAesthetic} aesthetic to this swimming pool scene. ` +
    `Update only the coping finish, interior tile/plaster finish, decking material, ` +
    `and surround planting. Do not change the pool shape, edges, or camera angle.`;

  const styleCore = `Color palette: ${style.colorPalette.join(", ")}. Mood: ${style.moodKeywords.join(", ")}.`;

  const styleDetail = `Materials and surround: ${style.materials.join(", ")}. Signature features: ${style.signatureItems.join(", ")}.`;

  // Anchor lighting to the input photograph. `style.lightingCharacter`
  // omitted to prevent contradiction with the original frame's time of day.
  const lighting = `Natural outdoor daylight consistent with the input photograph.`;

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

function buildPoolGenericFallback(): PromptResult {
  const actionDirective = `Apply a tasteful, balanced residential pool aesthetic with natural materials and a clean surround. Update only finishes and planting; keep the pool shape, edges, and camera angle exactly as they are.`;

  const styleCore = `Color palette: clear aqua, warm travertine, soft cream, sun-bleached timber. Mood: balanced, inviting, calm.`;

  const styleDetail = `Materials and surround: travertine or stone coping, pebble pool interior, stone or timber decking, understated planting. Signature features: a clean pool edge, a pair of loungers on the deck, soft planting framing the surround.`;

  const lighting = `Natural outdoor daylight consistent with the input photograph.`;

  return composeLayers(
    actionDirective,
    styleCore,
    styleDetail,
    lighting,
    "transform",
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
  const positiveAvoidance = buildPositiveAvoidance("pool", [
    "realistic water reflections",
    "natural outdoor materials",
  ]);

  const layers: PromptLayer[] = [
    { name: "action", priority: 1, text: actionDirective },
    { name: "style-core", priority: 2, text: styleCore },
    {
      name: "structural-preservation",
      priority: 3,
      text: buildStructuralPreservation("pool"),
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
        tool: "poolDesign",
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Pool prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
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
