#!/usr/bin/env node
/**
 * Bulk seed script for Explore inspirations.
 *
 * Mirrors `scripts/seed-object-inspirations.ts` — authenticates via the
 * Firebase Admin SDK service account, validates each row through the same
 * Zod schema that `POST /explore/inspirations` uses, and writes via the
 * shared `seedInspirationDoc` helper. One credential, no 1-hour ID-token
 * expiry, and zero validation drift from the HTTP route.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/sa.json \
 *   AWS_S3_BUCKET=home-interior-ai-app AWS_S3_REGION=us-east-1 \
 *     tsx scripts/seed-explore-inspirations.ts \
 *     --manifest=scripts/manifests/explore-inspirations.full.json \
 *     [--dry-run] [--concurrency=5] [--service-account=path/to/sa.json]
 *
 * The manifest is a flat JSON array of `InspirationSeedInput` rows — the
 * same shape the HTTP endpoint accepts as its body. See
 * `scripts/manifests/explore-inspirations.full.json` for the canonical
 * 340-row catalog.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import admin from "firebase-admin";

import { seedInspirationDoc } from "../src/lib/inspiration/firestore.js";
import {
  InspirationSeedInputSchema,
  type InspirationSeedInput,
} from "../src/lib/inspiration/schemas.js";

interface ScriptOptions {
  manifestPath: string;
  serviceAccountPath: string | undefined;
  dryRun: boolean;
  concurrency: number;
}

interface SeedOutcome {
  id: string;
  status: "created" | "updated" | "skipped" | "failed";
  reason?: string;
  ts: string;
}

function emitJsonl(outcome: SeedOutcome): void {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

function parseManifest(raw: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      "Manifest must be a JSON array of inspiration rows (POST /explore/inspirations body shape).",
    );
  }
  return parsed;
}

function validateRows(rows: unknown[]): {
  items: InspirationSeedInput[];
  errors: string[];
} {
  const items: InspirationSeedInput[] = [];
  const errors: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const result = InspirationSeedInputSchema.safeParse(rows[i]);
    if (result.success) {
      items.push(result.data);
    } else {
      const idHint =
        rows[i] && typeof rows[i] === "object" && rows[i] !== null
          ? (rows[i] as Record<string, unknown>)["id"]
          : undefined;
      errors.push(
        `row[${i}]${typeof idHint === "string" ? ` id=${idHint}` : ""}: ${result.error.issues
          .map((iss) => `${iss.path.join(".") || "<root>"}: ${iss.message}`)
          .join("; ")}`,
      );
    }
  }
  return { items, errors };
}

async function dispatchWithConcurrency<TInput>(
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
      if (onOutcome) {
        try {
          onOutcome(outcome);
        } catch {
          // Swallow callback failures so a stdout EPIPE doesn't orphan
          // in-flight Firestore writes in sibling workers.
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

async function seedOne(
  row: InspirationSeedInput,
  opts: ScriptOptions,
): Promise<SeedOutcome> {
  if (opts.dryRun) {
    return {
      id: row.id,
      status: "skipped",
      reason: "dry-run",
      ts: new Date().toISOString(),
    };
  }
  try {
    const result = await seedInspirationDoc(row);
    return {
      id: row.id,
      status: result.created ? "created" : "updated",
      ts: new Date().toISOString(),
    };
  } catch (err) {
    return {
      id: row.id,
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    };
  }
}

async function initializeFirebase(
  serviceAccountPath: string | undefined,
): Promise<void> {
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

  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}

function summarize(outcomes: SeedOutcome[]): {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
} {
  const s = { total: outcomes.length, created: 0, updated: 0, skipped: 0, failed: 0 };
  for (const o of outcomes) s[o.status]++;
  return s;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      "service-account": { type: "string" },
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
    dryRun: Boolean(values["dry-run"]),
    concurrency: Math.max(1, Number.parseInt(values.concurrency ?? "5", 10)),
  };

  const raw = await readFile(opts.manifestPath, "utf-8");
  const rows = parseManifest(raw);
  const { items, errors } = validateRows(rows);

  if (errors.length > 0) {
    console.error("Manifest row validation failed:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.error(
    `[seed] manifest: ${items.length} inspirations` +
      (opts.dryRun ? " (DRY RUN)" : "") +
      ` — concurrency=${opts.concurrency}`,
  );

  if (!opts.dryRun) {
    await initializeFirebase(opts.serviceAccountPath);
  }

  const outcomes = await dispatchWithConcurrency(
    items,
    opts.concurrency,
    (row) => seedOne(row, opts),
    emitJsonl,
  );

  const summary = summarize(outcomes);
  console.error(`[seed] summary: ${JSON.stringify(summary)}`);

  const failures = outcomes.filter((o) => o.status === "failed");
  if (failures.length > 0) {
    console.error(
      `[seed] WARNING: ${failures.length} inspiration(s) failed — re-run the same manifest to fill gaps. Failed ids:`,
    );
    for (const o of failures) {
      console.error(`  - ${o.id}${o.reason ? ` (${o.reason})` : ""}`);
    }
  }

  process.exit(summary.failed > 0 ? 1 : 0);
}

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
