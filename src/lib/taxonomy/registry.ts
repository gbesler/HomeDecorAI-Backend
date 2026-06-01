import { RoomType } from "../../schemas/generated/types/roomType.js";
import { DesignStyle } from "../../schemas/generated/types/designStyle.js";
import { GardenStyle } from "../../schemas/generated/types/gardenStyle.js";
import { BuildingType } from "../../schemas/generated/types/buildingType.js";
import { PatioStyle } from "../../schemas/generated/types/patioStyle.js";
import { PoolStyle } from "../../schemas/generated/types/poolStyle.js";
import { OutdoorLightingStyle } from "../../schemas/generated/types/outdoorLightingStyle.js";
import { ExteriorMaterial } from "../../schemas/generated/types/exteriorMaterial.js";
import { WallTexture } from "../../schemas/generated/types/wallTexture.js";
import { FloorTexture } from "../../schemas/generated/types/floorTexture.js";
import { ExteriorColorPalette } from "../../schemas/generated/types/exteriorColorPalette.js";
import { GardenColorPalette } from "../../schemas/generated/types/gardenColorPalette.js";
import { SpaceType } from "../../schemas/generated/types/spaceType.js";
import { GardenItem } from "../../schemas/generated/types/gardenItem.js";
import { OBJECT_TOOL_TYPE_VALUES } from "../objectInspiration/types.js";
// Type-only import — erased at runtime by isolatedModules, so this module
// stays free of `tool-types.ts`'s heavy import graph (firebase-admin, env,
// prompt builders) and its module-load `env` parse. The import exists solely
// to anchor the compile-time drift guard on TOOL_TYPE_KEYS below.
import type { ToolTypeKey } from "../tool-types.js";

/**
 * Central taxonomy registry — the single source of truth for every "closed
 * set" of values a seed generator (or its validator/context exporter) is
 * allowed to emit.
 *
 * Why this exists: the iOS app and backend already carry canonical enum
 * definitions (`src/schemas/generated/types/*` — orval-generated for
 * RoomType/DesignStyle, hand-edited mirrors for the rest), but the seed
 * layer used to hand-copy those values into `src/lib/inspiration/types.ts`.
 * Hand-copies drift. This registry *derives* every axis from the canonical
 * source via `Object.values(...)`, so adding a value to a generated enum
 * propagates here automatically with no second edit (the original goal:
 * "yeni enum/type eklendiğinde generator otomatik uyum sağlar").
 *
 * Purity contract: this module imports ONLY zero-side-effect const objects
 * (the generated enums + `OBJECT_TOOL_TYPE_VALUES`). It must never import a
 * module that triggers `env` parsing at load time, so it (and its tests) run
 * without the production env preamble. The `ToolTypeKey` import is
 * `import type` precisely to preserve this.
 */

/** One axis of the taxonomy: a named, closed set of string values plus the
 *  provenance metadata that lets a context exporter explain where the values
 *  come from. */
export interface TaxonomyAxisDefinition {
  /** Canonical axis key, matching the seed-input field name where applicable. */
  readonly axis: string;
  /** Human-readable label for context/markdown output. */
  readonly label: string;
  /** Repo-relative provenance of the values — the canonical source of truth. */
  readonly source: string;
  /** The closed set of allowed string values, derived from `source`. */
  readonly values: readonly string[];
}

/**
 * Explore-filterable tool keys. This tuple mirrors the keys of `TOOL_TYPES`
 * in `tool-types.ts`, which is the canonical runtime registry of every tool.
 * We keep a *pure* tuple here (rather than `Object.keys(TOOL_TYPES)`) so the
 * taxonomy layer stays env-free — see the purity contract above.
 *
 * Drift is caught at compile time by the parity guard below: add or remove a
 * tool in `TOOL_TYPES` and `tsc --noEmit` fails until this tuple is updated.
 * That converts the old silent hand-copy into a CI-enforced sync point.
 */
//
// Order matters: these values are spread into the Fastify JSON-schema `enum`
// arrays in `routes/explore.ts` (and thus the OpenAPI/Swagger spec the iOS
// client consumes). Keep this order identical to the historically-shipped
// `TOOL_TYPE_VALUES` order so the wire contract does not shift. The parity
// guard below only checks set membership, NOT order — `tools-order.test.ts`
// locks the order.
export const TOOL_TYPE_KEYS = [
  "interiorDesign",
  "exteriorDesign",
  "gardenDesign",
  "patioDesign",
  "poolDesign",
  "referenceStyle",
  "replaceAddObject",
  "paintWalls",
  "floorRestyle",
  "virtualStaging",
  "cleanOrganize",
  "removeObjects",
  "exteriorPainting",
  "outdoorLightingDesign",
] as const;

/** `true` only when TOOL_TYPE_KEYS and `ToolTypeKey` are mutually assignable
 *  (i.e. exactly the same set). If `TOOL_TYPES` gains or loses a key, one
 *  direction collapses to `never` and this assignment fails typecheck. */
type ToolKeyParity =
  [ToolTypeKey] extends [(typeof TOOL_TYPE_KEYS)[number]]
    ? [(typeof TOOL_TYPE_KEYS)[number]] extends [ToolTypeKey]
      ? true
      : never
    : never;
