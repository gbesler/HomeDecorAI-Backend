#!/usr/bin/env node
/**
 * Bulk seed script for object inspirations.
 *
 * Authenticates via Firebase Admin SDK service account — NOT via the
 * HTTP endpoints. This is the canonical "ops bulk seed" pattern:
 *   • One credential (the service account JSON), no user/token mint.
 *   • No 1-hour ID-token expiry; long-running seeds are fine.
 *   • Same validation as the HTTP endpoint (the zod schemas are
 *     imported directly), so the rules differences between "wrote
 *     this from a script" and "wrote this from curl/Swagger" are
 *     zero.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/prod-sa.json \
 *     tsx scripts/seed-object-inspirations.ts \
 *     --manifest=scripts/manifests/object-inspirations.initial.json \
 *     [--overwrite-prompts] [--dry-run] [--concurrency=5] \
 *     [--service-account=path/to/sa.json]
 *
 * `GOOGLE_APPLICATION_CREDENTIALS` is the Firebase / GCP standard and
 * automatically picked up by `admin.credential.applicationDefault()`.
 * `--service-account=` overrides for cases where the env can't be
 * pre-set (e.g. one terminal targets staging, another prod).
 *
 * The HTTP endpoints (POST/PATCH/DELETE in `routes/objectInspirations.ts`)
 * are independent — they exist for future admin-panel / Swagger usage
 * and use the `requireAdminClaim` middleware. Bulk seed bypasses HTTP
 * entirely because it's an ops job, not a user-facing operation.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import admin from "firebase-admin";

import {
  ObjectCategorySeedInputSchema,
  ObjectInspirationSeedInputSchema,
  type ObjectCategorySeedInput,
  type ObjectInspirationSeedInput,
  type SeedMode,
} from "../src/lib/objectInspiration/schemas.js";
import {
  seedObjectCategoryDoc,
  seedObjectInspirationDoc,
} from "../src/lib/objectInspiration/firestore.js";

interface Manifest {
  categories: unknown[];
  items: unknown[];
}

interface ScriptOptions {
  manifestPath: string;
  serviceAccountPath: string | undefined;
  overwritePrompts: boolean;
  dryRun: boolean;
  concurrency: number;
}

interface SeedOutcome {
  kind: "category" | "item";
  id: string;
  status: "created" | "updated" | "skipped" | "failed";
  reason?: string;
  ts: string;
}

function emitJsonl(outcome: SeedOutcome): void {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

function parseManifestText(raw: string): Manifest {
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
 * Pre-flight FK check operating on already-validated rows. Catches
 * orphan items before any Firestore traffic so a "wrote half the items
 * to a non-existent category" state cannot reach production.
 */
function validateForeignKeys(
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

async function seedOneCategory(
  row: ObjectCategorySeedInput,
  opts: ScriptOptions,
): Promise<SeedOutcome> {
  if (opts.dryRun) {
    return {
      kind: "category",
      id: row.id,
      status: "skipped",
      reason: "dry-run",
      ts: new Date().toISOString(),
    };
  }
  try {
    const result = await seedObjectCategoryDoc(row);
    return {
      kind: "category",
      id: row.id,
      status: result.created ? "created" : "updated",
      ts: new Date().toISOString(),
    };
  } catch (err) {
    return {
      kind: "category",
      id: row.id,
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    };
  }
}

async function seedOneItem(
  row: ObjectInspirationSeedInput,
  mode: SeedMode,
  opts: ScriptOptions,
): Promise<SeedOutcome> {
  if (opts.dryRun) {
    return {
      kind: "item",
      id: row.id,
      status: "skipped",
      reason: "dry-run",
      ts: new Date().toISOString(),
    };
  }
  try {
    const result = await seedObjectInspirationDoc(row, mode);
    return {
      kind: "item",
      id: row.id,
      status: result.created ? "created" : "updated",
      ts: new Date().toISOString(),
    };
  } catch (err) {
    return {
      kind: "item",
      id: row.id,
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    };
  }
}

async function dispatchWithConcurrency<TInput>(
  inputs: TInput[],
  concurrency: number,
  worker: (input: TInput) => Promise<SeedOutcome>,
): Promise<SeedOutcome[]> {
  const outcomes: SeedOutcome[] = [];
  let next = 0;

  async function take(): Promise<void> {
    while (next < inputs.length) {
      const idx = next++;
      const outcome = await worker(inputs[idx] as TInput);
      outcomes.push(outcome);
      emitJsonl(outcome);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, concurrency) },
    () => take(),
  );
  await Promise.all(workers);
  return outcomes;
}

