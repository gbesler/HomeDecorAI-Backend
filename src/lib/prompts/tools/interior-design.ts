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
import { humanizeRoomType } from "../primitives/humanize-room-type.js";
import { warnUnknownEntry } from "../primitives/unknown-entry.js";
import { buildPhotographyQuality } from "../primitives/photography-quality.js";
import { buildStyleCore } from "../primitives/style-core.js";
import { buildPositiveAvoidance } from "../primitives/positive-avoidance.js";
import { buildStructuralPreservation } from "../primitives/structural-preservation.js";
import {
  trimLayersToBudget,
  type PromptLayer,
} from "../token-budget.js";
import type { RoomType } from "../../../schemas/generated/types/roomType.js";
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

/**
 * Rooms where the user-facing scene is dominated by built-ins / fixtures /
 * setups, not free-standing furniture. Default `signatureItems` like
 * "curved-back sofa" or "tufted chesterfield" make no sense here and the
 * model will hallucinate the wrong piece into the frame if we leave them
 * in. The builder either uses a per-room override from the style entry
 * or strips furniture-bias tokens from the default list for these rooms.
 */
const FIXTURE_ROOMS: ReadonlySet<string> = new Set([
  "kitchen",
  "bathroom",
  "stairway",
  "entryway",
  "underStairSpace",
  "gamingRoom",
]);

/**
 * Free-standing furniture vocabulary that becomes a non-sequitur in
 * fixture-focused rooms. Whole-word boundaries so "low-profile sectional
 * sofa" matches but "softbox" wouldn't (none in current dictionaries —
 * boundary kept as a safety net for future edits).
 */
const FURNITURE_BIAS_TOKEN =
  /\b(sofa|couch|sectional|loveseat|bed(?:ding|s)?|nightstand|headboard|dresser|wardrobe|armchair|chesterfield|recliner|ottoman|coffee table|dining table|sideboard|buffet|chandelier|wingback|chaise|throw blanket|throw pillow|throw pillows|cushion|pillows|fireplace|hearth|reading chair|club chair|lounge chair)\b/i;

/**
 * Upholstery / soft-goods vocabulary that becomes a non-sequitur in fixture
 * rooms. Kitchens and bathrooms don't have velvet upholstery; leaving the
 * token in biases the model into adding a furniture piece to carry it.
 */
