import type {
  LocalizedSearchTerms,
  LocalizedTitle,
  ObjectInspirationCategoryDoc,
  ObjectInspirationItemDoc,
  ObjectToolType,
} from "./types.js";
import type {
  ObjectCategorySeedInput,
  ObjectInspirationSeedInput,
  SeedMode,
} from "./schemas.js";

// Re-export the canonical input types so downstream callers don't need to
// reach into the zod module.
export type { ObjectCategorySeedInput, ObjectInspirationSeedInput, SeedMode } from "./schemas.js";

/**
 * Field policy (explicit, not implicit-from-mergeFields):
 *
 *   PROTECTED on default mode  → `[prompt, createdAt]`
 *   PROPAGATED always-updated  → `[title, imageUrl, imageWidth,
 *                                 imageHeight, imageMime, order, active,
 *                                 toolTypes, updatedAt]`
 *
 * On `overwrite` mode, `prompt` joins PROPAGATED. `createdAt` is never
 * overwritten on either mode; the first-write branch is the only path
 * that stamps it.
 *
 * Categories share the same policy minus `prompt` (categories have no
 * prompt). `heroImage*` follows the image-propagated semantics: a
 * re-seed with a corrected hero image overwrites the previous URL.
 */
export const OBJECT_CATEGORY_MERGE_FIELDS = [
  "schemaVersion",
  "id",
  "order",
  "active",
  "title",
  "heroImageUrl",
  "heroImageWidth",
  "heroImageHeight",
  "heroImageMime",
  "toolTypes",
  "updatedAt",
] as const;

export const OBJECT_INSPIRATION_DEFAULT_MERGE_FIELDS = [
  "schemaVersion",
  "id",
  "categoryId",
  "order",
  "active",
  "title",
  "imageUrl",
  "imageWidth",
  "imageHeight",
  "imageMime",
  "toolTypes",
  "searchTerms",
  "updatedAt",
] as const;

/** When seed mode is `overwrite`, `prompt` joins the merge list. */
export const OBJECT_INSPIRATION_OVERWRITE_MERGE_FIELDS = [
  ...OBJECT_INSPIRATION_DEFAULT_MERGE_FIELDS,
  "prompt",
] as const;

const SCHEMA_VERSION = 1;
const DEFAULT_IMAGE_MIME = "image/jpeg";

function copyTitle(title: LocalizedTitle): LocalizedTitle {
  // Spread carries every present optional language (de, fr, ja, …)
  // through to the Firestore document without enumerating each code.
  // `en` + `tr` are required by the type so the result still satisfies
  // `LocalizedTitle`'s base contract.
  return { ...title };
}

function copyToolTypes(toolTypes: readonly ObjectToolType[]): ObjectToolType[] {
  return Array.from(toolTypes);
}

/**
 * Project a Zod-parsed `searchTerms` value into the Firestore data block.
 * Returns `undefined` when the value is absent OR when every language
 * array is empty — that way `searchTerms: undefined` and
 * `searchTerms: { en: [], tr: [] }` round-trip identical (no field
 * stored, no needless write). When some arrays are populated and
 * others empty, the empty ones are dropped from the projection so the
 * stored doc carries only the languages that actually have content.
 *
 * Note: `searchTerms` IS in `OBJECT_INSPIRATION_DEFAULT_MERGE_FIELDS`,
 * so a re-seed that omits the input field will silently clear an
 * existing `searchTerms` on the document. This matches the merge-field
 * semantics for every other propagated field (title, imageUrl, …) and
 * is documented as the contract in the brainstorm doc §4.5.
 */
function copySearchTerms(
  input: LocalizedSearchTerms | undefined,
): LocalizedSearchTerms | undefined {
  if (!input) return undefined;
  const en = input.en ?? [];
  const tr = input.tr ?? [];
  if (en.length === 0 && tr.length === 0) return undefined;
  const out: LocalizedSearchTerms = {};
  if (en.length > 0) out.en = [...en];
  if (tr.length > 0) out.tr = [...tr];
  return out;
}

/**
 * Pure builder: map a category seed input into the Firestore data block
 * (sans server timestamps). Used both by the route handler and by unit
 * tests so the shape decisions live in one place.
 */
