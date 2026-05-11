/**
 * Interior design prompt builder — v2.
 *
 * Drop-in successor to `buildInteriorPrompt` (v1), routed via the
 * `PROMPT_BUILDER_VERSION=v2` env flag through `buildInteriorPromptDispatch`
 * in tool-types.ts. v1 file stays untouched as the rollback target.
 *
 * What v2 changes (and the failure modes each change addresses):
 *
 *   1. **Head-layer inlined preservation.** v1 put the structural-preservation
 *      primitive at priority 3 as its own layer. v2 inlines a compact
 *      "while keeping… every visible doorway, door, window, and architectural
 *      feature" clause directly into the priority-1 action+focus layer, *and*
 *      keeps the strengthened structural-preservation primitive at priority 2
 *      as reinforcement. The constraint is now load-bearing in the HEAD layer
 *      (which never trims) instead of relying on a mid-priority layer.
 *
 *   2. **`preservationHint` over `focusSlots` for transform mode.** v1 read
 *      `room.focusSlots` and concatenated declarative sentences ("central
 *      seating arrangement with a statement sofa…") into the action layer.
 *      The model interpreted those as a target composition and reproduced
 *      them literally — the source of the "cookie-cutter" and "two different
 *      living rooms come out identical" reports. v2 reads `room.preservationHint`
 *      which describes *what to preserve about the visible scene* rather than
 *      *what to build*. `focusSlots` is still used by `actionMode: "target"`
 *      (airbnb) and `actionMode: "overlay"` (christmas), where prescriptive
 *      composition is intentional.
 *
 *   3. **`changeBudget` drives action verb + boundary clause.** v1 used the
 *      same "Restyle the furniture and decor" verb for every transform-mode
 *      style. v2 reads `style.changeBudget` and chooses:
 *      - `"furniture-restyle"` → restyle existing pieces in place
 *      - `"furniture-swap"`    → replace pieces wholesale
 *      - `"surface-only"`      → finishes only (reserved; no current style)
 *      - `"overlay"`           → fed via the overlay compose function
 *      A missing `changeBudget` defaults to `"furniture-restyle"`.
 *
 *   4. **Reordered layers.** `structural-preservation` promoted to priority 2
 *      (was 3). `photography-quality` demoted to priority 7 (was 6) — now the
 *      first to drop under token pressure. `lighting` moved up to slot 6.
 *
 *   5. **Input-anchored lighting for transform mode.** v1 concatenated the
 *      style's `lightingCharacter` ("late afternoon with long directional
 *      window shadows", etc.) as the lighting layer. When the source
 *      photograph's time of day disagreed, this caused exposure shifts that
 *      compounded camera-angle drift. v2's transform mode replaces the
 *      lighting layer with an input-anchored phrase; mood keywords still
 *      carry the style's *feeling* via the style-core layer. Overlay and
 *      target modes keep `lightingCharacter` because their semantics need it
 *      (christmas lighting IS the change; airbnb staging wants bright LED).
 *
 * Token budget. Verified empirically against the 216 (room × style) pairs
 * at build time (see audit script in the rollout runbook). All current
 * pairs fit under 280 tokens (the Pruna primary cap) before trim. Under
 * pressure trimLayersToBudget drops priorities in reverse: photography-
 * quality → lighting → style-detail → positive-avoidance → style-core,
 * stopping when the result fits. structural-preservation (priority 2) is
 * the last to drop; the priority-1 HEAD layer is never dropped. If HEAD
 * itself exceeds budget the trim helper returns the HEAD layer with
 * `overBudget: true` and logs `prompt.token_truncation`.
 *
 * @see docs/plans/2026-05-11-001-refactor-interior-design-prompting-plan.md
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
  ChangeBudget,
  GuidanceBand,
  PromptResult,
  RoomEntry,
  RoomSlots,
  StyleEntry,
} from "../types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const PROMPT_VERSION_CURRENT = "interiorDesign/v2.0";
const PROMPT_VERSION_FALLBACK = "interiorDesign/fallback-v2";

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
 * Same fixture-room set v1 maintains. Carried into v2 so cabinetry-driven
 * rooms still get furniture-token stripping when a style lacks a per-room
 * override (see resolveStyleAssets).
 */
const FIXTURE_ROOMS: ReadonlySet<string> = new Set([
  "kitchen",
  "bathroom",
  "stairway",
  "entryway",
  "underStairSpace",
  "gamingRoom",
]);

