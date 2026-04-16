/**
 * Type definitions for the interior design prompt system.
 *
 * Keys are imported from the orval-generated schemas so the dictionary keys
 * stay in sync with the public API enum values.
 */

import type { BuildingType } from "../../schemas/generated/types/buildingType.js";
import type { DesignStyle } from "../../schemas/generated/types/designStyle.js";
import type { ExteriorColorPalette } from "../../schemas/generated/types/exteriorColorPalette.js";
import type { ExteriorMaterial } from "../../schemas/generated/types/exteriorMaterial.js";
import type { GardenColorPalette } from "../../schemas/generated/types/gardenColorPalette.js";
import type { GardenItem } from "../../schemas/generated/types/gardenItem.js";
import type { GardenStyle } from "../../schemas/generated/types/gardenStyle.js";
import type { PatioStyle } from "../../schemas/generated/types/patioStyle.js";
import type { PoolStyle } from "../../schemas/generated/types/poolStyle.js";
import type { RoomType } from "../../schemas/generated/types/roomType.js";
import type { FloorTexture } from "../../schemas/generated/types/floorTexture.js";
import type { WallTexture } from "../../schemas/generated/types/wallTexture.js";

// ─── Mode enums ─────────────────────────────────────────────────────────────

/**
 * How the builder should apply a style.
 * - `transform`: full restyle (default for 16 styles)
 * - `overlay`: preserve existing style and layer new content on top (christmas)
 * - `target`: stage toward a use-case goal, not a visual style (airbnb)
 */
export type ActionMode = "transform" | "overlay" | "target";

/**
 * Guidance scale band. Maps to a numeric value per-provider at call time.
 * - `creative`: looser, more interpretive
 * - `balanced`: middle default
 * - `faithful`: stricter adherence to input structure
 */
export type GuidanceBand = "creative" | "balanced" | "faithful";

// ─── Room slot map (D11 target-mode interaction) ───────────────────────────

/**
 * Room-specific composition slots. Each room provides what these slots
 * contain by default; `actionMode: "target"` styles can override specific
 * slots via `StyleEntry.slotOverrides`.
 */
export interface RoomSlots {
  /** Main furniture and decor language for this room type. */
  furnitureDialect: string;
  /** Lighting direction and character for this room type. */
  lightingDialect: string;
  /** Fixture / surface material focus (bathroom tiles, kitchen counters, etc.). */
  materialDialect?: string;
  /** Degree of personal items, photos, mementos. */
  personalization?: string;
  /** Setup-specific language (gaming rigs, desk ergonomics). */
  setupCharacter?: string;
  /** Items that MUST NOT be added to this room type (e.g., stairway: no sofa). */
  avoidAdditions?: string[];
}

// ─── Style dictionary entry ────────────────────────────────────────────────

export interface StyleEntry {
  /** 2-3 defining adjectives. */
  coreAesthetic: string;
  /** 3-4 concrete color names. No "neutral" or "warm tones". */
  colorPalette: string[];
  /** Concrete material names (wood species, metal finishes, fabric types). */
  materials: string[];
  /** 2-3 style-defining furniture pieces. */
  signatureItems: string[];
  /** Sentence describing ideal lighting character. */
  lightingCharacter: string;
  /** 2-3 mood words. */
  moodKeywords: string[];
  /** Action directive variant. Default `"transform"` for most styles. */
  actionMode: ActionMode;
  /** Guidance scale band. Default `"balanced"`. */
  guidanceBand: GuidanceBand;
  /**
   * Editorial references for this style (Pinterest boards, AD articles, etc.).
   * R25 requires >= 3. Validated at startup by `validateDictionaries`.
   */
  references: string[];
  /**
   * Marker indicating this style uses the per-room christmas recipe lookup.
   * Only set on the `christmas` entry.
   */
  recipeRef?: "christmas-recipes";
  /**
   * For `actionMode: "target"` styles, slot values that override the room's
   * defaults. Merged on top of `RoomSlots` at composition time.
   */
  slotOverrides?: Partial<RoomSlots>;
}

