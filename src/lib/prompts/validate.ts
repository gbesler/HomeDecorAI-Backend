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
 * fallback in `buildInteriorPrompt` handles the incomplete cases.
 */

import { DesignStyle } from "../../schemas/generated/types/designStyle.js";
import { RoomType } from "../../schemas/generated/types/roomType.js";
import { designStyles } from "./dictionaries/design-styles.js";
import { rooms } from "./dictionaries/rooms.js";
import { logger } from "../logger.js";
import type { StyleEntry } from "./types.js";

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ValidationOptions {
  /** `"strict"` throws on failure; `"degraded"` logs and continues. */
  mode: "strict" | "degraded";
}

export function validateDictionaries(options: ValidationOptions): void {
  const failures: string[] = [];

  // Check every DesignStyle enum value has a complete StyleEntry.
  for (const styleKey of Object.values(DesignStyle)) {
    const entry = designStyles[styleKey];
    if (!entry) {
      failures.push(`designStyles.${styleKey} is missing`);
      continue;
    }
    const styleFailures = checkStyleEntry(styleKey, entry);
    failures.push(...styleFailures);
  }

  // Check every RoomType enum value has a complete RoomEntry.
  for (const roomKey of Object.values(RoomType)) {
    const entry = rooms[roomKey];
    if (!entry) {
      failures.push(`rooms.${roomKey} is missing`);
      continue;
    }
    if (!entry.focusSlots.furnitureDialect) {
      failures.push(`rooms.${roomKey}.focusSlots.furnitureDialect is empty`);
    }
    if (!entry.focusSlots.lightingDialect) {
      failures.push(`rooms.${roomKey}.focusSlots.lightingDialect is empty`);
    }
  }

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
    "Dictionary incomplete — running in degraded mode, affected style/room combinations will use the runtime fallback",
  );
}

// ─── Internal checks ───────────────────────────────────────────────────────

function checkStyleEntry(key: string, entry: StyleEntry): string[] {
  const failures: string[] = [];
  const prefix = `designStyles.${key}`;

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
