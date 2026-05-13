/**
 * Virtual Staging prompt builder — stages empty or sparsely furnished rooms
 * with furniture and decor. Unlike Interior Design which transforms existing
 * furnishings, this tool adds furniture to empty spaces.
 *
 * The wizard always requests a full staging pass (the room is treated as
 * empty and furnished from scratch); the previous `stagingMode` toggle is
 * removed because no wizard step ever sets it to anything other than the
 * default. See removal note in the plan.
 *
 * Reuses:
 * - `buildPhotographyQuality("interior")`, `buildStructuralPreservation("interior")`,
 *   `buildPositiveAvoidance()` primitives.
 * - `designStyles` dictionary for style attributes.
 * - `stagingPalettes` dictionary (interior-tuned twin of `exteriorPalettes`,
 *   shares the 12 iOS palette IDs) for color palette overrides.
 *
 * @see docs/plans/2026-04-15-001-feat-virtual-staging-tool-plan.md
 */

import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { stagingPalettes } from "../dictionaries/color-palettes.js";
import { designStyles } from "../dictionaries/design-styles.js";
import { rooms } from "../dictionaries/rooms.js";
import { humanizeRoomType } from "../primitives/humanize-room-type.js";
import { warnUnknownEntry } from "../primitives/unknown-entry.js";
import { buildPhotographyQuality } from "../primitives/photography-quality.js";
import { buildStyleCore } from "../primitives/style-core.js";
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
}

export function buildVirtualStagingPrompt(
  params: VirtualStagingParams,
): PromptResult {
  const { roomType, designStyle, colorPalette } = params;

  const styleEntry = designStyles[designStyle as keyof typeof designStyles];
  const roomEntry = rooms[roomType as keyof typeof rooms];
  const paletteEntry =
    stagingPalettes[colorPalette as keyof typeof stagingPalettes];

  if (!styleEntry || !roomEntry) {
    if (!styleEntry) {
      warnUnknownEntry({
        tool: "virtualStaging",
        kind: "style",
        fields: { designStyle, roomType },
      });
    }
    if (!roomEntry) {
      warnUnknownEntry({
        tool: "virtualStaging",
        kind: "room",
        fields: { designStyle, roomType },
      });
    }
    return buildStagingGenericFallback(roomType);
  }

  const resolvedPalette = paletteEntry ?? null;

  return compose(roomType, styleEntry, roomEntry, resolvedPalette);
}

// ─── Composition ───────────────────────────────────────────────────────────

function compose(
  roomType: string,
  style: StyleEntry,
  room: RoomEntry,
  palette: ColorPaletteEntry | null,
): PromptResult {
  const humanRoom = humanizeRoomType(roomType);

  const guidanceBand: GuidanceBand = "balanced";

  const actionDirective =
    `Stage this empty ${humanRoom} with ${style.coreAesthetic} furniture and decor ` +
    `while keeping the exact same room layout, camera angle, and perspective. ` +
    `Create a fully furnished, inviting space.`;

  const roomFocus = composeRoomFocus(room);

  const styleCore = buildStyleCore(style, palette);

  const styleDetail = `Materials: ${style.materials.join(", ")}. Signature furniture: ${style.signatureItems.join(", ")}.`;

  const lighting = style.lightingCharacter + ".";

  return composeLayers(
    actionDirective,
    roomFocus,
    styleCore,
    styleDetail,
    lighting,
    "transform",
    guidanceBand,
    PROMPT_VERSION_CURRENT,
    undefined,
  );
}

function composeRoomFocus(room: RoomEntry): string {
  const slots = room.focusSlots;
  const parts: string[] = [slots.furnitureDialect];
  if (slots.lightingDialect) parts.push(slots.lightingDialect);
  if (slots.personalization) parts.push(slots.personalization);
  return parts.join(". ") + ".";
}

function buildStagingGenericFallback(roomType: string): PromptResult {
  const humanRoom = humanizeRoomType(roomType || "room");

  const actionDirective =
    `Stage this empty ${humanRoom} with tasteful, timeless furniture and decor ` +
    `while keeping the exact same room layout, camera angle, and perspective.`;

  const roomFocus = `Furnish the space with balanced proportions: seating, surfaces, lighting, and accents.`;

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
  const positiveAvoidance = buildPositiveAvoidance("interior", extraAvoidanceTokens);

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

