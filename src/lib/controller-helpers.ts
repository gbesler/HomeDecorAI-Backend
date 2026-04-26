import type { FastifyReply } from "fastify";
import { z } from "zod";

/** URL-safe path-segment IDs: server-generated UUIDs are 36 chars, but we
 *  accept any URL-safe ID up to 128 chars. The strict regex blocks
 *  path-traversal payloads from reaching the handler even if a route's JSON
 *  Schema is misconfigured. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Standard `{error, message}` envelope shape returned by every controller. */
export interface ErrorEnvelope {
  error: string;
  message: string;
}

export function unauthorized(reply: FastifyReply): ErrorEnvelope {
  reply.code(401);
  return { error: "Unauthorized", message: "Authentication required" };
}

export function validationError(
  reply: FastifyReply,
  err: z.ZodError,
): ErrorEnvelope {
  reply.code(400);
  return {
    error: "Validation Error",
    message: err.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", "),
  };
}

export function notFound(reply: FastifyReply, message: string): ErrorEnvelope {
  reply.code(404);
  return { error: "Not Found", message };
}

export function internalError(
  reply: FastifyReply,
  message = "Internal error.",
): ErrorEnvelope {
  reply.code(500);
  return { error: "Internal Error", message };
}
