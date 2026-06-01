/**
 * Pure manifest → category-id extraction, split out of the CLI so it is unit
 * testable without filesystem/CLI plumbing.
 *
 * Reads `categories[].id` from a `{ categories, items }` manifest; if no
 * category ids are found, falls back to the distinct `categoryId`s referenced
 * by `items[]` (an items-only manifest). Returns a sorted, de-duped list.
 */
export function extractCategoryIds(rawJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(
      `Categories manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const obj =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  const ids = new Set<string>();

  const categories = Array.isArray(obj.categories) ? obj.categories : [];
  for (const c of categories) {
    if (
      c &&
      typeof c === "object" &&
      typeof (c as { id?: unknown }).id === "string"
    ) {
      ids.add((c as { id: string }).id);
    }
  }
  if (ids.size === 0) {
    const items = Array.isArray(obj.items) ? obj.items : [];
    for (const it of items) {
      if (
        it &&
        typeof it === "object" &&
        typeof (it as { categoryId?: unknown }).categoryId === "string"
      ) {
        ids.add((it as { categoryId: string }).categoryId);
      }
    }
  }
  return [...ids].sort();
}
