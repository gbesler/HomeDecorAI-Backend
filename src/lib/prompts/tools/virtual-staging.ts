/**
 * Virtual Staging prompt builder — stages empty or sparsely furnished rooms
 * with furniture and decor. Unlike Interior Design which transforms existing
 * furnishings, this tool adds furniture to empty spaces.
 *
 * Supports two staging modes:
 * - `fullStaging`: stage the room as if empty, full creative freedom
 * - `keepLayout`: preserve any existing furniture, add complementary pieces
 *
 * Reuses:
 * - `buildPhotographyQuality("interior")`, `buildStructuralPreservation("interior")`,
 *   `buildPositiveAvoidance()` primitives.
 * - `designStyles` dictionary for style attributes.
 * - `exteriorPalettes` dictionary for color palette overrides (same 12 IDs).
 *
 * @see docs/plans/2026-04-15-001-feat-virtual-staging-tool-plan.md
 */

import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { exteriorPalettes } from "../dictionaries/color-palettes.js";
import { designStyles } from "../dictionaries/design-styles.js";
import { rooms } from "../dictionaries/rooms.js";
import { buildPhotographyQuality } from "../primitives/photography-quality.js";
import { buildPositiveAvoidance } from "../primitives/positive-avoidance.js";
import { buildStructuralPreservation } from "../primitives/structural-preservation.js";
import { trimLayersToBudget, type PromptLayer } from "../token-budget.js";
import type {
  ColorPaletteEntry,
  GuidanceBand,
  PromptResult,
  RoomEntry,
  StyleEntry,
} from "../types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const PROMPT_VERSION_CURRENT = "virtualStaging/v1.0";
const PROMPT_VERSION_FALLBACK = "virtualStaging/fallback-v1";

const PRIMARY_MODEL = "prunaai/p-image-edit";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 200;

// ─── Public API ─────────────────────────────────────────────────────────────

export interface VirtualStagingParams {
  roomType: string;
  designStyle: string;
  colorPalette: string;
  stagingMode: "keepLayout" | "fullStaging";
}

export function buildVirtualStagingPrompt(
  params: VirtualStagingParams,
): PromptResult {
  const { roomType, designStyle, colorPalette, stagingMode } = params;

  const styleEntry = designStyles[designStyle as keyof typeof designStyles];
  const roomEntry = rooms[roomType as keyof typeof rooms];
  const paletteEntry =
    exteriorPalettes[colorPalette as keyof typeof exteriorPalettes];

  if (!styleEntry || !roomEntry) {
    if (!styleEntry) {
      logger.warn(
        {
          event: "prompt.unknown_style",
          tool: "virtualStaging",
          designStyle,
          roomType,
          fallback: "generic",
        },
        "Unknown designStyle — using generic fallback prompt",
      );
    }
    if (!roomEntry) {
      logger.warn(
        {
          event: "prompt.unknown_room",
          tool: "virtualStaging",
          designStyle,
          roomType,
          fallback: "generic",
        },
        "Unknown roomType — using generic fallback prompt",
      );
    }
    return buildStagingGenericFallback(roomType, stagingMode);
  }

  const resolvedPalette = paletteEntry ?? null;

  return compose(roomType, styleEntry, roomEntry, resolvedPalette, stagingMode);
}

// ─── Composition ───────────────────────────────────────────────────────────

function compose(
  roomType: string,
  style: StyleEntry,
  room: RoomEntry,
  palette: ColorPaletteEntry | null,
  stagingMode: VirtualStagingParams["stagingMode"],
): PromptResult {
  const humanRoom = humanizeRoomType(roomType);
  const isKeepLayout = stagingMode === "keepLayout";

  const guidanceBand: GuidanceBand = isKeepLayout ? "faithful" : "balanced";

  const actionDirective = isKeepLayout
    ? `Add complementary ${style.coreAesthetic} furniture pieces to this ${humanRoom} ` +
      `while keeping all existing furniture exactly as it is. ` +
      `Only add items that harmonize with the current layout.`
    : `Stage this empty ${humanRoom} with ${style.coreAesthetic} furniture and decor ` +
      `while keeping the exact same room layout, camera angle, and perspective. ` +
      `Create a fully furnished, inviting space.`;

  const roomFocus = composeRoomFocus(room, isKeepLayout);

  const effectivePalette =
    palette && palette.swatch.length > 0 ? palette.swatch : style.colorPalette;
  const effectiveMood =
    palette && palette.mood ? palette.mood : style.moodKeywords.join(", ");
  const styleCore = `Color palette: ${effectivePalette.join(", ")}. Mood: ${effectiveMood}.`;

  const styleDetail = `Materials: ${style.materials.join(", ")}. Signature furniture: ${style.signatureItems.join(", ")}.`;

  const lighting = style.lightingCharacter + ".";

  return composeLayers(
    actionDirective,
    roomFocus,
    styleCore,
    styleDetail,
    lighting,
    isKeepLayout ? "overlay" : "transform",
    guidanceBand,
    PROMPT_VERSION_CURRENT,
    isKeepLayout
      ? ["complement existing", "harmonize with current"]
      : undefined,
  );
}

function composeRoomFocus(room: RoomEntry, isKeepLayout: boolean): string {
  const slots = room.focusSlots;

  if (isKeepLayout) {
    return `Add complementary pieces: ${slots.furnitureDialect}. Ensure new items harmonize with existing furniture.`;
  }

  const parts: string[] = [slots.furnitureDialect];
  if (slots.lightingDialect) parts.push(slots.lightingDialect);
  if (slots.personalization) parts.push(slots.personalization);
  return parts.join(". ") + ".";
}

function buildStagingGenericFallback(
  roomType: string,
  stagingMode: VirtualStagingParams["stagingMode"],
): PromptResult {
  const humanRoom = humanizeRoomType(roomType || "room");
  const isKeepLayout = stagingMode === "keepLayout";

  const actionDirective = isKeepLayout
    ? `Add complementary tasteful furniture pieces to this ${humanRoom} ` +
      `while keeping all existing furniture exactly as it is.`
    : `Stage this empty ${humanRoom} with tasteful, timeless furniture and decor ` +
      `while keeping the exact same room layout, camera angle, and perspective.`;

  const roomFocus = isKeepLayout
    ? `Add complementary pieces that harmonize with existing furniture, filling empty areas appropriately.`
    : `Furnish the space with balanced proportions: seating, surfaces, lighting, and accents.`;

  const styleCore = `Color palette: warm off-white, soft oak, muted sage, matte black. Mood: calm, balanced, approachable.`;

  const styleDetail = `Materials: solid oak, linen, natural stone, brushed brass. Signature pieces: a comfortable sofa, a balanced coffee table arrangement, a single statement light fixture.`;

  const lighting = "Warm balanced daylight with layered ambient accents.";

  return composeLayers(
    actionDirective,
    roomFocus,
    styleCore,
    styleDetail,
    lighting,
    isKeepLayout ? "overlay" : "transform",
    isKeepLayout ? "faithful" : "balanced",
    PROMPT_VERSION_FALLBACK,
    isKeepLayout
      ? ["complement existing", "harmonize with current"]
      : undefined,
  );
}

// ─── Shared composition pipeline ───────────────────────────────────────────

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
        tool: "virtualStaging",
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Virtual staging prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
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
