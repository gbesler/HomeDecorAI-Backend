import { z } from "zod";
import { ID_PATTERN } from "../controller-helpers.js";
import { env } from "../env.js";
import { PathSchema } from "../storage/inspiration-path.js";
import {
  DESIGN_STYLE_VALUES,
  EXPLORE_DEFAULT_LIMIT,
  EXPLORE_MAX_LIMIT,
  INSPIRATION_KIND_VALUES,
  ROOM_TYPE_VALUES,
  TOOL_TYPE_VALUES,
} from "./types.js";

/**
 * Hosts the inspiration seed endpoint accepts in `imageUrl`. The author
 * must upload the image to our own S3 (or the CloudFront distribution
 * fronting it) before submitting the metadata write — arbitrary external
 * URLs would let any admin (or attacker who acquires an admin token)
 * point all iOS clients at attacker-controlled content.
 *
 * Built lazily so unit tests can stub `env` without import-time side
 * effects, and so a future hostname change picks up on the next call
 * without a restart.
 */
function allowedInspirationHosts(): readonly string[] {
  const hosts: string[] = [];
  if (env.AWS_CLOUDFRONT_HOST) {
    hosts.push(env.AWS_CLOUDFRONT_HOST.toLowerCase());
  }
  // Virtual-hosted and path-style S3 hostnames. We expect virtual-hosted
  // in practice (matches how uploaded generation URLs are built), but
  // accept both so authors aren't tripped up by regional vs global form.
  hosts.push(
    `${env.AWS_S3_BUCKET}.s3.amazonaws.com`.toLowerCase(),
    `${env.AWS_S3_BUCKET}.s3.${env.AWS_S3_REGION}.amazonaws.com`.toLowerCase(),
  );
  return hosts;
}

/**
 * Refine an HTTPS URL to one of the allow-listed inspiration hosts.
 * Rejects:
 *  - non-https schemes (`data:`, `javascript:`, `ftp:`, `file:`, ...)
 *  - non-default ports (`https://host:9000/...`) — S3 and CloudFront
 *    don't serve on custom ports, and accepting them would let a caller
 *    store URLs that resolve to broken images on AWS infrastructure.
 *  - hostnames outside the env-configured allow-list
 *
 * Trailing-dot FQDNs (e.g. `bucket.s3.amazonaws.com.`) are normalized
 * to their dot-less form before the allow-list comparison so authors
 * who paste from AWS console (which sometimes emits FQDNs) aren't
 * tripped by an opaque rejection.
 *
 * **Exported** for reuse by `objectInspiration/schemas.ts` — Object
 * inspirations share the same S3 bucket + CloudFront distribution as
 * Explorer inspirations. If a future content type needs a different
 * origin set, parameterize the host source then.
 */
export function isAllowedInspirationUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  // Non-empty port means a non-default port was specified.
  if (parsed.port !== "") return false;
  const normalizedHost = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return allowedInspirationHosts().includes(normalizedHost);
}

/** Zod enum for filter query params (and admin writes). The spread literal
 *  preserves Zod's tuple non-emptiness check that an `as unknown as ...`
 *  cast would silently suppress. */
export const RoomTypeSchema = z.enum([...ROOM_TYPE_VALUES]);
export const DesignStyleSchema = z.enum([...DESIGN_STYLE_VALUES]);
export const ToolTypeSchema = z.enum([...TOOL_TYPE_VALUES]);

// MARK: - Envelope seed (iOS plan 2026-05-12-001)
//
// Body schema for the admin seed endpoint that writes the new `InspirationDoc`
// envelope shape (see `types.ts`). Image upload to S3 is out of scope —
// the caller hands in a pre-uploaded `imageUrl` plus pixel dimensions, and
// the seeder writes the Firestore document.

/** Per-tool taxonomy axes are loose strings on input — the iOS app may ship
 *  a new raw value before this schema's enum catches up. The seeder
 *  preserves them verbatim under `taxonomy.*` in the Firestore envelope. */
const TaxonomyStringSchema = z.string().trim().min(1).max(64).nullable().optional();

/**
 * Body schema for `POST /explore/inspirations` — one inspiration row per
 * request. Mirrors `InspirationSeedInput` (see
 * `src/lib/inspiration/seedShape.ts`). Strict (`.strict()`) so a typo in
 * an envelope field is rejected at the edge rather than silently dropped.
 */
export const InspirationSeedInputSchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    kind: z.enum([...INSPIRATION_KIND_VALUES]).optional(),
    toolType: ToolTypeSchema,
    designStyle: DesignStyleSchema,
    roomType: TaxonomyStringSchema,
    buildingType: TaxonomyStringSchema,
    gardenStyle: TaxonomyStringSchema,
    patioStyle: TaxonomyStringSchema,
    poolStyle: TaxonomyStringSchema,
    outdoorLightingStyle: TaxonomyStringSchema,
    colorPaletteId: TaxonomyStringSchema,
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    featured: z.boolean().optional(),
    path: PathSchema,
    imageWidth: z.number().int().positive().max(20_000),
    imageHeight: z.number().int().positive().max(20_000),
    imageMime: z
      .string()
      .trim()
      .regex(/^image\/[a-z0-9.+-]+$/i, "imageMime must be an image/* MIME type")
      .max(64)
      .optional(),
    prompt: z.string().trim().min(1).max(8000).optional(),
  })
  .strict();

export type InspirationSeedInput = z.infer<typeof InspirationSeedInputSchema>;

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
