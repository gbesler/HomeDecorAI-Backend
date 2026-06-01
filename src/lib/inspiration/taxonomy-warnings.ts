import {
  getAllowedValues,
  type TaxonomyAxis,
} from "../taxonomy/registry.js";

/**
 * Soft-warn taxonomy validation for Explore seed rows.
 *
 * The Explore seed schema (`InspirationSeedInputSchema`) intentionally accepts
 * several taxonomy axes as *loose strings* (`TaxonomyStringSchema`), not
 * `z.enum`s — the iOS app may ship a new raw value before the backend enum
 * catches up, and hard-rejecting would block legitimate forward-compatible
 * seeds. See `schemas.ts`.
 *
 * This module preserves that accept-everything behaviour but surfaces values
 * that fall outside the system-defined closed sets, so a seeding operator (or
 * a future generator pipeline) is told "this value isn't a known enum member"
 * without the write being blocked. It never throws and never rejects — callers
 * decide what to do with the warnings (the seed script just prints them).
 *
 * Purity: imports only the env-free taxonomy registry, so it (and its tests)
 * run without the production env preamble.
 */

/** A validated seed row, viewed structurally. We only read `id` plus the loose
 *  axis fields dynamically, so a minimal shape keeps this decoupled from the
 *  full `InspirationSeedInput` (and keeps tests cheap to construct). */
export interface TaxonomyWarningInput {
  readonly id: string;
  readonly [field: string]: unknown;
}

/** A single out-of-set value found on a loose axis. Advisory only. */
export interface TaxonomyWarning {
  /** `id` of the offending seed row. */
  readonly rowId: string;
  /** Seed-input field name (what the author wrote). */
  readonly field: string;
  /** Registry axis the field maps to (where the closed set lives). */
  readonly axis: TaxonomyAxis;
  /** The value that is not a member of the axis's closed set. */
  readonly value: string;
}

/**
 * Loose seed-input fields that DO have a system-defined closed set, paired with
 * the registry axis that owns that set. `tags` is intentionally excluded — it
 * is free-form and has no closed taxonomy.
 */
const LOOSE_AXIS_FIELDS: ReadonlyArray<{
  readonly field: string;
  readonly axis: TaxonomyAxis;
}> = [
  { field: "roomType", axis: "roomType" },
  { field: "buildingType", axis: "buildingType" },
  { field: "gardenStyle", axis: "gardenStyle" },
  { field: "patioStyle", axis: "patioStyle" },
  { field: "poolStyle", axis: "poolStyle" },
  { field: "outdoorLightingStyle", axis: "outdoorLightingStyle" },
  { field: "colorPaletteId", axis: "colorPalette" },
];

/** Collect soft warnings for a single validated seed row. Absent/null/empty
 *  loose axes are skipped (they are optional). Never throws. */
export function collectTaxonomyWarnings(
  row: TaxonomyWarningInput,
): TaxonomyWarning[] {
  const warnings: TaxonomyWarning[] = [];
  for (const { field, axis } of LOOSE_AXIS_FIELDS) {
    const value = row[field];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    if (!getAllowedValues(axis).includes(value)) {
      warnings.push({ rowId: row.id, field, axis, value });
    }
  }
  return warnings;
}

/** Collect soft warnings across many rows, preserving each row's id. */
export function collectTaxonomyWarningsForRows(
  rows: readonly TaxonomyWarningInput[],
): TaxonomyWarning[] {
  return rows.flatMap((row) => collectTaxonomyWarnings(row));
}

/** Format warnings as human-readable lines for the seed summary (stderr).
 *  Returns one line per warning; empty input yields an empty array. */
export function formatTaxonomyWarnings(
  warnings: readonly TaxonomyWarning[],
): string[] {
  return warnings.map(
    (w) =>
      `row id=${w.rowId}: ${w.field}="${w.value}" is not a defined ${w.axis} value (accepted, but not a known enum member)`,
  );
}
