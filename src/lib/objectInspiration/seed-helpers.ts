import {
  ObjectCategorySeedInputSchema,
  ObjectInspirationSeedInputSchema,
  ObjectInspirationTitleUpdateInputSchema,
  type ObjectCategorySeedInput,
  type ObjectInspirationSeedInput,
  type ObjectInspirationTitleUpdateInput,
} from "./schemas.js";

/**
 * Manifest envelope for the bulk-seed paths. Both `categories` and
 * `items` are optional, but at least one must be present (and an array).
 * The partial shape lets operators update categories and items
 * independently without having to round-trip the full 800-item payload
 * each time — common workflow once the catalog is in place.
 *
 * When `items` references a `categoryId` not in the submitted
 * `categories`, the FK check falls back to a Firestore lookup (see
 * `validateForeignKeysAsync`). That keeps a "send items only" payload
 * safe even though no categories are inlined.
 */
export interface Manifest {
  categories: unknown[];
  items: unknown[];
}

export interface SeedOutcome {
  kind: "category" | "item";
  id: string;
  status: "created" | "updated" | "skipped" | "failed";
  reason?: string;
  ts: string;
}

export function parseManifestText(raw: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      "Manifest must be an object with `categories` and/or `items` arrays.",
    );
  }
  const obj = parsed as Record<string, unknown>;
  const hasCategories = "categories" in obj;
  const hasItems = "items" in obj;
  if (!hasCategories && !hasItems) {
    throw new Error(
      "Manifest must include at least one of `categories` or `items`.",
    );
  }
  if (hasCategories && !Array.isArray(obj.categories)) {
    throw new Error("`categories` must be an array when present.");
  }
  if (hasItems && !Array.isArray(obj.items)) {
    throw new Error("`items` must be an array when present.");
  }
  return {
    categories: (obj.categories as unknown[] | undefined) ?? [],
    items: (obj.items as unknown[] | undefined) ?? [],
  };
}

/**
 * Validate each manifest row through the zod schemas — the same ones the
 * HTTP endpoint uses — so the bulk-seed paths enforce an identical contract
 * (allow-list, id regex, prompt length, etc.).
 */