function summarize(outcomes: SeedOutcome[]): {
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

/**
 * Validate each manifest row through the zod schemas — the same ones
 * the HTTP endpoint uses — so the script enforces an identical
 * contract (allow-list, id regex, prompt length, etc).
 */
function parseRows(manifest: Manifest): {
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

async function initializeFirebase(serviceAccountPath: string | undefined): Promise<void> {
  if (admin.apps.length > 0) return;

  if (serviceAccountPath) {
    const raw = await readFile(serviceAccountPath, "utf-8");
    let parsed: admin.ServiceAccount;
    try {
      parsed = JSON.parse(raw) as admin.ServiceAccount;
    } catch (err) {
      throw new Error(
        `--service-account file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    admin.initializeApp({ credential: admin.credential.cert(parsed) });
    return;
  }

  // `applicationDefault()` reads GOOGLE_APPLICATION_CREDENTIALS env or
  // falls back to GCP metadata (Cloud Run / GCE / GKE). This is the
  // standard Firebase ops auth path.
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      "service-account": { type: "string" },
      "overwrite-prompts": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      concurrency: { type: "string", default: "5" },
    },
    strict: true,
  });

  if (!values.manifest) {
    console.error("Missing --manifest=<path>.");
    process.exit(2);
  }

  const opts: ScriptOptions = {
    manifestPath: values.manifest,
    serviceAccountPath: values["service-account"],
    overwritePrompts: Boolean(values["overwrite-prompts"]),
    dryRun: Boolean(values["dry-run"]),
    concurrency: Math.max(1, Number.parseInt(values.concurrency ?? "5", 10)),
  };

  const raw = await readFile(opts.manifestPath, "utf-8");
  const manifest = parseManifestText(raw);

  const { categories, items, errors: rowErrors } = parseRows(manifest);
  if (rowErrors.length > 0) {
    console.error("Manifest row validation failed:");
    for (const e of rowErrors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const fkErrors = validateForeignKeys(categories, items);
  if (fkErrors.length > 0) {
    console.error("Manifest pre-flight FK validation failed:");
    for (const e of fkErrors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.error(
    `[seed] manifest: ${categories.length} categories, ${items.length} items` +
      (opts.dryRun ? " (DRY RUN)" : "") +
      (opts.overwritePrompts ? " [OVERWRITE PROMPTS]" : ""),
  );

  if (!opts.dryRun) {
    await initializeFirebase(opts.serviceAccountPath);
  }

  const mode: SeedMode = opts.overwritePrompts ? "overwrite" : "default";

  const categoryOutcomes = await dispatchWithConcurrency(
    categories,
    opts.concurrency,
    (cat) => seedOneCategory(cat, opts),
  );
  const categoryFailed = categoryOutcomes.filter((o) => o.status === "failed");
  if (categoryFailed.length > 0) {
    console.error(
      `[seed] ${categoryFailed.length} categories failed — aborting before items.`,
    );
    const summary = summarize(categoryOutcomes);
    console.error(`[seed] summary: ${JSON.stringify(summary)}`);
    process.exit(1);
  }

  const itemOutcomes = await dispatchWithConcurrency(items, opts.concurrency, (item) =>
    seedOneItem(item, mode, opts),
  );

  const all = [...categoryOutcomes, ...itemOutcomes];
  const summary = summarize(all);
  console.error(`[seed] summary: ${JSON.stringify(summary)}`);

  process.exit(summary.failed > 0 ? 1 : 0);
}

// CLI guard so tests can import helpers without triggering `main()`.
function isCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
}

if (isCli()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export {
  parseManifestText,
  parseRows,
  validateForeignKeys,
  dispatchWithConcurrency,
  summarize,
};
export type { Manifest, SeedOutcome, ScriptOptions };
