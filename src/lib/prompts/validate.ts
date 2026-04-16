/**
 * Startup dictionary validator — R8, R12, R25, R28.
 *
 * Called from `src/index.ts` bootstrap between `buildApp()` and
 * `app.listen()`. In strict mode (default), throws on any completeness
 * failure — the process exits with a clear error message, matching the
 * existing env.ts fail-fast pattern.
 *
 * In degraded mode (env `DICTIONARY_STRICT_MODE=degraded` per D17 F2
 * safety valve), logs a structured error and returns silently; the runtime
 * fallback in each tool builder handles the incomplete cases.
 *
 * Registry-driven: new tool dictionaries just need a validator entry in
 * `VALIDATORS` below — no separate validator code per tool.
 */

import { BuildingType } from "../../schemas/generated/types/buildingType.js";
import { DesignStyle } from "../../schemas/generated/types/designStyle.js";
import { ExteriorColorPalette } from "../../schemas/generated/types/exteriorColorPalette.js";
import { FloorTexture } from "../../schemas/generated/types/floorTexture.js";
import { GardenColorPalette } from "../../schemas/generated/types/gardenColorPalette.js";
import { GardenItem } from "../../schemas/generated/types/gardenItem.js";
import { GardenStyle } from "../../schemas/generated/types/gardenStyle.js";
import { PatioStyle } from "../../schemas/generated/types/patioStyle.js";
import { PoolStyle } from "../../schemas/generated/types/poolStyle.js";
import { OutdoorLightingStyle } from "../../schemas/generated/types/outdoorLightingStyle.js";
import { RoomType } from "../../schemas/generated/types/roomType.js";
import { WallTexture } from "../../schemas/generated/types/wallTexture.js";
import { buildingTypes } from "./dictionaries/building-types.js";
import { exteriorPalettes, gardenPalettes } from "./dictionaries/color-palettes.js";
import { designStyles } from "./dictionaries/design-styles.js";
import { floorTextures } from "./dictionaries/floor-textures.js";
import { gardenItems } from "./dictionaries/garden-items.js";
import { gardenStyles } from "./dictionaries/garden-styles.js";
import { patioStyles } from "./dictionaries/patio-styles.js";
import { poolStyles } from "./dictionaries/pool-styles.js";
import { outdoorLightingStyles } from "./dictionaries/outdoor-lighting-styles.js";
import { rooms } from "./dictionaries/rooms.js";
import { wallTextures } from "./dictionaries/wall-textures.js";
import { logger } from "../logger.js";
import type {
  BuildingEntry,
  ColorPaletteEntry,
  FloorTextureEntry,
  GardenItemEntry,
  RoomEntry,
  StyleEntry,
  WallTextureEntry,
} from "./types.js";

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ValidationOptions {
  /** `"strict"` throws on failure; `"degraded"` logs and continues. */
  mode: "strict" | "degraded";
}

export function validateDictionaries(options: ValidationOptions): void {
  const failures: string[] = [];

  failures.push(
    ...runValidator(
      "designStyles",
      Object.values(DesignStyle),
      designStyles,
      checkStyleEntry,
    ),
  );
  failures.push(
    ...runValidator("rooms", Object.values(RoomType), rooms, checkRoomEntry),
  );
  failures.push(
    ...runValidator(
      "buildingTypes",
      Object.values(BuildingType),
      buildingTypes,
      checkBuildingEntry,
    ),
  );
  failures.push(
    ...runValidator(
      "gardenStyles",
      Object.values(GardenStyle),
      gardenStyles,
      checkStyleEntry,
    ),
  );
  failures.push(
    ...runValidator(
      "patioStyles",
      Object.values(PatioStyle),
      patioStyles,
      checkStyleEntry,
    ),
  );
  failures.push(
    ...runValidator(
      "poolStyles",
      Object.values(PoolStyle),
      poolStyles,
      checkStyleEntry,
    ),
  );
  failures.push(
    ...runValidator(
      "outdoorLightingStyles",
      Object.values(OutdoorLightingStyle),
      outdoorLightingStyles,
      checkStyleEntry,
    ),
  );
  failures.push(
    ...runValidator(
      "gardenItems",
      Object.values(GardenItem),
      gardenItems,
      checkGardenItemEntry,
    ),
  );
  failures.push(
    ...runValidator(
      "exteriorPalettes",
      Object.values(ExteriorColorPalette),
      exteriorPalettes,
      checkPaletteEntry,
    ),
  );
  failures.push(
    ...runValidator(
      "gardenPalettes",
      Object.values(GardenColorPalette),
      gardenPalettes,
      checkPaletteEntry,
    ),
  );
  failures.push(
    ...runValidator(
      "wallTextures",
      Object.values(WallTexture),
      wallTextures,
      checkWallTextureEntry,
    ),
  );
  failures.push(
    ...runValidator(
      "floorTextures",
      Object.values(FloorTexture),
      floorTextures,
      checkFloorTextureEntry,
    ),
  );

  if (failures.length === 0) {
    return;
  }

  const message =
    `Dictionary validation failed (${failures.length} issue${failures.length === 1 ? "" : "s"}):\n` +
    failures.map((f) => `  - ${f}`).join("\n");

  if (options.mode === "strict") {
    throw new Error(message);
  }

  // Degraded mode: log and continue.
  logger.error(
    { event: "prompt.dictionary_degraded", failures, count: failures.length },
    "Dictionary incomplete — running in degraded mode, affected enum values will use the runtime fallback",
  );
}

