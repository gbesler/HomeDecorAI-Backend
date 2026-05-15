import {
  ObjectCategorySeedInputSchema,
  ObjectInspirationSeedInputSchema,
  type ObjectCategorySeedInput,
  type ObjectInspirationSeedInput,
} from "./schemas.js";

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
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { categories?: unknown }).categories) ||
    !Array.isArray((parsed as { items?: unknown }).items)
  ) {
    throw new Error(
      "Manifest must be `{ categories: [...], items: [...] }` (both arrays).",
    );
  }
  return parsed as Manifest;
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
