import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ID_PATTERN,
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
} from "../lib/inspiration/firestore.js";
import {
  ExploreQuerySchema,
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
      reply.code(400);
      return { error: "Validation Error", message: err.message };
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
