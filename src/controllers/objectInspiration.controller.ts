import type { FastifyReply, FastifyRequest } from "fastify";

import {
  badRequest,
  internalError,
  unauthorized,
} from "../lib/controller-helpers.js";
import {
  ObjectInspirationNotFoundError,
  getExistingObjectCategoryIds,
  seedObjectCategoryDoc,
  seedObjectInspirationDoc,
  updateObjectInspirationTitleDoc,
} from "../lib/objectInspiration/firestore.js";
import {
  parseSeedMode,
  type ObjectCategorySeedInput,
  type ObjectInspirationSeedInput,
  type ObjectInspirationTitleUpdateInput,
  type SeedMode,
} from "../lib/objectInspiration/schemas.js";
import {
  dispatchWithConcurrency,
  parseRows,
  parseTitleUpdateRows,
  summarize,
  validateForeignKeysAsync,
  type Manifest,
  type SeedOutcome,
  type TitleUpdateManifest,
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

/**
 * Manifest shape gate. Both fields are optional but at least one must be
 * present (and an array when present) — lets operators update categories
 * or items independently without round-tripping the full payload. The
 * FK fallback in `validateForeignKeysAsync` resolves missing categoryIds
 * against Firestore so an items-only payload still gets a real FK check.
 *
 * Returns a typed manifest with defaulted-to-empty arrays so the rest of
 * the handler can treat both fields as always-present.
 */
function parseManifestShape(
  body: unknown,
): { ok: true; manifest: Manifest } | { ok: false; message: string } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      message:
        "Body must be an object with `categories` and/or `items` arrays.",
    };
  }
  const obj = body as Record<string, unknown>;
  const hasCategories = "categories" in obj;
  const hasItems = "items" in obj;
  if (!hasCategories && !hasItems) {
    return {
      ok: false,
      message:
        "Body must include at least one of `categories` or `items`.",
    };
  }
  if (hasCategories && !Array.isArray(obj.categories)) {
    return { ok: false, message: "`categories` must be an array when present." };
  }
  if (hasItems && !Array.isArray(obj.items)) {
    return { ok: false, message: "`items` must be an array when present." };
  }
  return {
    ok: true,
    manifest: {
      categories: (obj.categories as unknown[] | undefined) ?? [],
      items: (obj.items as unknown[] | undefined) ?? [],
    },
  };
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

  const parsed = parseManifestShape(request.body);
  if (!parsed.ok) {
    return badRequest(reply, parsed.message);
  }
  const manifest = parsed.manifest;

  const { categories, items, errors: rowErrors } = parseRows(manifest);
  if (rowErrors.length > 0) {
    reply.code(400);
    return {
      error: "Validation Error",
      message: `Manifest row validation failed (${rowErrors.length} issue${rowErrors.length === 1 ? "" : "s"}).`,
      issues: rowErrorsToIssues(rowErrors),
    };
  }

  // FK fallback: items may reference categoryIds not inlined in the
  // submitted `categories` (partial-manifest workflow — operator
  // updates items only, trusting Firestore-resident categories).
  // `validateForeignKeysAsync` invokes the resolver at most once with
  // the deduped orphan id set.
  const fkErrors = await validateForeignKeysAsync(
    categories,
    items,
    getExistingObjectCategoryIds,
  );
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

function isTitleUpdateManifestShape(
  body: unknown,
): body is TitleUpdateManifest {
  return (
    !!body &&
    typeof body === "object" &&
    Array.isArray((body as { titleUpdates?: unknown }).titleUpdates)
  );
}

/**
 * Bulk title-update handler. Patches only the `title.{en,tr}` field on
 * existing inspiration docs. Missing docs are reported as `failed` (no
 * upsert) so this path can never accidentally create new items — the
 * full POST upsert path is the one source of truth for new content.
 *
 * Item-row errors return 200 with `summary.failed > 0` and per-row
 * reasons (parity with bulk-seed: operators inspect outcomes, fix the
 * manifest, and re-submit — `update` is idempotent on title content).
 */
export async function bulkUpdateObjectInspirationTitlesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const body = request.body;
  if (!isTitleUpdateManifestShape(body)) {
    return badRequest(reply, "Body must be `{ titleUpdates: array }`.");
  }

  const { updates, errors: rowErrors } = parseTitleUpdateRows(body);
  if (rowErrors.length > 0) {
    reply.code(400);
    return {
      error: "Validation Error",
      message: `Title-update row validation failed (${rowErrors.length} issue${rowErrors.length === 1 ? "" : "s"}).`,
      issues: rowErrorsToIssues(rowErrors),
    };
  }

  request.log.info(
    {
      event: "objectInspirationTitleUpdate.start",
      userId,
      updateCount: updates.length,
    },
    "Object inspiration bulk title-update starting",
  );

  try {
    const outcomes = await dispatchWithConcurrency(
      updates,
      SEED_CONCURRENCY,
      (row) => updateOneTitle(row),
    );
    const summary = summarize(outcomes);

    request.log.info(
      {
        event: "objectInspirationTitleUpdate.done",
        userId,
        summary,
      },
      "Object inspiration bulk title-update complete",
    );

    return { summary, outcomes };
  } catch (err) {
    request.log.error(
      {
        event: "objectInspirationTitleUpdate.failed",
        userId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Object inspiration bulk title-update failed",
    );
    return internalError(
      reply,
      "Failed to bulk update object inspiration titles.",
    );
  }
}

async function updateOneTitle(
  row: ObjectInspirationTitleUpdateInput,
): Promise<SeedOutcome> {
  try {
    await updateObjectInspirationTitleDoc(row.id, row.title);
    return {
      kind: "item",
      id: row.id,
      status: "updated",
      ts: new Date().toISOString(),
    };
  } catch (err) {
    // Doc-missing maps to `failed` (not `skipped`) so the operator sees
    // a non-zero failure count and investigates rather than silently
    // accepting a no-op for a typo'd id.
    const reason =
      err instanceof ObjectInspirationNotFoundError
        ? `inspiration not found: ${row.id} — title-update path does not create new items; use POST /bulk-seed for new rows`
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
