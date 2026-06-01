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
 * An HTTP equivalent (`POST /api/object-inspirations/bulk-seed`) exists
 * for ad-hoc dev/content iteration; both paths share the same validation
 * and Firestore upsert helpers (`src/lib/objectInspiration/seed-helpers`).
 * Prefer the HTTP path when you have a valid Firebase ID token and
 * convenience matters; prefer this script for ops / long-running batches
 * where a service account is appropriate.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import admin from "firebase-admin";

import type {
  ObjectCategorySeedInput,
  ObjectInspirationSeedInput,
  SeedMode,
} from "../src/lib/objectInspiration/schemas.js";
import {
  dispatchWithConcurrency,
  parseManifestText,
  parseRows,
  summarize,
  validateForeignKeys,
  validateForeignKeysAsync,
  type Manifest,
  type SeedOutcome,
} from "../src/lib/objectInspiration/seed-helpers.js";
import {
  collectObjectTaxonomyWarnings,
  formatObjectTaxonomyWarnings,
} from "../src/lib/objectInspiration/generation-guardrails.js";
import {
  getExistingObjectCategoryIds,
  seedObjectCategoryDoc,
  seedObjectInspirationDoc,
} from "../src/lib/objectInspiration/firestore.js";

interface ScriptOptions {
  manifestPath: string;
  serviceAccountPath: string | undefined;
  overwritePrompts: boolean;
  dryRun: boolean;
  concurrency: number;
}

function emitJsonl(outcome: SeedOutcome): void {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
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

  // FK check: payload-only first (fast, no network). If items reference
  // categoryIds outside the payload, those orphans need Firestore
  // verification — initialize Firebase first, then re-check with the
  // Firestore resolver. Dry-run skips the Firestore phase and reports
  // payload-only orphans as a warning (operator must verify manually
  // that the missing categoryIds already exist in Firestore).
  const payloadFkErrors = validateForeignKeys(categories, items);
  const hasOrphans = payloadFkErrors.length > 0;

  console.error(
    `[seed] manifest: ${categories.length} categories, ${items.length} items` +
      (opts.dryRun ? " (DRY RUN)" : "") +
      (opts.overwritePrompts ? " [OVERWRITE PROMPTS]" : ""),
  );

  if (hasOrphans && opts.dryRun) {
    console.error(
      `[seed] WARNING: ${payloadFkErrors.length} item(s) reference categoryIds not inlined in this manifest — skipping Firestore FK resolution under --dry-run. Verify those categories exist before running for real:`,
    );
    for (const e of payloadFkErrors) console.error(`  - ${e}`);
  }

  if (!opts.dryRun) {
    await initializeFirebase(opts.serviceAccountPath);
    if (hasOrphans) {
      const remainingFkErrors = await validateForeignKeysAsync(
        categories,
        items,
        getExistingObjectCategoryIds,
      );
      if (remainingFkErrors.length > 0) {
        console.error("Manifest pre-flight FK validation failed (after Firestore resolve):");
        for (const e of remainingFkErrors) console.error(`  - ${e}`);
        process.exit(1);
      }
    }

    // Soft-warn (advisory, non-blocking): flag manifest categories that do
    // not already exist in Firestore. Objects have no closed material/style
    // taxonomy — the only system-defined sets are `toolTypes` (hard-enforced
    // by zod) and the existing category set — so a brand-new category is the
    // one "invented value" signal worth surfacing. New categories are
    // legitimate, hence advisory rather than a hard fail.
    if (categories.length > 0) {
      const existingCategoryIds = await getExistingObjectCategoryIds(
        categories.map((c) => c.id),
      );
      const taxonomyWarnings = collectObjectTaxonomyWarnings(
        { categories, items },
        existingCategoryIds,
      );
      if (taxonomyWarnings.length > 0) {
        console.error(
          `[seed] taxonomy: ${taxonomyWarnings.length} advisory note(s) (non-blocking):`,
        );
        for (const line of formatObjectTaxonomyWarnings(taxonomyWarnings)) {
          console.error(`  - ${line}`);
        }
      }
    }
  }

  const mode: SeedMode = opts.overwritePrompts ? "overwrite" : "default";

  const categoryOutcomes = await dispatchWithConcurrency(
    categories,
    opts.concurrency,
    (cat) => seedOneCategory(cat, opts),
    emitJsonl,
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

  const itemOutcomes = await dispatchWithConcurrency(
    items,
    opts.concurrency,
    (item) => seedOneItem(item, mode, opts),
    emitJsonl,
  );

  const all = [...categoryOutcomes, ...itemOutcomes];
  const summary = summarize(all);
  console.error(`[seed] summary: ${JSON.stringify(summary)}`);

  // Item-phase failures don't abort the batch (item N+1 may still
  // succeed against the partially-failed state), so surface the
  // failed ids loudly so an operator can target a re-seed instead of
  // assuming "exit 1 = redo everything".
  const itemFailures = itemOutcomes.filter((o) => o.status === "failed");
  if (itemFailures.length > 0) {
    console.error(
      `[seed] WARNING: ${itemFailures.length} item(s) failed mid-batch — catalog may be incomplete. Re-run with the same manifest to fill gaps. Failed ids:`,
    );
    for (const o of itemFailures) {
      console.error(`  - ${o.id}${o.reason ? ` (${o.reason})` : ""}`);
    }
  }

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

// Re-export helpers from their new home so any pre-existing import that
// pointed at this script keeps resolving. New callers should import from
// `src/lib/objectInspiration/seed-helpers.js` directly.
export {
  dispatchWithConcurrency,
  parseManifestText,
  parseRows,
  summarize,
  validateForeignKeys,
} from "../src/lib/objectInspiration/seed-helpers.js";
export type { Manifest, SeedOutcome } from "../src/lib/objectInspiration/seed-helpers.js";
export type { ScriptOptions };
