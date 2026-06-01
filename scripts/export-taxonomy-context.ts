#!/usr/bin/env node
/**
 * Export the system's allowed-values "taxonomy context" for inspiration seed
 * generation. This is the Phase-1 deliverable of the hybrid generator
 * approach: it serializes every system-defined closed set (explore axes from
 * the taxonomy registry + object toolTypes + the existing object categories)
 * into JSON and/or Markdown so a generation step can be told to pick ONLY from
 * these values.
 *
 * Object categories: there is no live "list all categories" reader, and the
 * full manifest IS the source of truth for the complete category set, so the
 * categories are read from a manifest file (default the full manifest) rather
 * than Firestore. This keeps the export env-free and Firebase-free.
 *
 * Usage:
 *   tsx scripts/export-taxonomy-context.ts \
 *     [--categories-manifest=scripts/manifests/object-inspirations.full.json] \
 *     [--format=json|markdown|both] \
 *     [--out=scripts/manifests/_generated]
 *
 * With no --out, JSON is written to stdout (markdown to stdout when
 * --format=markdown). With --out, files are written as taxonomy-context.json
 * and/or taxonomy-context.md.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { join } from "node:path";

import { serializeTaxonomyContext } from "../src/lib/taxonomy/serialize-context.js";

const DEFAULT_CATEGORIES_MANIFEST =
  "scripts/manifests/object-inspirations.full.json";

/** Read object category ids from a `{ categories, items }` manifest. Uses the
 *  `categories[].id` list; if a manifest carries only items, falls back to the
 *  distinct `categoryId`s referenced by items. Returns a sorted, de-duped set. */
async function readCategoryIds(manifestPath: string): Promise<string[]> {
  const raw = await readFile(manifestPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Categories manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const obj =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const ids = new Set<string>();

  const categories = Array.isArray(obj.categories) ? obj.categories : [];
  for (const c of categories) {
    if (c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string") {
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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "categories-manifest": { type: "string" },
      format: { type: "string", default: "json" },
      out: { type: "string" },
    },
    strict: true,
  });

  const format = values.format ?? "json";
  if (format !== "json" && format !== "markdown" && format !== "both") {
    console.error("--format must be one of: json | markdown | both");
    process.exit(2);
  }

  const manifestPath = values["categories-manifest"] ?? DEFAULT_CATEGORIES_MANIFEST;
  const objectCategoryIds = await readCategoryIds(manifestPath);

  const { json, markdown } = serializeTaxonomyContext({ objectCategoryIds });

  if (values.out) {
    await mkdir(values.out, { recursive: true });
    if (format === "json" || format === "both") {
      await writeFile(join(values.out, "taxonomy-context.json"), json + "\n");
    }
    if (format === "markdown" || format === "both") {
      await writeFile(join(values.out, "taxonomy-context.md"), markdown);
    }
    console.error(
      `[taxonomy] wrote ${format} context to ${values.out} ` +
        `(${objectCategoryIds.length} object categories from ${manifestPath})`,
    );
    return;
  }

  if (format === "markdown") {
    process.stdout.write(markdown);
  } else if (format === "both") {
    process.stdout.write(json + "\n\n");
    process.stdout.write(markdown);
  } else {
    process.stdout.write(json + "\n");
  }
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
