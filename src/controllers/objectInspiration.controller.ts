import type { FastifyReply, FastifyRequest } from "fastify";

import {
  badRequest,
  internalError,
  unauthorized,
} from "../lib/controller-helpers.js";
import {
  seedObjectCategoryDoc,
  seedObjectInspirationDoc,
} from "../lib/objectInspiration/firestore.js";
import {
  parseSeedMode,
  type ObjectCategorySeedInput,
  type ObjectInspirationSeedInput,
  type SeedMode,
} from "../lib/objectInspiration/schemas.js";
import {
  dispatchWithConcurrency,
  parseRows,
  summarize,
  validateForeignKeys,
  type Manifest,
  type SeedOutcome,
} from "../lib/objectInspiration/seed-helpers.js";

/**
 * Bounded concurrency for the per-doc Firestore upserts. Mirrors the
 * seed script's default (`--concurrency=5` CLI default → 10 here is the
 * historical sweet spot from the script's bulk runs against 800-item
 * manifests). Held server-side rather than exposed as a request param to
 * keep the API surface narrow.
 */
const SEED_CONCURRENCY = 10;

interface SeedRowIssue {
  kind: "category" | "item";
  id: string;
  message: string;
}

function rowErrorsToIssues(rowErrors: string[]): SeedRowIssue[] {
  // Row error strings look like:
  //   "category id=<id> validation failed: <details>"
  //   "item id=<id> validation failed: <details>"
  //   "item id=<id> references unknown categoryId=<cid>"
  return rowErrors.map((line) => {
    const kindMatch = /^(category|item) id=([^\s]+)/.exec(line);
    if (!kindMatch) return { kind: "item", id: "<unknown>", message: line };
    return {
      kind: kindMatch[1] as "category" | "item",
      id: kindMatch[2] ?? "<unknown>",
      message: line,
    };
  });
}

function isManifestShape(body: unknown): body is Manifest {
  return (
    !!body &&
    typeof body === "object" &&
    Array.isArray((body as { categories?: unknown }).categories) &&
    Array.isArray((body as { items?: unknown }).items)
  );
}

/**
 * Bulk seed handler for the object-inspiration catalog. Accepts a manifest
 * `{ categories, items }` and writes both layers to Firestore using the
 * same validation and upsert helpers the offline seed script uses.
 *
 * Auth mirrors the Explorer seed handler (Firebase Bearer via
 * `app.authenticate`). Tighten with a custom claim or separate admin gate
 * once an external authoring surface ships.
 *
 * Item-phase failures keep the response 200 — the caller inspects
 * `summary.failed` and re-submits the same manifest to fill gaps (the
 * Firestore upsert is idempotent, so re-submits are safe).
 */
export async function bulkSeedObjectInspirationsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const body = request.body;
  if (!isManifestShape(body)) {
    return badRequest(
      reply,
      "Body must be `{ categories: array, items: array }`.",
    );
  }

  const { categories, items, errors: rowErrors } = parseRows(body);
  if (rowErrors.length > 0) {
    reply.code(400);
    return {
      error: "Validation Error",
      message: `Manifest row validation failed (${rowErrors.length} issue${rowErrors.length === 1 ? "" : "s"}).`,
      issues: rowErrorsToIssues(rowErrors),
    };
  }

  const fkErrors = validateForeignKeys(categories, items);
  if (fkErrors.length > 0) {
    reply.code(400);
    return {
      error: "Validation Error",
      message: `Foreign-key validation failed (${fkErrors.length} orphan${fkErrors.length === 1 ? "" : "s"}).`,
      issues: rowErrorsToIssues(fkErrors),
    };
  }

  const mode: SeedMode = parseSeedMode(request.headers["x-seed-mode"]);

  request.log.info(
    {
      event: "objectInspirationSeed.start",
      userId,
      categoryCount: categories.length,
      itemCount: items.length,
      mode,
    },
    "Object inspiration bulk seed starting",
  );

  try {
    const categoryOutcomes = await dispatchWithConcurrency(
      categories,
      SEED_CONCURRENCY,
      (row) => seedOneCategory(row),
    );

    const categoryFailed = categoryOutcomes.filter((o) => o.status === "failed");
    if (categoryFailed.length > 0) {
      const summary = summarize(categoryOutcomes);
      request.log.warn(
        {
          event: "objectInspirationSeed.category_phase_failed",
          userId,
          summary,
        },
        "Object inspiration bulk seed aborted at category phase",
      );
      // 200 with failure summary mirrors the script's exit semantics —
      // operators inspect summary.failed and `outcomes[].reason` to
      // decide whether to retry, without needing a separate error shape.
      return { summary, outcomes: categoryOutcomes };
    }

    const itemOutcomes = await dispatchWithConcurrency(
      items,
      SEED_CONCURRENCY,
      (row) => seedOneItem(row, mode),
    );

    const all = [...categoryOutcomes, ...itemOutcomes];
    const summary = summarize(all);

    request.log.info(
      {
        event: "objectInspirationSeed.done",
        userId,
        summary,
      },
      "Object inspiration bulk seed complete",
    );

    return { summary, outcomes: all };
  } catch (err) {
    // Per-row failures are captured into outcomes by seedOneCategory /
    // seedOneItem — this catch is for the truly unexpected (admin SDK
    // init failure, network teardown). NOTE: do NOT spread `body` or
    // `categories`/`items` into this log — `prompt` fields may contain
    // proprietary prompting strategies and must stay out of structured
    // logs.
    request.log.error(
      {
        event: "objectInspirationSeed.failed",
        userId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Object inspiration bulk seed failed",
    );
    return internalError(reply, "Failed to bulk seed object inspirations.");
  }
}

async function seedOneCategory(
  row: ObjectCategorySeedInput,
): Promise<SeedOutcome> {
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
): Promise<SeedOutcome> {
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