// ─── Internal runner ──────────────────────────────────────────────────────

function runValidator<E extends string, V>(
  dictName: string,
  enumValues: E[],
  dict: Partial<Record<E, V>>,
  check: (key: string, entry: V) => string[],
): string[] {
  const failures: string[] = [];
  for (const key of enumValues) {
    const entry = dict[key];
    if (!entry) {
      failures.push(`${dictName}.${key} is missing`);
      continue;
    }
    failures.push(...check(`${dictName}.${key}`, entry));
  }
  return failures;
}

// ─── Entry checks ─────────────────────────────────────────────────────────

function checkStyleEntry(prefix: string, entry: StyleEntry): string[] {
  const failures: string[] = [];

  if (!entry.coreAesthetic) failures.push(`${prefix}.coreAesthetic is empty`);
  if (!entry.colorPalette || entry.colorPalette.length < 3) {
    failures.push(`${prefix}.colorPalette must have >= 3 entries`);
  }
  if (!entry.materials || entry.materials.length === 0) {
    failures.push(`${prefix}.materials is empty`);
  }
  if (!entry.signatureItems || entry.signatureItems.length === 0) {
    failures.push(`${prefix}.signatureItems is empty`);
  }
  if (!entry.lightingCharacter) {
    failures.push(`${prefix}.lightingCharacter is empty`);
  }
  if (!entry.moodKeywords || entry.moodKeywords.length === 0) {
    failures.push(`${prefix}.moodKeywords is empty`);
  }
  if (!entry.references || entry.references.length < 3) {
    failures.push(`${prefix}.references must have >= 3 URLs per R25`);
  }

  return failures;
}

function checkRoomEntry(prefix: string, entry: RoomEntry): string[] {
  const failures: string[] = [];
  if (!entry.focusSlots.furnitureDialect) {
    failures.push(`${prefix}.focusSlots.furnitureDialect is empty`);
  }
  if (!entry.focusSlots.lightingDialect) {
    failures.push(`${prefix}.focusSlots.lightingDialect is empty`);
  }
  return failures;
}

function checkBuildingEntry(prefix: string, entry: BuildingEntry): string[] {
  const failures: string[] = [];
  if (!entry.label) failures.push(`${prefix}.label is empty`);
  if (!entry.massingDescriptor) {
    failures.push(`${prefix}.massingDescriptor is empty`);
  }
  if (!entry.signatureFeatures || entry.signatureFeatures.length < 2) {
    failures.push(`${prefix}.signatureFeatures must have >= 2 entries`);
  }
  return failures;
}

function checkGardenItemEntry(
  prefix: string,
  entry: GardenItemEntry,
): string[] {
  // `surpriseMe` is a sentinel — empty phrase is allowed, no check needed.
  // All other items must have a non-empty phrase.
  if (prefix.endsWith(".surpriseMe")) return [];
  if (!entry.phrase) {
    return [`${prefix}.phrase is empty`];
  }
  return [];
}

function checkWallTextureEntry(
  prefix: string,
  entry: WallTextureEntry,
): string[] {
  const failures: string[] = [];
  if (!entry.label) failures.push(`${prefix}.label is empty`);
  if (!entry.description) failures.push(`${prefix}.description is empty`);
  if (!entry.descriptors || entry.descriptors.length < 2) {
    failures.push(`${prefix}.descriptors must have >= 2 entries`);
  }
  if (!entry.lightingCharacter) {
    failures.push(`${prefix}.lightingCharacter is empty`);
  }
  return failures;
}

function checkFloorTextureEntry(
  prefix: string,
  entry: FloorTextureEntry,
): string[] {
  const failures: string[] = [];
  if (!entry.label) failures.push(`${prefix}.label is empty`);
  if (!entry.description) failures.push(`${prefix}.description is empty`);
  if (!entry.descriptors || entry.descriptors.length < 2) {
    failures.push(`${prefix}.descriptors must have >= 2 entries`);
  }
  if (!entry.lightingCharacter) {
    failures.push(`${prefix}.lightingCharacter is empty`);
  }
  return failures;
}

function checkPaletteEntry(
  prefix: string,
  entry: ColorPaletteEntry,
): string[] {
  // `surpriseMe` is a sentinel — empty swatch + mood is allowed.
  if (prefix.endsWith(".surpriseMe")) return [];
  const failures: string[] = [];
  if (!entry.swatch || entry.swatch.length < 3) {
    failures.push(`${prefix}.swatch must have >= 3 color names`);
  }
  if (!entry.mood) failures.push(`${prefix}.mood is empty`);
  return failures;
}