const FURNITURE_BIAS_TOKEN =
  /\b(sofa|couch|sectional|loveseat|bed(?:ding|s)?|nightstand|headboard|dresser|wardrobe|armchair|chesterfield|recliner|ottoman|coffee table|dining table|sideboard|buffet|chandelier|wingback|chaise|throw blanket|throw pillow|throw pillows|cushion|pillows|fireplace|hearth|reading chair|club chair|lounge chair)\b/i;

const UPHOLSTERY_BIAS_TOKEN =
  /\b(velvet|tufted|upholstery|upholstered|leather|sheepskin|boucle|knit throw|kilim|macrame|damask|tweed|silk velvet)\b/i;

/**
 * Compact preservation clause inlined into the head layer. Designed to ride
 * alongside the action directive without bloating it — the strengthened
 * structural-preservation primitive at priority 2 carries the full noun list.
 */
const HEAD_PRESERVATION_CLAUSE =
  "while keeping the exact same room layout, camera angle, lens, framing, " +
  "and every visible doorway, door, window, and architectural feature";

const INPUT_LIGHTING_ANCHOR =
  "Match the source image's daylight direction, warmth, and time of day.";

// ─── Public API ─────────────────────────────────────────────────────────────

export interface InteriorParams {
  roomType: string;
  designStyle: string;
}

export function buildInteriorPromptV2(params: InteriorParams): PromptResult {
  const { roomType, designStyle } = params;

  const styleEntry = designStyles[designStyle as keyof typeof designStyles];
  const roomEntry = rooms[roomType as keyof typeof rooms];

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

  switch (styleEntry.actionMode) {
    case "transform":
      return composeTransform(roomType, styleEntry, roomEntry);
    case "overlay":
      return composeOverlay(roomType, styleEntry, roomEntry);
    case "target":
      return composeTarget(roomType, styleEntry, roomEntry);
  }
}

// ─── Transform mode ─────────────────────────────────────────────────────────

function composeTransform(
  roomType: string,
  style: StyleEntry,
  room: RoomEntry,
): PromptResult {
  const humanRoom = humanizeRoomType(roomType);
  const isFixtureRoom = FIXTURE_ROOMS.has(roomType);
  const budget: ChangeBudget = style.changeBudget ?? "furniture-restyle";

  // changeBudget drives the verb + scope boundary. The fixture-room path
  // applies to both budgets but uses cabinetry vocab; non-fixture rooms get
  // furniture vocab. Surface-only is reserved (no current style uses it) so
  // its boundary is intentionally minimal.
  const verbAndBoundary = resolveVerbAndBoundary(budget, isFixtureRoom);

  // The HEAD layer reads as a single sentence:
  //   "{verb}{the subject phrase} in this {room} to a {aesthetic} aesthetic
  //    {preservation clause}. {boundary clause}. {preservation hint}."
  // preservationHint replaces the prescriptive focusSlots concatenation that
  // produced the cookie-cutter failure in v1.
  const aestheticPhrase = `to a ${style.coreAesthetic} aesthetic`;
  // `||` not `??` — an empty-string preservationHint that slipped past the
  // validator (e.g., DICTIONARY_STRICT_MODE=degraded) should fall back to
  // the focusSlots composition rather than inline a literal "" that
  // produces a malformed HEAD sentence ending in "..  ." after join.
  const preservationHint =
    room.preservationHint || composeFocusFallback(room.focusSlots);

  const actionDirective =
    `${verbAndBoundary.verb} in this ${humanRoom} ${aestheticPhrase} ` +
    `${HEAD_PRESERVATION_CLAUSE}. ${verbAndBoundary.boundary}. ` +
    `${preservationHint}`;

  const styleCore = buildStyleCore(style);

  const { items, materials } = resolveStyleAssets(style, roomType);
  const styleDetail = composeStyleDetail(materials, items);

  return composeLayers({
    actionDirective,
    styleCore,
    styleDetail,
    lighting: INPUT_LIGHTING_ANCHOR,
    actionMode: style.actionMode,
    guidanceBand: style.guidanceBand,
    promptVersion: PROMPT_VERSION_CURRENT,
    extraAvoidanceTokens: undefined,
  });
}

interface VerbAndBoundary {
  verb: string;
  boundary: string;
}

