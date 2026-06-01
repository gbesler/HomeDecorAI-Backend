#!/usr/bin/env node
/**
 * One-time migration for the inspiration `imageUrl`/`heroImageUrl` → `path`
 * refactor (hard cutover — no dual-field window).
 *
 * For every doc in the three inspiration collections it:
 *   1. Backfills `path` from the legacy URL field when `path` is missing
 *      (strips the `https://host/` prefix → bucket-relative path). This makes
 *      the script self-sufficient even if the manifest re-seed hasn't run.
 *   2. Deletes the legacy `imageUrl` / `heroImageUrl` field so no doc is left
 *      carrying both shapes.
 *
 * Idempotent: a doc that already has `path` and no legacy field is skipped.
 *
 * Auth mirrors the seed scripts (Firebase Admin SDK service account):
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/prod-sa.json \
 *     tsx scripts/migrate-inspiration-image-path.ts [--dry-run] [--service-account=path]
 *
 * Run AFTER deploying the backend that reads `path` and re-seeding the
 * manifests, and ship the iOS `path` build in the same release window.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import admin from "firebase-admin";

interface CollectionSpec {
  collection: string;
  /** Legacy URL field to migrate away from. */
  legacyField: "imageUrl" | "heroImageUrl";
}

const COLLECTIONS: CollectionSpec[] = [
  { collection: "objectCategories", legacyField: "heroImageUrl" },
  { collection: "objectInspirations", legacyField: "imageUrl" },
  { collection: "inspirations", legacyField: "imageUrl" },
];

const HOST_PREFIX = /^https?:\/\/[^/]+\//;
const FIRESTORE_BATCH_LIMIT = 450; // < 500 hard cap, with headroom

interface Options {
  dryRun: boolean;
  serviceAccountPath: string | undefined;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      "service-account": { type: "string" },
    },
    strict: true,
  });
  return {
    dryRun: Boolean(values["dry-run"]),
    serviceAccountPath: values["service-account"],
  };
}

async function initializeFirebase(serviceAccountPath: string | undefined): Promise<void> {
  if (admin.apps.length > 0) return;
  if (serviceAccountPath) {
    const raw = await readFile(serviceAccountPath, "utf-8");
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw) as admin.ServiceAccount),
    });
    return;
  }
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}

/** Strip a `https://host/` prefix to a bucket-relative path. Returns null when
 *  the value isn't a usable string URL (caller skips path backfill then). */
function toRelativePath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw.replace(HOST_PREFIX, "");
}

interface CollectionResult {
  collection: string;
  total: number;
  legacyFound: number;
  pathBackfilled: number;
  skipped: number;
}

async function migrateCollection(
  spec: CollectionSpec,
  dryRun: boolean,
): Promise<CollectionResult> {
  const db = admin.firestore();
  const snap = await db.collection(spec.collection).get();
  const result: CollectionResult = {
    collection: spec.collection,
    total: snap.size,
    legacyFound: 0,
    pathBackfilled: 0,
    skipped: 0,
  };

  let batch = db.batch();
  let pending = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const hasLegacy = typeof data[spec.legacyField] === "string";
    const hasPath = typeof data["path"] === "string" && data["path"].length > 0;

    if (!hasLegacy) {
      result.skipped += 1; // already migrated (or never had the field)
      continue;
    }
    result.legacyFound += 1;

    const update: Record<string, unknown> = {
      [spec.legacyField]: admin.firestore.FieldValue.delete(),
    };
    if (!hasPath) {
      const relative = toRelativePath(data[spec.legacyField]);
      if (relative) {
        update["path"] = relative;
        result.pathBackfilled += 1;
      }
    }

    if (!dryRun) {
      batch.update(doc.ref, update);
      pending += 1;
      if (pending >= FIRESTORE_BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
  }

  if (!dryRun && pending > 0) await batch.commit();
  return result;
}

async function main(): Promise<void> {
  const opts = parseOptions();
  // Firestore reads are needed even for dry-run (to count legacy docs).
  await initializeFirebase(opts.serviceAccountPath);

  const results: CollectionResult[] = [];
  for (const spec of COLLECTIONS) {
    results.push(await migrateCollection(spec, opts.dryRun));
  }

  for (const r of results) {
    process.stderr.write(
      `[migrate] ${r.collection}: total=${r.total} legacyFound=${r.legacyFound} ` +
        `pathBackfilled=${r.pathBackfilled} skipped=${r.skipped}` +
        (opts.dryRun ? " (dry-run, no writes)\n" : "\n"),
    );
  }
}

main().catch((err) => {
  process.stderr.write(
    `[migrate] failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
