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
} from "../lib/inspiration/schemas.js";

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