function resolveVerbAndBoundary(
  budget: ChangeBudget,
  isFixtureRoom: boolean,
): VerbAndBoundary {
  switch (budget) {
    case "surface-only":
      return {
        verb: "Refresh the paint, finishes, and hardware",
        boundary:
          "Only change the paint colors, surface finishes, hardware, and trim",
      };
    case "furniture-swap":
      return isFixtureRoom
        ? {
            verb: "Replace the cabinetry style, fixtures, hardware, and finishes",
            boundary:
              "Only change the cabinetry style, fixtures, hardware, countertops, and decor surfaces",
          }
        : {
            verb: "Replace the furniture, decor, and finishes",
            boundary:
              "Only change the furniture, decor, lighting fixtures, and finishes",
          };
    case "overlay":
      // Routed through composeOverlay; this branch exists only for type
      // exhaustiveness. Treated as a no-op verb.
      return {
        verb: "Layer additional decor",
        boundary: "Only add layered decor on top of the existing room",
      };
    case "furniture-restyle":
      return isFixtureRoom
        ? {
            verb: "Restyle the existing cabinetry, fixtures, and finishes",
            boundary:
              "Only restyle cabinetry, fixtures, finishes, hardware, and decor surfaces — keep the cabinetry layout and appliance positions identical",
          }
        : {
            verb: "Restyle the existing furniture, decor, and finishes",
            boundary:
              "Restyle every existing piece in place and preserve every primary furniture piece in its original position",
          };
  }
  // Exhaustiveness check — adding a new ChangeBudget variant without
  // updating this switch fails compilation here rather than silently
  // routing to a default branch.
  const _exhaustive: never = budget;
  throw new Error(`unreachable changeBudget: ${_exhaustive as string}`);
}

/**
 * Fallback when a room dictionary entry has no `preservationHint` (e.g.,
 * partial rollout or a future room added without the field). Reuses the
 * focus-slot composition so behavior degrades gracefully to v1's level of
 * prescription rather than producing an empty hint. Named separately from
 * `composeRoomFocus` so call sites communicate intent — the focus-slot
 * shape is the *target composition* for overlay/target modes but only a
 * *fallback hint* for transform mode.
 */
function composeFocusFallback(slots: RoomSlots): string {
  return composeRoomFocus(slots);
}

// ─── Overlay mode (christmas) ──────────────────────────────────────────────
//
// Overlay semantics are unchanged from v1 — christmas explicitly *adds*
// decor on top of the existing room, so the prescriptive focusSlots phrasing
// is correct here ("keep the existing furniture and layout" + "include these
// decor items"). Lighting stays style-driven (christmas lighting IS the
// change). The only v2 differences are the strengthened primitives and the
// reordered layer priorities.

function composeOverlay(
  roomType: string,
  style: StyleEntry,
  room: RoomEntry,
): PromptResult {
  const humanRoom = humanizeRoomType(roomType);
  const inWhitelist = CHRISTMAS_WHITELIST.has(roomType);

  let actionDirective: string;

  if (inWhitelist && style.recipeRef === "christmas-recipes") {
    const recipe =
      christmasRecipes[roomType as keyof typeof christmasRecipes];
    const decor = recipe?.decor ?? CHRISTMAS_FALLBACK_ACCENTS;
    actionDirective =
      `Add ${decor} to this ${humanRoom} while keeping the existing style, ` +
      `furniture, layout, doorways, windows, and architectural features exactly ` +
      `as they are in the source image.`;
  } else {
    actionDirective =
      `Add subtle festive accents to this ${humanRoom} while keeping the room's ` +
      `core layout, doorways, windows, and architectural features exactly as they ` +
      `are in the source image. Include ${CHRISTMAS_FALLBACK_ACCENTS}.`;
  }

  const roomFocus = `Keep ${describeAvoidAdditions(room.focusSlots)} intact: ${composeRoomFocus(room.focusSlots)}`;

  const styleCore =
    `Seasonal palette: ${style.colorPalette.join(", ")}. Mood: ${style.moodKeywords.join(", ")}.`;

  const styleDetail = `Festive materials and finishes: ${style.materials.join(", ")}.`;

  const lighting = style.lightingCharacter + ".";

  return composeLayers({
    actionDirective: `${actionDirective} ${roomFocus}`,
    styleCore,
    styleDetail,
    lighting,
    actionMode: style.actionMode,
    guidanceBand: style.guidanceBand,
    promptVersion: PROMPT_VERSION_CURRENT,
    extraAvoidanceTokens: undefined,
  });
}

// ─── Target mode (airbnb) ──────────────────────────────────────────────────
//
// Target mode keeps the prescriptive focusSlots merged with the style's
// slotOverrides (sanitized in Unit 2 to drop the no-negation tokens). The
// staging directive is intentionally prescriptive — broad-appeal staging
// wants a specific look rather than preserving an existing one.

