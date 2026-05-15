#!/usr/bin/env node
/**
 * Bulk title-update script for object inspirations.
 *
 * Patches only the localized `title` field on existing inspiration
 * docs. Prompt, image fields, order, active, categoryId — none of
 * those move. Missing items are reported as `failed` (no upsert): use
 * the seed script for new rows so the full validation + allow-list
 * stay the single source of truth for new content.
 *
 * Authenticates via Firebase Admin SDK service account (same pattern
 * as `seed-object-inspirations.ts`). Mirrors the HTTP equivalent
 * (`POST /api/object-inspirations/bulk-update-titles`) — both share
 * the same zod schema and Firestore helper.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/prod-sa.json \
 *     tsx scripts/update-object-inspiration-titles.ts \
 *     --manifest=scripts/manifests/object-inspiration-titles.json \
 *     [--dry-run] [--concurrency=5] \
 *     [--service-account=path/to/sa.json]
 *
 * Manifest shape:
 *   { "titleUpdates": [
 *       { "id": "sofas_1", "title": { "en": "...", "tr": "..." } },
 *       ...
 *   ] }
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import admin from "firebase-admin";

import type { ObjectInspirationTitleUpdateInput } from "../src/lib/objectInspiration/schemas.js";
import {
  dispatchWithConcurrency,
  parseTitleUpdateManifestText,
  parseTitleUpdateRows,
  summarize,
  type SeedOutcome,
} from "../src/lib/objectInspiration/seed-helpers.js";
import {
  ObjectInspirationNotFoundError,
  updateObjectInspirationTitleDoc,
} from "../src/lib/objectInspiration/firestore.js";

interface ScriptOptions {
  manifestPath: string;
  serviceAccountPath: string | undefined;
  dryRun: boolean;
  concurrency: number;
}

function emitJsonl(outcome: SeedOutcome): void {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

async function updateOneTitle(
  row: ObjectInspirationTitleUpdateInput,
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
    await updateObjectInspirationTitleDoc(row.id, row.title);
    return {
      kind: "item",
      id: row.id,
      status: "updated",
      ts: new Date().toISOString(),
    };
  } catch (err) {
    const reason =
      err instanceof ObjectInspirationNotFoundError
        ? `inspiration not found: ${row.id} — title-update path does not create new items; use seed-object-inspirations.ts for new rows`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      kind: "item",
      id: row.id,
      status: "failed",
      reason,
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

  admin.initializeApp({ credential: admin.credential.applicationDefault() });
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
  const manifest = parseTitleUpdateManifestText(raw);

  const { updates, errors: rowErrors } = parseTitleUpdateRows(manifest);
  if (rowErrors.length > 0) {
    console.error("Manifest row validation failed:");
    for (const e of rowErrors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.error(
    `[title-update] manifest: ${updates.length} title updates` +
      (opts.dryRun ? " (DRY RUN)" : ""),
  );

  if (!opts.dryRun) {
    await initializeFirebase(opts.serviceAccountPath);
  }

  const outcomes = await dispatchWithConcurrency(
    updates,
    opts.concurrency,
    (row) => updateOneTitle(row, opts),
    emitJsonl,
  );

  const summary = summarize(outcomes);
  console.error(`[title-update] summary: ${JSON.stringify(summary)}`);

  const failures = outcomes.filter((o) => o.status === "failed");
  if (failures.length > 0) {
    console.error(
      `[title-update] WARNING: ${failures.length} update(s) failed. Failed ids:`,
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

export type { ScriptOptions };