export function parseRows(manifest: Manifest): {
  categories: ObjectCategorySeedInput[];
  items: ObjectInspirationSeedInput[];
  errors: string[];
} {
  const categories: ObjectCategorySeedInput[] = [];
  const items: ObjectInspirationSeedInput[] = [];
  const errors: string[] = [];

  for (const raw of manifest.categories) {
    const parsed = ObjectCategorySeedInputSchema.safeParse(raw);
    if (!parsed.success) {
      const id =
        raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
          ? String((raw as { id?: unknown }).id)
          : "<unknown>";
      errors.push(
        `category id=${id} validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
      continue;
    }
    categories.push(parsed.data);
  }

  for (const raw of manifest.items) {
    const parsed = ObjectInspirationSeedInputSchema.safeParse(raw);
    if (!parsed.success) {
      const id =
        raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
          ? String((raw as { id?: unknown }).id)
          : "<unknown>";
      errors.push(
        `item id=${id} validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
      continue;
    }
    items.push(parsed.data);
  }

  return { categories, items, errors };
}

/**
 * Pre-flight FK check operating on already-validated rows. Catches orphan
 * items before any Firestore traffic so a "wrote half the items to a
 * non-existent category" state cannot reach production.
 *
 * Payload-only — the items must reference a category in the submitted
 * `categories` array. For the partial-manifest workflow ("send items
 * without inlining the categories that already exist in Firestore"),
 * use `validateForeignKeysAsync` and pass a resolver that fetches
 * existing category ids.
 */
export function validateForeignKeys(
  categories: ObjectCategorySeedInput[],
  items: ObjectInspirationSeedInput[],
): string[] {
  const categoryIds = new Set(categories.map((c) => c.id));
  const errors: string[] = [];
  for (const item of items) {
    if (!categoryIds.has(item.categoryId)) {
      errors.push(
        `item id=${item.id} references unknown categoryId=${item.categoryId}`,
      );
    }
  }
  return errors;
}

/**
 * FK check that falls back to an external resolver (typically a Firestore
 * lookup) when an item references a categoryId not present in the
 * submitted `categories` array. Used by the bulk-seed paths so an
 * operator can send `items` only and have the FK check resolve missing
 * categoryIds against existing Firestore docs.
 *
 * The resolver is invoked at most once with the deduped orphan id set,
 * not per item — a 5000-item payload referencing 40 distinct
 * categoryIds hits Firestore at most 40 times (current
 * `getExistingObjectCategoryIds` uses a single `in` query batched at
 * 30 ids).
 */
export async function validateForeignKeysAsync(
  categories: ObjectCategorySeedInput[],
  items: ObjectInspirationSeedInput[],
  resolveMissing?: (orphanCategoryIds: string[]) => Promise<Set<string>>,
): Promise<string[]> {
  const known = new Set(categories.map((c) => c.id));
  const orphans: { itemId: string; categoryId: string }[] = [];
  for (const item of items) {
    if (!known.has(item.categoryId)) {
      orphans.push({ itemId: item.id, categoryId: item.categoryId });
    }
  }
  if (orphans.length === 0) return [];

  let resolved = new Set<string>();
  if (resolveMissing) {
    const orphanCats = [...new Set(orphans.map((o) => o.categoryId))];
    resolved = await resolveMissing(orphanCats);
  }

  return orphans
    .filter((o) => !resolved.has(o.categoryId))
    .map(
      (o) =>
        `item id=${o.itemId} references unknown categoryId=${o.categoryId}`,
    );
}

export async function dispatchWithConcurrency<TInput>(
  inputs: TInput[],
  concurrency: number,
  worker: (input: TInput) => Promise<SeedOutcome>,
  onOutcome?: (outcome: SeedOutcome) => void,
): Promise<SeedOutcome[]> {
  const outcomes: SeedOutcome[] = [];
  let next = 0;

  async function take(): Promise<void> {
    while (next < inputs.length) {
      const idx = next++;
      const outcome = await worker(inputs[idx] as TInput);
      outcomes.push(outcome);
      // Callback failures must not abort the pool — script's emitJsonl can
      // throw on stdout I/O errors (EPIPE/EBADF), which would otherwise
      // reject Promise.all and orphan already-completed Firestore writes
      // in sibling workers still in-flight. Swallow so the batch reaches
      // its natural completion; the returned outcomes are the truth.
      if (onOutcome) {
        try {
          onOutcome(outcome);
        } catch {
          // intentionally ignored
        }
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, concurrency) },
    () => take(),
  );
  await Promise.all(workers);
  return outcomes;
}

// MARK: - Title-only update manifest

export interface TitleUpdateManifest {
  titleUpdates: unknown[];
}

export function parseTitleUpdateManifestText(raw: string): TitleUpdateManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { titleUpdates?: unknown }).titleUpdates)
  ) {
    throw new Error(
      "Title-update manifest must be `{ titleUpdates: [...] }`.",
    );
  }
  return parsed as TitleUpdateManifest;
}

/**
 * Validate each title-update row through its zod schema. Mirrors
 * `parseRows` so the controller and the script share one validation
 * contract.
 */
export function parseTitleUpdateRows(manifest: TitleUpdateManifest): {
  updates: ObjectInspirationTitleUpdateInput[];
  errors: string[];
} {
  const updates: ObjectInspirationTitleUpdateInput[] = [];
  const errors: string[] = [];

  for (const raw of manifest.titleUpdates) {
    const parsed = ObjectInspirationTitleUpdateInputSchema.safeParse(raw);
    if (!parsed.success) {
      const id =
        raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
          ? String((raw as { id?: unknown }).id)
          : "<unknown>";
      errors.push(
        `item id=${id} validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
      continue;
    }
    updates.push(parsed.data);
  }

  // Duplicate-id check inside the manifest — silently overwriting your
  // own row with a later row in the same payload is almost always a
  // typo. Rejecting at the edge keeps the outcome list interpretable
  // (one row per id).
  const seen = new Set<string>();
  for (const row of updates) {
    if (seen.has(row.id)) {
      errors.push(`item id=${row.id} appears more than once in titleUpdates`);
    }
    seen.add(row.id);
  }

  return { updates, errors };
}

export function summarize(outcomes: SeedOutcome[]): {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
} {
  const summary = {
    total: outcomes.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };
  for (const outcome of outcomes) {
    summary[outcome.status]++;
  }
  return summary;
}