// ─── Room dictionary entry ──────────────────────────────────────────────────

export interface RoomEntry {
  focusSlots: RoomSlots;
}

// ─── Christmas recipe (per-room) ────────────────────────────────────────────

/**
 * Per-room Christmas decor recipe for whitelist rooms (living, dining,
 * entryway, bedroom). Non-whitelist rooms use the verb-split fallback
 * ("Add subtle festive accents to this [room]") with a minimal accent list.
 */
export interface ChristmasRecipe {
  /** Decor items to layer on the existing room style. */
  decor: string;
}

// ─── Public result shape ────────────────────────────────────────────────────

/**
 * The canonical return shape of any tool builder. Extended shapes are allowed
 * for future tools (e.g., VirtualStaging may add `referenceImageUrl`) — the
 * base fields here are the contract every provider call site consumes.
 */
export interface PromptResult {
  /** Full composed positive prompt, including the R7 positive-avoidance tail. */
  prompt: string;
  /** Just the R7 tail, for metrics / logging. Mirrored inside `prompt`. */
  positiveAvoidance: string;
  /**
   * Numeric guidance scale. Consumed by fal.ai Klein; ignored by Pruna
   * (Pruna has no CFG knob — provider layer drops the field for that model).
   */
  guidanceScale: number;
  /** Metadata for Firestore: which action mode generated this prompt. */
  actionMode: ActionMode;
  /** Metadata for Firestore: which guidance band drove the numeric value. */
  guidanceBand: GuidanceBand;
  /**
   * Versioned builder identifier for post-launch A/B attribution.
   * Example: `"interiorDesign/v1.0"`, `"interiorDesign/legacy"`,
   * `"interiorDesign/fallback-v1"`.
   */
  promptVersion: string;
}

// ─── Dictionary container types ────────────────────────────────────────────

/**
 * Style dictionary. Partial so missing entries can be detected at startup
 * by `validateDictionaries`, and so unknown enum values (iOS shipped a new
 * style before backend update) degrade via R24 fallback rather than crash
 * the type system.
 */
export type DesignStylesDict = Partial<Record<DesignStyle, StyleEntry>>;

/** Room dictionary. Same rationale as `DesignStylesDict`. */
export type RoomsDict = Partial<Record<RoomType, RoomEntry>>;

/** Per-room Christmas recipe dictionary. Only whitelist rooms are keyed. */
export type ChristmasRecipesDict = Partial<Record<RoomType, ChristmasRecipe>>;

// ─── Exterior tool entries ─────────────────────────────────────────────────

/**
 * Per-building-type compositional hints. Feeds the exterior builder's action
 * directive and building-focus layer with type-specific massing vocabulary.
 */
export interface BuildingEntry {
  /** Human-readable type label used in the action directive. */
  label: string;
  /** Short massing descriptor (e.g., "low horizontal mass", "tall block"). */
  massingDescriptor: string;
  /** 2-3 signature features that define this building type visually. */
  signatureFeatures: string[];
}

export type BuildingTypesDict = Partial<Record<BuildingType, BuildingEntry>>;

// ─── Garden tool entries ───────────────────────────────────────────────────

/**
 * Per-garden-style dictionary entry. Shares the same shape as `StyleEntry`
 * so the interior validator (`checkStyleEntry`) can be reused for garden
 * styles without duplication.
 */
export type GardenStyleEntry = StyleEntry;

export type GardenStylesDict = Partial<Record<GardenStyle, GardenStyleEntry>>;

/**
 * Per-patio-style dictionary entry. Same shape reuse as garden so
 * `checkStyleEntry` validates both without duplication.
 */
export type PatioStyleEntry = StyleEntry;

export type PatioStylesDict = Partial<Record<PatioStyle, PatioStyleEntry>>;

/**
 * Per-pool-style dictionary entry. Same shape reuse as garden/patio so
 * `checkStyleEntry` validates all three without duplication.
 */
export type PoolStyleEntry = StyleEntry;

export type PoolStylesDict = Partial<Record<PoolStyle, PoolStyleEntry>>;