const UPHOLSTERY_BIAS_TOKEN =
  /\b(velvet|tufted|upholstery|upholstered|leather|sheepskin|boucle|knit throw|kilim|macrame|damask|tweed|silk velvet)\b/i;

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
      warnUnknownEntry({
        tool: "interiorDesign",
        kind: "style",
        fields: { designStyle, roomType },
      });
    }
    if (!roomEntry) {
      warnUnknownEntry({
        tool: "interiorDesign",
        kind: "room",
        fields: { designStyle, roomType },
      });
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
  const isFixtureRoom = FIXTURE_ROOMS.has(roomType);

  // Verb-split for fixture rooms: "Restyle the furniture and decor in this
  // kitchen" instructs the model to swap free-standing furniture, which is
  // the wrong primitive for cabinetry/island/appliance scenes. Use the
  // built-in vocabulary instead so the action layer agrees with the room
  // focus and `signatureItems` filter below.
  const restyleObject = isFixtureRoom
    ? "the cabinetry, fixtures, and finishes"
    : "the furniture and decor";
  const onlyChange = isFixtureRoom
    ? "Only change cabinetry, fixtures, finishes, and decor surfaces."
    : "Only change the furniture, decor, and finishes.";

  // Single aesthetic descriptor — `coreAesthetic` already reads as a full
  // adjective phrase (e.g. "clean, intentional, architecturally honest").
  // Mixing in `moodKeywords[0]` produced clumsy zigzag concatenations
  // like "...architecturally honest sophisticated aesthetic". Fixed in
  // exterior earlier; interior had regressed.
  const actionDirective =
    `Restyle ${restyleObject} in this ${humanRoom} to a ${style.coreAesthetic} aesthetic ` +
    `while keeping the exact same room layout, camera angle, and perspective. ` +
    onlyChange;

  const roomFocus = composeRoomFocus(room.focusSlots);

  const styleCore = buildStyleCore(style);

  const { items, materials } = resolveStyleAssets(style, roomType);
  const styleDetail = composeStyleDetail(materials, items);

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
      `Add ${decor} to this ${humanRoom} while keeping the existing style, furniture, and layout exactly as they are.`;
  } else {
    // F4 verb-split: non-whitelist rooms use "Add subtle festive accents to"
    // for utilitarian rooms (bathroom, kitchen, gamingRoom, stairway, etc.).
    actionDirective =
      `Add subtle festive accents to this ${humanRoom} while keeping the room's core layout exactly as it is. ` +
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
    `Restyle this ${humanRoom} as a ${style.coreAesthetic} space for broad appeal ` +
    `while keeping the exact same room layout, camera angle, and perspective. ` +
    `Change the finishes and staging to be universally inviting.`;

  // Merge room slots with style slotOverrides (style values take precedence).
  const mergedSlots: RoomSlots = {
    ...room.focusSlots,
    ...style.slotOverrides,
  };

  const roomFocus = composeRoomFocus(mergedSlots);

  const styleCore = buildStyleCore(style);

  const { items, materials } = resolveStyleAssets(style, roomType);
  const styleDetail = composeStyleDetail(materials, items, "Signature staging pieces");

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
    // Phrased as positive descriptions of the desired airbnb-style result.
    // Earlier "neutralized" / "minimal personal expression" were semantic
    // negations that risked biasing Flux back toward the negated content.
    ["broadly approachable styling", "universally inviting", "balanced staging"],
  );
}

// ─── Generic fallback for unknown enums (R24) ──────────────────────────────

function buildGenericFallback(roomType: string): PromptResult {
  const humanRoom = humanizeRoomType(roomType || "room");

  const actionDirective =
    `Restyle this ${humanRoom} to a tasteful, timeless interior with natural materials and a warm neutral palette ` +
    `while keeping the exact same room layout, camera angle, and perspective.`;

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
  ].filter((l) => l.text.length > 0);

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

/**
 * Resolve the style's `signatureItems` and `materials` for the chosen room.
 *
 * Priority:
 *   1. Style-authored per-room override (`signatureItemsByRoom[roomType]`).
 *   2. Fixture rooms with no override → strip furniture-bias / upholstery
 *      tokens from the defaults so kitchens/bathrooms don't inherit
 *      "curved-back sofa" or "velvet upholstery" by accident.
 *   3. Otherwise → return the style defaults unchanged.
 *
 * Returned arrays may be empty if the filter strips everything; the caller
 * is expected to handle the empty-layer case via `composeStyleDetail`.
 */
function resolveStyleAssets(
  style: StyleEntry,
  roomType: string,
): { items: readonly string[]; materials: readonly string[] } {
  const key = roomType as RoomType;
  const itemsOverride = style.signatureItemsByRoom?.[key];
  const materialsOverride = style.materialsByRoom?.[key];
  const isFixtureRoom = FIXTURE_ROOMS.has(roomType);

  const items =
    itemsOverride ??
    (isFixtureRoom
      ? style.signatureItems.filter((s) => !FURNITURE_BIAS_TOKEN.test(s))
      : style.signatureItems);

  const materials =
    materialsOverride ??
    (isFixtureRoom
      ? style.materials.filter((m) => !UPHOLSTERY_BIAS_TOKEN.test(m))
      : style.materials);

  return { items, materials };
}

function composeStyleDetail(
  materials: readonly string[],
  items: readonly string[],
  itemsLabel: string = "Signature pieces",
): string {
  const parts: string[] = [];
  if (materials.length > 0) parts.push(`Materials: ${materials.join(", ")}.`);
  if (items.length > 0) parts.push(`${itemsLabel}: ${items.join(", ")}.`);
  return parts.join(" ");
}

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


