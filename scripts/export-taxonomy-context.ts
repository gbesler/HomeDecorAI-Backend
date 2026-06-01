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
import { extractCategoryIds } from "../src/lib/taxonomy/read-category-ids.js";

const DEFAULT_CATEGORIES_MANIFEST =
  "scripts/manifests/object-inspirations.full.json";

/** Bad-args exit. Distinct from runtime errors (exit 1) so an automated caller
 *  can tell "I invoked it wrong" from "it failed while running". */
function failArgs(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main(): Promise<void> {
  let values: { "categories-manifest"?: string; format?: string; out?: string };
  try {
    ({ values } = parseArgs({
      options: {
        "categories-manifest": { type: "string" },
        format: { type: "string", default: "json" },
        out: { type: "string" },
      },
      strict: true,
    }));
  } catch (err) {
    // Unknown/malformed flag → bad args (exit 2), not a runtime error.
    failArgs(err instanceof Error ? err.message : String(err));
  }

  const format = values.format ?? "json";
  if (format !== "json" && format !== "markdown" && format !== "both") {
    failArgs(`--format must be one of: json | markdown | both (got "${format}")`);
  }
  // `both` would interleave a JSON document and Markdown prose on one stdout
  // stream, which no parser can split. Require --out so each goes to its file.
  if (format === "both" && !values.out) {
    failArgs("--format=both requires --out (cannot emit two formats to stdout)");
  }

  const manifestPath = values["categories-manifest"] ?? DEFAULT_CATEGORIES_MANIFEST;
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      failArgs(`--categories-manifest file not found: ${manifestPath}`);
    }
    throw err;
  }
  const objectCategoryIds = extractCategoryIds(raw);
  if (objectCategoryIds.length === 0) {
    console.error(
      `[taxonomy] warning: no object category ids found in ${manifestPath} — ` +
        `the exported context will have an empty category set.`,
    );
  }

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
