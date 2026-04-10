/**
 * Interior design prompt builder — the tool builder that implements R1–R7
 * composition with actionMode branching (transform / overlay / target),
 * graceful fallback for unknown enums (R24), and token budget runtime trim
 * (R29).
 *
 * Single public entry: `buildInteriorPrompt({ roomType, designStyle })`.
 *
 * @see docs/plans/2026-04-10-001-refactor-interior-prompt-system-plan.md U9
 */

import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { designStyles } from "../dictionaries/design-styles.js";
import { rooms } from "../dictionaries/rooms.js";
import {
  CHRISTMAS_FALLBACK_ACCENTS,
  christmasRecipes,
} from "../dictionaries/christmas-recipes.js";
import { buildPhotographyQuality } from "../primitives/photography-quality.js";
import {
  POSITIVE_AVOIDANCE_BASE,
  buildPositiveAvoidance,
} from "../primitives/positive-avoidance.js";
import { buildStructuralPreservation } from "../primitives/structural-preservation.js";
import {
  trimLayersToBudget,
  type PromptLayer,
} from "../token-budget.js";
import type {
  GuidanceBand,
  PromptResult,
  RoomEntry,
  RoomSlots,
  StyleEntry,
} from "../types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const PROMPT_VERSION_CURRENT = "interiorDesign/v1.0";
const PROMPT_VERSION_FALLBACK = "interiorDesign/fallback-v1";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

const CHRISTMAS_WHITELIST = new Set<string>([
  "livingRoom",
  "diningRoom",
  "entryway",
  "bedroom",
]);

// ─── Public API ─────────────────────────────────────────────────────────────

export interface InteriorParams {
  roomType: string;
  designStyle: string;
}

export function buildInteriorPrompt(params: InteriorParams): PromptResult {
  const { roomType, designStyle } = params;

  const styleEntry = designStyles[designStyle as keyof typeof designStyles];
  const roomEntry = rooms[roomType as keyof typeof rooms];

  // ─── R24 graceful fallback for unknown enums ─────────────────────────
  if (!styleEntry || !roomEntry) {
    if (!styleEntry) {
      logger.warn(
        { event: "prompt.unknown_style", designStyle, roomType, fallback: "generic" },
        "Unknown designStyle — using generic fallback prompt",
      );
    }
    if (!roomEntry) {
      logger.warn(
        { event: "prompt.unknown_room", designStyle, roomType, fallback: "generic" },
        "Unknown roomType — using generic fallback prompt",
      );
    }
    return buildGenericFallback(roomType);
  }

  // ─── actionMode branch ───────────────────────────────────────────────
  switch (styleEntry.actionMode) {
    case "transform":
      return composeTransform(roomType, styleEntry, roomEntry);
    case "overlay":
      return composeOverlay(roomType, styleEntry, roomEntry);
    case "target":
      return composeTarget(roomType, styleEntry, roomEntry);
  }
}

// ─── Transform mode (default for 16 styles) ───────────────────────────────

function composeTransform(
  roomType: string,
  style: StyleEntry,
  room: RoomEntry,
): PromptResult {
  const humanRoom = humanizeRoomType(roomType);

  const actionDirective =
    `Convert this ${humanRoom} to a ${style.coreAesthetic} ${styleLabelFromKey(roomType, style)} interior, ` +
    `replacing the furniture, decor, and finishes with items that match the ${style.coreAesthetic} aesthetic.`;

  const roomFocus = composeRoomFocus(room.focusSlots);

  const styleCore =
    `Color palette: ${style.colorPalette.join(", ")}. Mood: ${style.moodKeywords.join(", ")}.`;

  const styleDetail =
    `Materials: ${style.materials.join(", ")}. Signature pieces: ${style.signatureItems.join(", ")}.`;

  const lighting = style.lightingCharacter + ".";

  return composeLayers(
    actionDirective,
    roomFocus,
    styleCore,
    styleDetail,
    lighting,
    style.actionMode,
    style.guidanceBand,
    PROMPT_VERSION_CURRENT,
    undefined,
  );
}

// ─── Overlay mode (christmas, with F4 verb-split by whitelist) ────────────

function composeOverlay(
  roomType: string,
  style: StyleEntry,
  room: RoomEntry,
): PromptResult {
  const humanRoom = humanizeRoomType(roomType);
  const inWhitelist = CHRISTMAS_WHITELIST.has(roomType);

  let actionDirective: string;

  if (inWhitelist && style.recipeRef === "christmas-recipes") {
    const recipe = christmasRecipes[roomType as keyof typeof christmasRecipes];
    const decor = recipe?.decor ?? CHRISTMAS_FALLBACK_ACCENTS;
    actionDirective =
      `Preserve the existing style of this ${humanRoom} and add ${decor}.`;
  } else {
    // F4 verb-split: non-whitelist rooms use "Add subtle festive accents to"
    // to avoid the "preserve existing style" category error for utilitarian
    // rooms (bathroom, kitchen, gamingRoom, stairway, etc.).
    actionDirective =
      `Add subtle festive accents to this ${humanRoom} without changing the room's core layout. ` +
      `Include ${CHRISTMAS_FALLBACK_ACCENTS}.`;
  }

  const roomFocus = `Keep ${describeAvoidAdditions(room.focusSlots)} intact: ${composeRoomFocus(room.focusSlots)}`;

  const styleCore =
    `Seasonal palette: ${style.colorPalette.join(", ")}. Mood: ${style.moodKeywords.join(", ")}.`;

  const styleDetail = `Festive materials and finishes: ${style.materials.join(", ")}.`;

  const lighting = style.lightingCharacter + ".";

  return composeLayers(
    actionDirective,
    roomFocus,
    styleCore,
    styleDetail,
    lighting,
    style.actionMode,
    style.guidanceBand,
    PROMPT_VERSION_CURRENT,
    undefined,
  );
}