function composeTarget(
  roomType: string,
  style: StyleEntry,
  room: RoomEntry,
): PromptResult {
  const humanRoom = humanizeRoomType(roomType);

  const actionDirective =
    `Restyle this ${humanRoom} as a ${style.coreAesthetic} space for broad appeal ` +
    `${HEAD_PRESERVATION_CLAUSE}. Change the finishes and staging to be ` +
    `universally inviting.`;

  const mergedSlots: RoomSlots = {
    ...room.focusSlots,
    ...style.slotOverrides,
  };

  const roomFocus = composeRoomFocus(mergedSlots);

  const styleCore = buildStyleCore(style);

  const { items, materials } = resolveStyleAssets(style, roomType);
  const styleDetail = composeStyleDetail(
    materials,
    items,
    "Signature staging pieces",
  );

  const lighting = style.lightingCharacter + ".";

  return composeLayers({
    actionDirective: `${actionDirective} ${roomFocus}`,
    styleCore,
    styleDetail,
    lighting,
    actionMode: style.actionMode,
    guidanceBand: style.guidanceBand,
    promptVersion: PROMPT_VERSION_CURRENT,
    extraAvoidanceTokens: [
      "broadly approachable styling",
      "universally inviting",
      "balanced staging",
    ],
  });
}

// ─── Generic fallback ──────────────────────────────────────────────────────

function buildGenericFallback(roomType: string): PromptResult {
  const humanRoom = humanizeRoomType(roomType || "room");

  const actionDirective =
    `Restyle the existing furniture and decor in this ${humanRoom} to a tasteful, ` +
    `timeless interior with natural materials and a warm neutral palette ` +
    `${HEAD_PRESERVATION_CLAUSE}. Restyle every existing piece in place and ` +
    `preserve every primary furniture piece in its original position.`;

  const styleCore = `Color palette: warm off-white, soft oak, muted sage, matte black. Mood: calm, balanced, approachable.`;

  const styleDetail =
    `Materials: solid oak, linen, natural stone, brushed brass. ` +
    `Signature pieces: a comfortable sofa, a balanced coffee table arrangement, ` +
    `a single statement light fixture.`;

  return composeLayers({
    actionDirective,
    styleCore,
    styleDetail,
    lighting: INPUT_LIGHTING_ANCHOR,
    actionMode: "transform",
    guidanceBand: "balanced",
    promptVersion: PROMPT_VERSION_FALLBACK,
    extraAvoidanceTokens: undefined,
  });
}

// ─── Shared composition pipeline (v2 layer order) ──────────────────────────

interface ComposeArgs {
  actionDirective: string;
  styleCore: string;
  styleDetail: string;
  lighting: string;
  actionMode: StyleEntry["actionMode"];
  guidanceBand: GuidanceBand;
  promptVersion: string;
  extraAvoidanceTokens: readonly string[] | undefined;
}

/**
 * v2 priority order:
 *   1. action+focus+preservation   (HEAD — never drops)
 *   2. structural-preservation     (was 3 — promoted, last to drop)
 *   3. style-core
 *   4. positive-avoidance
 *   5. style-detail
 *   6. lighting                    (was 7)
 *   7. photography-quality         (was 6 — demoted, first to drop)
 */
function composeLayers(args: ComposeArgs): PromptResult {
  const positiveAvoidance = buildPositiveAvoidance(
    "interior",
    args.extraAvoidanceTokens,
  );

  const layers: PromptLayer[] = [
    { name: "action+focus", priority: 1, text: args.actionDirective },
    {
      name: "structural-preservation",
      priority: 2,
      text: buildStructuralPreservation("interior"),
    },
    { name: "style-core", priority: 3, text: args.styleCore },
    { name: "positive-avoidance", priority: 4, text: positiveAvoidance },
    { name: "style-detail", priority: 5, text: args.styleDetail },
    { name: "lighting", priority: 6, text: args.lighting },
    {
      name: "photography-quality",
      priority: 7,
      text: buildPhotographyQuality("interior"),
    },
  ].filter((l) => l.text.length > 0);

  const trimResult = trimLayersToBudget(layers, PRIMARY_MAX_TOKENS);

  if (trimResult.droppedLayers.length > 0) {
    logger.warn(
      {
        event: "prompt.token_truncation",
        tool: "interiorDesign",
        promptVersion: args.promptVersion,
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Interior v2 prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
    );
  }

  return {
    prompt: trimResult.composed,
    positiveAvoidance,
    guidanceScale: KLEIN_GUIDANCE_BANDS[args.guidanceBand],
    actionMode: args.actionMode,
    guidanceBand: args.guidanceBand,
    promptVersion: args.promptVersion,
  };
}

// ─── Helpers (carried from v1) ─────────────────────────────────────────────

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
