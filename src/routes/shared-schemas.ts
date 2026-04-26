/** Shared Fastify JSON schemas reused across multiple route plugins. Keep
 *  this file allocation-friendly — every value here is a plain object literal
 *  that Fastify can register without runtime cost. */

export const idPattern = "^[A-Za-z0-9_-]{1,128}$";

export const errorResponse = {
  type: "object" as const,
  properties: {
    error: { type: "string" as const },
    message: { type: "string" as const },
  },
  required: ["error", "message"] as const,
};

/** JSON Schema for `InspirationDTO` — used in both `/api/explore/...` and
 *  `/api/favorite-inspirations/...` route response bodies. Keep field order +
 *  `required` array exactly in lockstep with `InspirationDTO` in
 *  `src/lib/inspiration/types.ts`. */
export const inspirationSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" as const },
    roomType: { type: "string" as const },
    designStyle: { type: "string" as const },
    toolType: { type: "string" as const },
    tags: { type: "array" as const, items: { type: "string" as const } },
    imageUrl: { type: "string" as const, format: "uri" },
    cdnUrl: { type: ["string", "null"] as const },
    featured: { type: "boolean" as const },
    sourceGenerationId: { type: ["string", "null"] as const },
    createdAt: { type: "string" as const, format: "date-time" },
  },
  required: [
    "id",
    "roomType",
    "designStyle",
    "toolType",
    "tags",
    "imageUrl",
    "cdnUrl",
    "featured",
    "sourceGenerationId",
    "createdAt",
  ] as const,
};