// ─── Target mode (airbnb) ─────────────────────────────────────────────────

function composeTarget(
  roomType: string,
  style: StyleEntry,
  room: RoomEntry,
): PromptResult {
  const humanRoom = humanizeRoomType(roomType);

  const actionDirective =
    `Stage this ${humanRoom} as a ${style.coreAesthetic} space, ` +
    `restyling finishes and staging for broad appeal rather than personal expression.`;

  // Merge room slots with style slotOverrides (style values take precedence).
  const mergedSlots: RoomSlots = {
    ...room.focusSlots,
    ...style.slotOverrides,
  };

  const roomFocus = composeRoomFocus(mergedSlots);

  const styleCore =
    `Color palette: ${style.colorPalette.join(", ")}. Mood: ${style.moodKeywords.join(", ")}.`;

  const styleDetail =
    `Materials: ${style.materials.join(", ")}. Signature staging pieces: ${style.signatureItems.join(", ")}.`;

  const lighting = style.lightingCharacter + ".";

  return composeLayers(
    actionDirective,
    roomFocus,
    styleCore,
    styleDetail,
    lighting,
    style.actionMode,
    style.guidanceBand,
    PROMPT_VERSION_CURRENT,
    ["neutralized", "universally inviting", "minimal personal expression"],
  );
}

// ─── Generic fallback for unknown enums (R24) ──────────────────────────────

function buildGenericFallback(roomType: string): PromptResult {
  const humanRoom = humanizeRoomType(roomType || "room");

  const actionDirective =
    `Convert this ${humanRoom} to a tasteful, timeless interior with natural materials and a warm neutral palette.`;

  const roomFocus = `Refresh the furniture, decor, and finishes in balanced proportions.`;

  const styleCore = `Color palette: warm off-white, soft oak, muted sage, matte black. Mood: calm, balanced, approachable.`;

  const styleDetail = `Materials: solid oak, linen, natural stone, brushed brass. Signature pieces: a comfortable sofa, a balanced coffee table arrangement, a single statement light fixture.`;

  const lighting = "Warm balanced daylight with layered ambient accents.";

  return composeLayers(
    actionDirective,
    roomFocus,
    styleCore,
    styleDetail,
    lighting,
    "transform",
    "balanced",
    PROMPT_VERSION_FALLBACK,
    undefined,
  );
}

// ─── Shared composition pipeline ───────────────────────────────────────────

/**
 * Build the 7-layer `PromptLayer` array in priority order, trim to the
 * primary provider's token budget, emit a structured log if truncation
 * occurred, and return the final `PromptResult`.
 *
 * Priority order (head first → most important, survives trimming):
 *   1. Action directive + room focus
 *   2. Style core (coreAesthetic + colorPalette + mood)
 *   3. Structural preservation primitive (R4)
 *   4. Positive avoidance primitive (R7)
 *   5. Style detail (materials + signatureItems)
 *   6. Photography quality primitive (R5)
 *   7. Lighting character (R6)
 */
function composeLayers(
  actionDirective: string,
  roomFocus: string,
  styleCore: string,
  styleDetail: string,
  lighting: string,
  actionMode: StyleEntry["actionMode"],
  guidanceBand: GuidanceBand,
  promptVersion: string,
  extraAvoidanceTokens: readonly string[] | undefined,
): PromptResult {
  const positiveAvoidance = buildPositiveAvoidance(extraAvoidanceTokens);

  const layers: PromptLayer[] = [
    {
      name: "action+focus",
      priority: 1,
      text: `${actionDirective} ${roomFocus}`,
    },
    { name: "style-core", priority: 2, text: styleCore },
    {
      name: "structural-preservation",
      priority: 3,
      text: buildStructuralPreservation("interior"),
    },
    { name: "positive-avoidance", priority: 4, text: positiveAvoidance },
    { name: "style-detail", priority: 5, text: styleDetail },
    {
      name: "photography-quality",
      priority: 6,
      text: buildPhotographyQuality("interior"),
    },
    { name: "lighting", priority: 7, text: lighting },
  ];

  const trimResult = trimLayersToBudget(layers, PRIMARY_MAX_TOKENS);

  if (trimResult.droppedLayers.length > 0) {
    logger.warn(
      {
        event: "prompt.token_truncation",
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function composeRoomFocus(slots: RoomSlots): string {
  const parts: string[] = [slots.furnitureDialect];
  if (slots.setupCharacter) parts.push(slots.setupCharacter);
  if (slots.materialDialect) parts.push(slots.materialDialect);
  if (slots.lightingDialect) parts.push(slots.lightingDialect);
  if (slots.personalization) parts.push(slots.personalization);
  return parts.join(". ") + ".";
}

function describeAvoidAdditions(slots: RoomSlots): string {
  if (slots.avoidAdditions && slots.avoidAdditions.length > 0) {
    return "the existing " + slots.avoidAdditions[0]!.replace(/^replace\s+/i, "");
  }
  return "the existing furniture and fixtures";
}

function humanizeRoomType(camelCase: string): string {
  const specialCases: Record<string, string> = {
    livingRoom: "living room",
    diningRoom: "dining room",
    gamingRoom: "gaming room",
    studyRoom: "study room",
    homeOffice: "home office",
    underStairSpace: "under-stair space",
  };
  if (specialCases[camelCase]) return specialCases[camelCase];
  return camelCase
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim();
}

/**
 * Short style label used inline in action directives. Currently delegates
 * to the style's core aesthetic — separate function so future tools can
 * swap in a different label strategy without touching the main composer.
 */
function styleLabelFromKey(_roomType: string, style: StyleEntry): string {
  return style.moodKeywords[0] ?? "balanced";
}