// If the next line fails typecheck with "Type 'never' is not assignable to
// type 'true'", TOOL_TYPE_KEYS is out of sync with TOOL_TYPES (tool-types.ts):
// add or remove the diverging key from TOOL_TYPE_KEYS above.
const _toolKeyParity: ToolKeyParity = true;
void _toolKeyParity;

/** Union of every color-palette id across the palette sets. The explore seed
 *  input carries a single loose `colorPaletteId`, so the allowed set is the
 *  union of exterior + garden palettes (dedup keeps shared ids like
 *  `surpriseMe` once). */
const COLOR_PALETTE_VALUES: readonly string[] = [
  ...new Set([
    ...Object.values(ExteriorColorPalette),
    ...Object.values(GardenColorPalette),
  ]),
  // Sorted so the exported context artifact is stable regardless of the
  // (hand-edited) enum key order in the two palette source files.
].sort();

/**
 * The registry. Each entry's `values` is derived from its canonical `source`
 * — there are no hand-written value literals here except `TOOL_TYPE_KEYS`
 * (which is compile-time-guarded against `TOOL_TYPES`).
 */
export const TAXONOMY_REGISTRY = {
  roomType: {
    axis: "roomType",
    label: "Room Type",
    source: "src/schemas/generated/types/roomType.ts",
    values: Object.values(RoomType),
  },
  designStyle: {
    axis: "designStyle",
    label: "Design Style",
    source: "src/schemas/generated/types/designStyle.ts",
    values: Object.values(DesignStyle),
  },
  toolType: {
    axis: "toolType",
    label: "Tool Type",
    source: "src/lib/tool-types.ts (TOOL_TYPES keys)",
    values: [...TOOL_TYPE_KEYS],
  },
  gardenStyle: {
    axis: "gardenStyle",
    label: "Garden Style",
    source: "src/schemas/generated/types/gardenStyle.ts",
    values: Object.values(GardenStyle),
  },
  buildingType: {
    axis: "buildingType",
    label: "Building Type",
    source: "src/schemas/generated/types/buildingType.ts",
    values: Object.values(BuildingType),
  },
  patioStyle: {
    axis: "patioStyle",
    label: "Patio Style",
    source: "src/schemas/generated/types/patioStyle.ts",
    values: Object.values(PatioStyle),
  },
  poolStyle: {
    axis: "poolStyle",
    label: "Pool Style",
    source: "src/schemas/generated/types/poolStyle.ts",
    values: Object.values(PoolStyle),
  },
  outdoorLightingStyle: {
    axis: "outdoorLightingStyle",
    label: "Outdoor Lighting Style",
    source: "src/schemas/generated/types/outdoorLightingStyle.ts",
    values: Object.values(OutdoorLightingStyle),
  },
  exteriorMaterial: {
    axis: "exteriorMaterial",
    label: "Exterior Material",
    source: "src/schemas/generated/types/exteriorMaterial.ts",
    values: Object.values(ExteriorMaterial),
  },
  wallTexture: {
    axis: "wallTexture",
    label: "Wall Texture",
    source: "src/schemas/generated/types/wallTexture.ts",
    values: Object.values(WallTexture),
  },
  floorTexture: {
    axis: "floorTexture",
    label: "Floor Texture",
    source: "src/schemas/generated/types/floorTexture.ts",
    values: Object.values(FloorTexture),
  },
  spaceType: {
    axis: "spaceType",
    label: "Space Type",
    source: "src/schemas/generated/types/spaceType.ts",
    values: Object.values(SpaceType),
  },
  gardenItem: {
    axis: "gardenItem",
    label: "Garden Item",
    source: "src/schemas/generated/types/gardenItem.ts",
    values: Object.values(GardenItem),
  },
  colorPalette: {
    axis: "colorPalette",
    label: "Color Palette",
    source:
      "src/schemas/generated/types/{exteriorColorPalette,gardenColorPalette}.ts",
    values: COLOR_PALETTE_VALUES,
  },
  objectToolType: {
    axis: "objectToolType",
    label: "Object Tool Type",
    source: "src/lib/objectInspiration/types.ts (OBJECT_TOOL_TYPE_VALUES)",
    values: [...OBJECT_TOOL_TYPE_VALUES],
  },
} as const satisfies Record<string, TaxonomyAxisDefinition>;

/** Every axis key the registry knows about. */
export type TaxonomyAxis = keyof typeof TAXONOMY_REGISTRY;

/** All axis keys, as an array (handy for iteration / context export). */
export function getAxes(): TaxonomyAxis[] {
  return Object.keys(TAXONOMY_REGISTRY) as TaxonomyAxis[];
}

/**
 * Return the closed set of allowed values for an axis. Throws (rather than
 * returning `undefined`) on an unknown axis so a typo surfaces loudly instead
 * of silently yielding "no constraint".
 */
export function getAllowedValues(axis: TaxonomyAxis): readonly string[] {
  const def = TAXONOMY_REGISTRY[axis];
  if (!def) {
    throw new Error(`Unknown taxonomy axis: ${String(axis)}`);
  }
  return def.values;
}

/** Membership check for a single value against an axis's closed set. */
export function isAllowedValue(axis: TaxonomyAxis, value: string): boolean {
  return getAllowedValues(axis).includes(value);
}