export function buildObjectCategoryDoc(
  input: ObjectCategorySeedInput,
): Omit<ObjectInspirationCategoryDoc, "createdAt" | "updatedAt"> {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: input.id,
    order: input.order,
    active: input.active,
    title: copyTitle(input.title),
    heroImageUrl: input.heroImageUrl,
    heroImageWidth: input.heroImageWidth,
    heroImageHeight: input.heroImageHeight,
    heroImageMime:
      typeof input.heroImageMime === "string" && input.heroImageMime.length > 0
        ? input.heroImageMime
        : DEFAULT_IMAGE_MIME,
    toolTypes: copyToolTypes(input.toolTypes),
  };
}

/**
 * Pure builder: map an item seed input into the Firestore data block
 * (sans server timestamps).
 */
export function buildObjectInspirationDoc(
  input: ObjectInspirationSeedInput,
): Omit<ObjectInspirationItemDoc, "createdAt" | "updatedAt"> {
  const doc: Omit<ObjectInspirationItemDoc, "createdAt" | "updatedAt"> = {
    schemaVersion: SCHEMA_VERSION,
    id: input.id,
    categoryId: input.categoryId,
    order: input.order,
    active: input.active,
    title: copyTitle(input.title),
    prompt: input.prompt,
    imageUrl: input.imageUrl,
    imageWidth: input.imageWidth,
    imageHeight: input.imageHeight,
    imageMime:
      typeof input.imageMime === "string" && input.imageMime.length > 0
        ? input.imageMime
        : DEFAULT_IMAGE_MIME,
    toolTypes: copyToolTypes(input.toolTypes),
  };
  const searchTerms = copySearchTerms(input.searchTerms);
  if (searchTerms) doc.searchTerms = searchTerms;
  return doc;
}

/**
 * Snapshot info the write planner needs from the existing Firestore doc.
 * Kept narrow so tests don't need a real `DocumentSnapshot`.
 */
export interface ExistingDocInfo {
  exists: boolean;
}

export interface SeedWritePlan<TData> {
  data: TData;
  /** Field list for `set(ref, data, { mergeFields })`. `null` means full
   *  first-write `set(ref, data)`. */
  mergeFields: readonly string[] | null;
  /** `true` when this is the first write. */
  created: boolean;
}

/**
 * Plan one category upsert. Categories have no prompt semantics, so the
 * plan is uniform: first write is full, re-seed merges everything in
 * `OBJECT_CATEGORY_MERGE_FIELDS`.
 */
export function planObjectCategorySeedWrite(
  input: ObjectCategorySeedInput,
  existing: ExistingDocInfo,
): SeedWritePlan<Omit<ObjectInspirationCategoryDoc, "createdAt" | "updatedAt">> {
  const data = buildObjectCategoryDoc(input);
  if (!existing.exists) {
    return { data, mergeFields: null, created: true };
  }
  return {
    data,
    mergeFields: [...OBJECT_CATEGORY_MERGE_FIELDS],
    created: false,
  };
}

/**
 * Plan one inspiration item upsert. Mode-aware: `default` preserves an
 * existing `prompt` across re-seeds (parity with Explorer pattern);
 * `overwrite` includes `prompt` in the merge fields, so a bulk seed
 * invoked with `--overwrite-prompts` (which forwards `X-Seed-Mode:
 * overwrite`) can correct prompts en masse.
 */
export function planObjectInspirationSeedWrite(
  input: ObjectInspirationSeedInput,
  existing: ExistingDocInfo,
  mode: SeedMode = "default",
): SeedWritePlan<Omit<ObjectInspirationItemDoc, "createdAt" | "updatedAt">> {
  const data = buildObjectInspirationDoc(input);

  if (!existing.exists) {
    return { data, mergeFields: null, created: true };
  }

  const mergeFields =
    mode === "overwrite"
      ? [...OBJECT_INSPIRATION_OVERWRITE_MERGE_FIELDS]
      : [...OBJECT_INSPIRATION_DEFAULT_MERGE_FIELDS];

  return { data, mergeFields, created: false };
}
