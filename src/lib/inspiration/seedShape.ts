import type { InspirationDoc, InspirationTaxonomy } from "./types.js";
import type { InspirationSeedInput } from "./schemas.js";

// Re-export the canonical input type so callers can `import { InspirationSeedInput }
// from "./seedShape.js"` without reaching into the zod schema module directly.
// The single source of truth is `InspirationSeedInputSchema` in `schemas.ts`;
// this builder is the post-validation consumer.
export type { InspirationSeedInput } from "./schemas.js";

export interface BuildSeedDocInput {
  row: InspirationSeedInput;
}

/**
 * Pure function: map one seed-input row into a Firestore envelope
 * document. Does NOT touch network or filesystem — used by both the
 * admin route handler and the shape unit tests.
 *
 * Behavior:
 *   • `id` is preserved verbatim from the input row so favorites that
 *     reference the row by id keep resolving across re-seeds.
 *   • `kind` defaults to `"roomPhoto"`; this builder doesn't synthesize
 *     other kinds today.
 *   • Empty / missing `tags` becomes `[]` (Firestore-safe default).
 *   • Per-tool taxonomy fields are forwarded only when the input row
 *     actually carried them. Absent fields are written as `null`
 *     rather than omitted entirely, so an existing doc whose flat
 *     field was previously populated can be cleared via re-seed.
 *   • `prompt` is included only when the input row carries a non-empty
 *     value. Absent / empty prompts are omitted from the patch so a
 *     previously seeded `prompt` is NOT clobbered when a re-seed lacks
 *     the field (see seeder edge-case test).
 *   • `imageMime` defaults to `"image/jpeg"` when the input row omits it.
 *   • `createdAt` / `updatedAt` are set by the route handler via
 *     `admin.firestore.FieldValue.serverTimestamp()` — this builder
 *     returns the doc WITHOUT those fields so callers can attach the
 *     sentinel without dragging firebase-admin into pure-logic tests.
 *
 * Callers wanting a write-ready Firestore payload should spread the
 * returned object alongside `createdAt` / `updatedAt` sentinels:
 *
 * ```ts
 * await docRef.set(
 *   { ...buildSeedDoc({ row }),
 *     createdAt: admin.firestore.FieldValue.serverTimestamp(),
 *     updatedAt: admin.firestore.FieldValue.serverTimestamp() },
 *   { merge: true, mergeFields: [...] }, // see writeInspirationDoc
 * );
 * ```
 */
export function buildSeedDoc(
  input: BuildSeedDocInput,
): Omit<InspirationDoc, "createdAt" | "updatedAt"> {
  const { row } = input;
  const taxonomy: InspirationTaxonomy = {
    toolType: row.toolType,
    designStyle: row.designStyle,
    tags: row.tags ? Array.from(row.tags) : [],
    roomType: nullable(row.roomType),
    buildingType: nullable(row.buildingType),
    gardenStyle: nullable(row.gardenStyle),
    patioStyle: nullable(row.patioStyle),
    poolStyle: nullable(row.poolStyle),
    outdoorLightingStyle: nullable(row.outdoorLightingStyle),
    colorPaletteId: nullable(row.colorPaletteId),
  };

  const doc: Omit<InspirationDoc, "createdAt" | "updatedAt"> = {
    schemaVersion: 1,
    kind: row.kind ?? "roomPhoto",
    taxonomy,
    path: row.path,
    imageWidth: row.imageWidth,
    imageHeight: row.imageHeight,
    imageMime:
      typeof row.imageMime === "string" && row.imageMime.length > 0
        ? row.imageMime
        : "image/jpeg",
    featured: row.featured === true,
  };

  if (typeof row.prompt === "string" && row.prompt.trim().length > 0) {
    doc.prompt = row.prompt;
  }

  return doc;
}

/**
 * Fields the inspiration upsert is allowed to overwrite on re-runs.
 * Used as the `mergeFields` argument to Firestore's `set()` so omitted
 * fields (most importantly `prompt`, when a re-seed has no value for
 * that row) preserve their previously-written value.
 *
 * `prompt` and `createdAt` are intentionally absent — `prompt` is
 * managed via the planner's first-time-write branch (see
 * `planSeedWrite`), and `createdAt` is stamped only on the first write.
 */
export const INSPIRATION_UPSERT_MERGE_FIELDS = [
  "schemaVersion",
  "kind",
  "taxonomy",
  "path",
  "imageWidth",
  "imageHeight",
  "imageMime",
  "featured",
  "updatedAt",
] as const;

/**
 * Snapshot info the write planner needs from the existing Firestore doc.
 * Kept narrow so tests don't need a real `DocumentSnapshot`.
 */
export interface ExistingDocInfo {
  exists: boolean;
  /** Whatever the existing doc has at `data.prompt`, or null/undefined if absent. */
  prompt: string | null | undefined;
}

/**
 * Plan describing how to upsert one inspiration doc atomically.
 *
 * The Firestore write executor wraps the read-then-write in a transaction
 * (see `seedInspirationDoc` in `firestore.ts`). Within a transaction the
 * same `DocumentReference` can be written at most once, so this planner
 * collapses the previous "metadata set + standalone prompt patch" pair
 * into a single write whose `mergeFields` list controls precisely which
 * fields land.
 */
export interface SeedWritePlan {
  /** Data payload to write (without server timestamps). */
  data: Record<string, unknown>;
  /**
   * Field list for `set(ref, data, { mergeFields })`. `null` means a full
   * first-write `set(ref, data)` instead of a partial merge.
   */
  mergeFields: readonly string[] | null;
  /** `true` when this is the first write for the document. */
  created: boolean;
}

/**
 * Pure: derive the single Firestore write that should land for one
 * upsert request, given the existing doc state.
 *
 * Prompt rules (the load-bearing piece of this logic):
 *   • New doc: write the prompt if the row supplied one (covered by the
 *     full-doc first-write path; no mergeFields involved).
 *   • Existing doc with no prompt + row supplies one: include `prompt`
 *     in mergeFields so it lands on this re-seed.
 *   • Existing doc with a prompt + row supplies one (different or same):
 *     drop the prompt from the write so the existing value is preserved.
 *     This is the "don't clobber a curated prompt with a re-seed" rule.
 *   • Existing doc with a prompt + row omits prompt: drop the prompt from
 *     the write so the existing value is preserved.
 */
export function planSeedWrite(
  row: InspirationSeedInput,
  existing: ExistingDocInfo,
): SeedWritePlan {
  const body = buildSeedDoc({ row });

  if (!existing.exists) {
    // Full first write — every field in `body` (including `prompt` when set)
    // lands together. No mergeFields.
    return { data: { ...body }, mergeFields: null, created: true };
  }

  const existingHasPrompt =
    typeof existing.prompt === "string" && existing.prompt.length > 0;

  // Start from the standard merge-fields list (excludes `prompt`).
  const { prompt, ...bodyWithoutPrompt } = body;
  const data: Record<string, unknown> = { ...bodyWithoutPrompt };
  const mergeFields: string[] = [...INSPIRATION_UPSERT_MERGE_FIELDS];

  // First-time prompt write: existing doc has none, current row supplies one.
  if (typeof prompt === "string" && !existingHasPrompt) {
    data.prompt = prompt;
    mergeFields.push("prompt");
  }

  return { data, mergeFields, created: false };
}

function nullable(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
