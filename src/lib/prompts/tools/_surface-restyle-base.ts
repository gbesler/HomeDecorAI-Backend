/**
 * Shared layer-assembly helper for surface-level restyle tools
 * (paint-walls, floor-restyle, and any future ceiling/countertop/...).
 *
 * What's shared: the 6-layer composition pipeline (action+focus, style-core,
 * structural-preservation, positive-avoidance, photography-quality, lighting),
 * the token-budget trim, the truncation warn log, and the common
 * positiveAvoidance axes ("faithful to original room geometry",
 * "faithful to original furniture and decor").
 *
 * What stays per-tool: every natural-language string (action directives,
 * style cores, lighting copy, generic fallbacks) and the tool-specific
 * `focusDirective` describing which surfaces are preserved vs modified.
 *
 * Guidance scale is hardcoded `faithful` here because every surface-restyle
 * tool is geometry-sensitive by definition — only one surface changes, and
 * the model must hold the rest of the room. Tools that need a different
 * band should not use this helper.
 */

import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { buildPhotographyQuality } from "../primitives/photography-quality.js";
import { buildPositiveAvoidance } from "../primitives/positive-avoidance.js";
import { buildStructuralPreservation } from "../primitives/structural-preservation.js";
import { trimLayersToBudget, type PromptLayer } from "../token-budget.js";
import type { PromptResult } from "../types.js";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
const SMART_QUOTES = /[“”"]/g;
const WHITESPACE = /\s+/g;

/**
 * Sanitize a user-supplied freeform prompt before inlining it into an
 * action directive that wraps it in double quotes. Strips control
 * characters, normalizes smart/double quotes to a single apostrophe so
 * the surrounding `"${prompt}"` template stays well-formed, and collapses
 * runs of whitespace. Length capping is the caller's job
 * (CUSTOM_PROMPT_MAX_CHARS in each tool builder).
 */
export function sanitizeCustomPrompt(input: string): string {
  return input
    .replace(CONTROL_CHARS, " ")
    .replace(SMART_QUOTES, "'")
    .replace(WHITESPACE, " ")
    .trim();
}

export interface SurfaceRestyleConfig {
  /**
   * Tool identifier used in log events (e.g., "paintWalls", "floorRestyle").
   * Matches the tool-types.ts `toolKey`.
   */
  tool: string;
  /**
   * Focus directive (merged into the priority-1 `action+focus` layer).
   * Should describe which surfaces are preserved in image 1 and which
   * surface receives the new finish. Tool-specific because the surface
   * list differs (paint-walls preserves flooring; floor-restyle preserves
   * walls; etc.).
   */
  focusDirective: string;
  /**
   * Human-readable tool label used only in the truncation log message.
   * Defaults to `config.tool` if omitted.
   */
  humanLabel?: string;
}

/**
 * Assemble the 6 shared layers, enforce the token budget, log any
 * truncation, and return the canonical `PromptResult`. Callers supply only
 * the three tool-specific strings (action directive, style core, lighting)
 * plus the prompt version and a small config object.
 */
export function composeSurfaceRestyleLayers(
  actionDirective: string,
  styleCore: string,
  lighting: string,
  promptVersion: string,
  config: SurfaceRestyleConfig,
): PromptResult {
  const positiveAvoidance = buildPositiveAvoidance("interior", [
    "faithful to original room geometry",
    "faithful to original furniture and decor",
  ]);

  const layers: PromptLayer[] = [
    {
      name: "action+focus",
      priority: 1,
      text: `${actionDirective} ${config.focusDirective}`,
    },
    { name: "style-core", priority: 2, text: styleCore },
    {
      name: "structural-preservation",
      priority: 3,
      text: buildStructuralPreservation("interior"),
    },
    { name: "positive-avoidance", priority: 4, text: positiveAvoidance },
    {
      name: "photography-quality",
      priority: 5,
      text: buildPhotographyQuality("interior"),
    },
    { name: "lighting", priority: 6, text: lighting },
  ];

  const trimResult = trimLayersToBudget(layers, PRIMARY_MAX_TOKENS);

  if (trimResult.droppedLayers.length > 0) {
    const humanLabel = config.humanLabel ?? config.tool;
    logger.warn(
      {
        event: "prompt.token_truncation",
        tool: config.tool,
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `${humanLabel} prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
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
