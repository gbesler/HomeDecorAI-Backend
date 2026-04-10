/**
 * Type definitions for the interior design prompt system.
 *
 * Keys are imported from the orval-generated schemas so the dictionary keys
 * stay in sync with the public API enum values.
 */

import type { DesignStyle } from "../../schemas/generated/types/designStyle.js";
import type { RoomType } from "../../schemas/generated/types/roomType.js";

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
