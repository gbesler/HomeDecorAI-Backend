import { z } from "zod";
import {
  DESIGN_STYLE_VALUES,
  EXPLORE_DEFAULT_LIMIT,
  EXPLORE_MAX_LIMIT,
  ROOM_TYPE_VALUES,
  TOOL_TYPE_VALUES,
} from "./types.js";

/** Zod enum for filter query params (and admin writes). The spread literal
 *  preserves Zod's tuple non-emptiness check that an `as unknown as ...`
 *  cast would silently suppress. */
export const RoomTypeSchema = z.enum([...ROOM_TYPE_VALUES]);
export const DesignStyleSchema = z.enum([...DESIGN_STYLE_VALUES]);
export const ToolTypeSchema = z.enum([...TOOL_TYPE_VALUES]);

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** A trimmed, sane URL accepted both for source images and CDN-fronted ones. */
const ImageUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048);

/**
 * Validation of a freshly authored Inspiration document. Used by admin/seed
 * code paths; the iOS client never writes inspirations directly.
 */
export const InspirationWriteSchema = z.object({
  id: z.string().regex(ID_PATTERN).optional(),
  roomType: RoomTypeSchema,
  designStyle: DesignStyleSchema,
  toolType: ToolTypeSchema,
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  imageUrl: ImageUrlSchema,
  cdnUrl: ImageUrlSchema.nullable().optional(),
  featured: z.boolean().default(false),
  sourceGenerationId: z
    .string()
    .regex(ID_PATTERN)
    .nullable()
    .optional(),
});

export type InspirationWriteInput = z.infer<typeof InspirationWriteSchema>;

// MARK: - Cursor
//
// Explore is the only paginated endpoint that survives the favorites
// removal. The cursor encodes (createdAt DESC, __name__ DESC) for stable
// keyset pagination.

export const ExploreCursorPayloadSchema = z.object({
  lastId: z.string().regex(ID_PATTERN),
  lastCreatedAtMs: z.number().int().nonnegative(),
});

export type ExploreCursorPayload = z.infer<typeof ExploreCursorPayloadSchema>;

/** Shared `limit` query-param transform. Kept here (not duplicated in each
 *  controller) so a single edit changes the clamp behaviour everywhere. */
export const LimitSchema = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => {
    if (v === undefined) return EXPLORE_DEFAULT_LIMIT;
    const n = typeof v === "number" ? v : Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) return EXPLORE_DEFAULT_LIMIT;
    return Math.min(Math.trunc(n), EXPLORE_MAX_LIMIT);
  });

/**
 * Query schema for the gallery endpoint. `cursor` and `limit` are pre-coerced
 * because Fastify hands query strings as strings.
 */
export const ExploreQuerySchema = z.object({
  roomType: RoomTypeSchema.optional(),
  designStyle: DesignStyleSchema.optional(),
  toolType: ToolTypeSchema.optional(),
  featuredOnly: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => (v === true || v === "true" ? true : undefined)),
  limit: LimitSchema,
  cursor: z.string().min(1).max(2048).optional(),
});

export type ExploreQuery = z.infer<typeof ExploreQuerySchema>;

// MARK: - Cursor codec helpers

/**
 * Typed error thrown when a caller-supplied cursor cannot be decoded. The
 * controller layer uses an `instanceof` check (not a string-message match)
 * so a future renaming of the error string never silently downgrades the
 * status code from 400 to 500.
 */
export class InvalidCursorError extends Error {
  constructor(message = "Invalid cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export function encodeExploreCursor(payload: ExploreCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeExploreCursor(raw: string): ExploreCursorPayload {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = ExploreCursorPayloadSchema.safeParse(json);
  if (!parsed.success) throw new InvalidCursorError();
  return parsed.data;
}
