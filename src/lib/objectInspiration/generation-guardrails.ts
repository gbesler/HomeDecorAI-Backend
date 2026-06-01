/**
 * Object-inspiration generation guardrails (soft-warn).
 *
 * Scope reality (verified against both the iOS app and the backend): object
 * inspirations have NO closed `material` / `style` / "object type" taxonomy.
 * The only system-defined closed sets for objects are:
 *   - `toolTypes` — `OBJECT_TOOL_TYPE_VALUES` (hard-enforced by `z.enum` in
 *     `schemas.ts`; an out-of-set value is rejected at parse time, so no
 *     soft-warn is needed or provided here).
 *   - the set of existing object categories (the ~40 category slugs that
 *     already live in Firestore / the full manifest).
 *
 * This module flags the one gap the schema can't: a generator (or author)
 * "inventing" a category that does not already exist in the system. That is
 * advisory — new categories are legitimately added over time — so it is a
 * soft-warn, distinct from `validateForeignKeys`, which hard-fails on
 * manifest-internal orphan items.
 *
 * Purity: no imports, no env. Inputs are structural so callers can pass either
 * parsed seed rows or lightweight generator output.
 */

/** Minimal category reference (a manifest/seed category). */
export interface ObjectCategoryRef {
  readonly id: string;
}

/** Minimal item reference (a manifest/seed item). */
export interface ObjectItemRef {
  readonly id: string;
  readonly categoryId: string;
}

/** An advisory taxonomy concern found in proposed object content. */
export interface ObjectTaxonomyWarning {
  /**
   * - `new-category`: a category not present in the known/system set — likely
   *   an invented category; confirm it is intentional before seeding.
   * - `item-unknown-category`: an item referencing a category that exists
   *   neither in the known set nor in the proposed categories.
   */
  readonly kind: "new-category" | "item-unknown-category";
  /** Category id (for `new-category`) or item id (for `item-unknown-category`). */
  readonly subjectId: string;
  /** The category id in question. */
  readonly categoryId: string;
}

/**
 * Collect soft warnings for proposed object content against the authoritative
 * set of existing category ids (e.g. from `getExistingObjectCategoryIds`).
 * Never throws; never blocks.
 */
export function collectObjectTaxonomyWarnings(
  proposed: {
    readonly categories?: readonly ObjectCategoryRef[];
    readonly items?: readonly ObjectItemRef[];
  },
  knownCategoryIds: Iterable<string>,
): ObjectTaxonomyWarning[] {
  const known =
    knownCategoryIds instanceof Set
      ? knownCategoryIds
      : new Set(knownCategoryIds);
  const categories = proposed.categories ?? [];
  const items = proposed.items ?? [];
  const proposedCategoryIds = new Set(categories.map((c) => c.id));

  const warnings: ObjectTaxonomyWarning[] = [];

  // A proposed category not already in the system → possibly invented.
  for (const c of categories) {
    if (!known.has(c.id)) {
      warnings.push({
        kind: "new-category",
        subjectId: c.id,
        categoryId: c.id,
      });
    }
  }

  // An item pointing at a category neither known nor proposed in this batch.
  // (Manifest-internal orphans where the category IS proposed are the hard
  // FK check's job — we don't double-report those.)
  for (const it of items) {
    if (!known.has(it.categoryId) && !proposedCategoryIds.has(it.categoryId)) {
      warnings.push({
        kind: "item-unknown-category",
        subjectId: it.id,
        categoryId: it.categoryId,
      });
    }
  }

  return warnings;
}

/** Format warnings as human-readable lines for a seed/generation summary. */
export function formatObjectTaxonomyWarnings(
  warnings: readonly ObjectTaxonomyWarning[],
): string[] {
  return warnings.map((w) =>
    w.kind === "new-category"
      ? `category id=${w.categoryId} is not an existing object category (new/invented — confirm before seeding)`
      : `item id=${w.subjectId} references categoryId=${w.categoryId} which is neither existing nor proposed`,
  );
}