/**
 * Per-garden-item dictionary entry. Provides the human-readable phrase used
 * in the items layer of the garden prompt.
 */
export interface GardenItemEntry {
  /** Phrase injected into the items list (e.g., "a stone fire pit"). */
  phrase: string;
  /** Optional placement hint (e.g., "centered in a gravel clearing"). */
  placementHint?: string;
}

export type GardenItemsDict = Partial<Record<GardenItem, GardenItemEntry>>;

// ─── Color palette catalog (shared between exterior and garden) ────────────

/**
 * A color palette entry. Keyed by the FE palette id; `surpriseMe` is
 * tolerated with an empty swatch array to signal "no override — let the
 * style drive the palette".
 */
export interface ColorPaletteEntry {
  /** 3-5 concrete color names. Empty for the `surpriseMe` sentinel. */
  swatch: string[];
  /** 1-2 word mood descriptor injected alongside the palette. */
  mood: string;
}

export type ExteriorColorPalettesDict = Partial<
  Record<ExteriorColorPalette, ColorPaletteEntry>
>;
export type GardenColorPalettesDict = Partial<
  Record<GardenColorPalette, ColorPaletteEntry>
>;

// ─── Paint-walls tool entries ─────────────────────────────────────────────

/**
 * A single wall texture preset (one of the 18 ids the iOS wizard exposes).
 * The entries feed the `texture` branch of the paint-walls prompt builder.
 * Each entry contributes a short material descriptor and a recommended
 * lighting character — the builder composes them into the standard
 * 5-layer prompt alongside `structural-preservation` and `photography-quality`.
 */
export interface WallTextureEntry {
  /** Category bucket — matches the iOS WallStyleCategory enum. */
  category:
    | "paintFinish"
    | "plaster"
    | "stoneBrick"
    | "wood"
    | "decorative";
  /** Human-readable label used inline in the prompt's action directive. */
  label: string;
  /** One-sentence description of the finish's appearance. */
  description: string;
  /** 2-3 material descriptor tokens (e.g., "non-reflective", "velvet-like"). */
  descriptors: string[];
  /** Ideal lighting character for this wall finish. */
  lightingCharacter: string;
}

export type WallTexturesDict = Partial<Record<WallTexture, WallTextureEntry>>;

// ─── Floor-restyle tool entries ────────────────────────────────────────────

/**
 * A single floor texture preset (one of the 16 ids the iOS wizard exposes).
 * Feeds the `texture` branch of the floor-restyle prompt builder. Same
 * shape as `WallTextureEntry` except the `category` union matches the iOS
 * `FloorStyleCategory` enum (4 categories vs walls' 5).
 */
export interface FloorTextureEntry {
  /** Category bucket — matches the iOS FloorStyleCategory enum. */
  category: "wood" | "marble" | "porcelain" | "planks";
  /** Human-readable label used inline in the prompt's action directive. */
  label: string;
  /** One-sentence description of the finish's appearance. */
  description: string;
  /** 2-3 material descriptor tokens (e.g., "warm grain", "tight planks"). */
  descriptors: string[];
  /** Ideal lighting character for this floor finish. */
  lightingCharacter: string;
}

export type FloorTexturesDict = Partial<Record<FloorTexture, FloorTextureEntry>>;

// ─── Exterior-painting tool entries ────────────────────────────────────────

/**
 * A single exterior cladding material preset (9 of the 10 ids the iOS
 * wizard exposes — `keepOriginal` is a sentinel handled inline in the
 * builder, not dictionary-driven).
 *
 * Feeds the material-swap branch of the exterior-painting prompt builder.
 * Each entry contributes a short material descriptor that layers on top
 * of the chosen color palette.
 */
export interface ExteriorMaterialEntry {
  /** Human-readable label used inline in the prompt's action directive. */
  label: string;
  /** One-sentence description of the material's appearance. */
  description: string;
  /** 2-3 material descriptor tokens (e.g., "hand-laid", "matte finish"). */
  descriptors: string[];
}

export type ExteriorMaterialsDict = Partial<
  Record<ExteriorMaterial, ExteriorMaterialEntry>
>;
