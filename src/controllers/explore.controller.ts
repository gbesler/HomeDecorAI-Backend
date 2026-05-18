import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ID_PATTERN,
  badRequest,
  internalError,
  notFound,
  unauthorized,
  validationError,
} from "../lib/controller-helpers.js";
import {
  InspirationNotFoundError,
  getInspiration,
  inspirationToDTO,
  listInspirations,
  seedInspirationDoc,
} from "../lib/inspiration/firestore.js";
import {
  ExploreQuerySchema,
  InspirationSeedInputSchema,
  InvalidCursorError,
  type InspirationSeedInput,
} from "../lib/inspiration/schemas.js";

/** Bounded concurrency for the per-doc Firestore upserts in bulk-seed.
 *  Matches `seed-explore-inspirations.ts` default ×2 — the historical sweet
 *  spot from object-inspiration bulk runs against 800-item manifests. */
const BULK_SEED_CONCURRENCY = 10;

interface SeedRowIssue {
  id: string;
  message: string;
}

interface SeedOutcome {
  id: string;
  status: "created" | "updated" | "failed";
  reason?: string;
  ts: string;
}

const InspirationIdParams = z.object({
  inspirationId: z.string().regex(ID_PATTERN),
});

export async function listInspirationsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const parsed = ExploreQuerySchema.safeParse(request.query ?? {});
  if (!parsed.success) return validationError(reply, parsed.error);

  try {
    const page = await listInspirations(parsed.data);
    return {
      items: page.items.map(inspirationToDTO),
      nextCursor: page.nextCursor,
    };
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      return badRequest(reply, err.message);
    }
    request.log.error(
      {
        event: "inspiration.list_failed",
        userId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to list inspirations",
    );
    return internalError(reply, "Failed to list inspirations.");
  }
}

export async function getInspirationHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const params = InspirationIdParams.safeParse(request.params);
  if (!params.success) return validationError(reply, params.error);

  try {
    const insp = await getInspiration(params.data.inspirationId);
    return { inspiration: inspirationToDTO(insp) };
  } catch (err) {
    if (err instanceof InspirationNotFoundError)
      return notFound(reply, "Inspiration not found.");
    request.log.error(
      {
        event: "inspiration.get_failed",
        userId,
        inspirationId: params.data.inspirationId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to fetch inspiration",
    );
    return internalError(reply, "Failed to fetch inspiration.");
  }
}

/**
 * Admin upsert for one inspiration envelope. Replaces the offline seed
 * script — the caller hands in a pre-uploaded `imageUrl` (and dimensions)
 * plus taxonomy + optional prompt, and we write the Firestore doc.
 *
 * Auth follows the existing `app.authenticate` pattern (Firebase Bearer
 * token). Tighten with a custom claim or separate admin gate when an
 * external authoring surface ships.
 */
export async function seedInspirationHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const parsed = InspirationSeedInputSchema.safeParse(request.body ?? {});
  if (!parsed.success) return validationError(reply, parsed.error);

  try {
    const result = await seedInspirationDoc(parsed.data);
    if (result.created) {
      reply.code(201);
      // Absolute URI per RFC 9110 / OpenAPI convention. `request.url`
      // is the path portion of the current request (e.g.
      // `/api/explore/inspirations`); strip the query string and a
      // trailing slash, then append the new resource id.
      const basePath = request.url.split("?", 1)[0].replace(/\/$/, "");
      reply.header(
        "Location",
        `${request.protocol}://${request.hostname}${basePath}/${parsed.data.id}`,
      );
    }
    return result;
  } catch (err) {
    // NOTE: Do NOT spread `parsed.data` or `request.body` into this log —
    // `prompt` may contain proprietary prompting strategies and must stay
    // out of structured logs. Add fields explicitly if more context is needed.
    request.log.error(
      {
        event: "inspiration.seed_failed",
        userId,
        inspirationId: parsed.data.id,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to seed inspiration",
    );
    return internalError(reply, "Failed to seed inspiration.");
  }
}

function isBulkSeedShape(body: unknown): body is { items: unknown[] } {
  return (
    !!body &&
    typeof body === "object" &&
    Array.isArray((body as { items?: unknown }).items)
  );
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
      outcomes.push(await worker(inputs[idx] as TInput));
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => take()),
  );
  return outcomes;
}

async function seedOneInspiration(
  row: InspirationSeedInput,
): Promise<SeedOutcome> {
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

/**
 * Bulk-seed handler for Explore inspirations. Accepts `{ items: [...] }`
 * where each item is the same shape `POST /explore/inspirations` accepts.
 *
 * Mirrors `bulkSeedObjectInspirationsHandler` — per-row zod validation up
 * front (rejects the entire batch on any validation issue so the operator
 * fixes the manifest before partial writes happen), then bounded-concurrency
 * Firestore upserts via the same `seedInspirationDoc` helper the single-row
 * route uses. Idempotent on id: re-runs refresh metadata and `updatedAt`
 * without clobbering `createdAt`.
 *
 * Item-phase failures keep the response 200 — operators inspect
 * `summary.failed` + per-row `reason` and re-submit to fill gaps.
 */
export async function bulkSeedInspirationsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) return unauthorized(reply);

  const body = request.body;
  if (!isBulkSeedShape(body)) {
    return badRequest(reply, "Body must be `{ items: array }`.");
  }

  const items: InspirationSeedInput[] = [];
  const issues: SeedRowIssue[] = [];
  for (let i = 0; i < body.items.length; i++) {
    const parsed = InspirationSeedInputSchema.safeParse(body.items[i]);
    if (parsed.success) {
      items.push(parsed.data);
    } else {
      const raw = body.items[i];
      const idHint =
        raw && typeof raw === "object" && raw !== null
          ? (raw as Record<string, unknown>)["id"]
          : undefined;
      issues.push({
        id: typeof idHint === "string" ? idHint : `<row[${i}]>`,
        message: parsed.error.issues
          .map((iss) => `${iss.path.join(".") || "<root>"}: ${iss.message}`)
          .join("; "),
      });
    }
  }

  if (issues.length > 0) {
    reply.code(400);
    return {
      error: "Validation Error",
      message: `Manifest row validation failed (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      issues,
    };
  }

  request.log.info(
    {
      event: "exploreInspirationSeed.start",
      userId,
      itemCount: items.length,
    },
    "Explore inspiration bulk seed starting",
  );

  try {
    const outcomes = await dispatchWithConcurrency(
      items,
      BULK_SEED_CONCURRENCY,
      seedOneInspiration,
    );

    const summary = {
      total: outcomes.length,
      created: 0,
      updated: 0,
      failed: 0,
    };
    for (const o of outcomes) summary[o.status]++;

    request.log.info(
      { event: "exploreInspirationSeed.done", userId, summary },
      "Explore inspiration bulk seed complete",
    );

    return { summary, outcomes };
  } catch (err) {
    // Per-row failures land in `outcomes` via the catch in `seedOneInspiration`,
    // so reaching here means the dispatcher itself blew up (admin SDK init,
    // network teardown). NOTE: do NOT spread `items` or `body` into this log
    // — `prompt` may contain proprietary prompting strategies.
    request.log.error(
      {
        event: "exploreInspirationSeed.failed",
        userId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Explore inspiration bulk seed failed",
    );
    return internalError(reply, "Failed to bulk seed inspirations.");
  }
}
