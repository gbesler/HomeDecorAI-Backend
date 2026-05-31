import { z } from "zod";
import {
  isAllowedInspirationUrl,
  // Re-using the Explorer allow-list because object inspirations share the
  // same S3 bucket + CloudFront distribution; if a future content type
  // needs a different origin, parameterize the host source then.
} from "../inspiration/schemas.js";
import {
  OBJECT_TOOL_TYPE_VALUES,
  type ObjectToolType,
} from "./types.js";

/**
 * Schema-level decisions captured from the plan:
 *   • `prompt` min 1 / max 500 — min is a *quality* lower bound, not a
 *     security defense. The admin custom claim middleware is the trust
 *     boundary; any prompt accepted here was authored by an admin.
 *   • `id` regex tracks the iOS-side ID parity contract. Item ids look
 *     like `sofas_1`, `outdoorSeating_12`. Category ids are bare slugs:
 *     `sofas`, `outdoorSeating`. Both lowercase-leading + camelCase tail.
 *   • `imageUrl` and `heroImageUrl` are refined through the Explorer
 *     `isAllowedInspirationUrl` allow-list (exact hostname match against
 *     env-configured CloudFront / S3 bucket; subdomain takeover surface
 *     closed).
 *   • `toolTypes` is non-empty (the spread literal preserves Zod's tuple
 *     non-emptiness check) so an admin cannot ship a row hidden from
 *     both tools by mistake.
 *   • `title.en` / `title.tr` both required + trimmed + min 1. The 30
 *     other supported language codes (see `OPTIONAL_LANGUAGES` in
 *     types.ts) are optional, also trim+min-1 when present so an
 *     accidentally-empty translation row is rejected at the edge — a
 *     silently-empty `de` masquerading as a German title is the
 *     concrete failure mode this prevents. The iOS-side fallback
 *     chain (requested → en → tr → first non-empty) still applies if
 *     a translation is omitted entirely.
 */

const ObjectCategoryIdSchema = z
  .string()
  .regex(/^[a-z][a-zA-Z]*$/, "category id must be lowerCamelCase slug");

const ObjectItemIdSchema = z
  .string()
  .regex(
    /^[a-z][a-zA-Z]*_[0-9]+$/,
    "item id must be `<categoryId>_<index>` (e.g. sofas_1)",
  );

const TitleStringSchema = z.string().trim().min(1).max(120);
const OptionalTitleStringSchema = TitleStringSchema.optional();

/**
 * `en` + `tr` are required; the 30 other languages from
 * `OPTIONAL_LANGUAGES` are optional but, when present, must be
 * non-empty (TitleStringSchema applies `trim().min(1)`). `.strict()`
 * so an unknown locale code (typo, retired locale) is rejected at the
 * edge — adding a new language is an explicit schema bump in
 * types.ts + this file + iOS `AppLanguage`. The 30 optional fields
 * are listed explicitly so zod's `.infer` carries each into
 * `LocalizedTitle`.
 */
const LocalizedTitleSchema = z
  .object({
    en: TitleStringSchema,
    tr: TitleStringSchema,
    ar: OptionalTitleStringSchema,
    hy: OptionalTitleStringSchema,
    "zh-Hans": OptionalTitleStringSchema,
    "zh-Hant": OptionalTitleStringSchema,
    hr: OptionalTitleStringSchema,
    cs: OptionalTitleStringSchema,
    da: OptionalTitleStringSchema,
    nl: OptionalTitleStringSchema,
    fi: OptionalTitleStringSchema,
    fr: OptionalTitleStringSchema,
    de: OptionalTitleStringSchema,
    el: OptionalTitleStringSchema,
    he: OptionalTitleStringSchema,
    hu: OptionalTitleStringSchema,
    id: OptionalTitleStringSchema,
    it: OptionalTitleStringSchema,
    ja: OptionalTitleStringSchema,
    ko: OptionalTitleStringSchema,
    ms: OptionalTitleStringSchema,
    nb: OptionalTitleStringSchema,
    pl: OptionalTitleStringSchema,
    pt: OptionalTitleStringSchema,
    ro: OptionalTitleStringSchema,
    ru: OptionalTitleStringSchema,
    sk: OptionalTitleStringSchema,
    es: OptionalTitleStringSchema,
    sv: OptionalTitleStringSchema,
    th: OptionalTitleStringSchema,
    uk: OptionalTitleStringSchema,
    vi: OptionalTitleStringSchema,
  })
  .strict();

const ToolTypesSchema = z
  .array(z.enum([...OBJECT_TOOL_TYPE_VALUES]))
  .min(1)
  .max(OBJECT_TOOL_TYPE_VALUES.length);

/**
 * Per-language alternate-search vocabulary. Feeds the iOS matcher's
 * literal-weight searchTerms channel.
 *
 * Covers the same 32 `SUPPORTED_LANGUAGES` as `LocalizedTitleSchema`.
 * **Every language is independently `.optional()`** — an item supplies
 * alternate terms only for the locales where they add value (synonym
 * usefulness varies widely across locales, so unlike titles we do not
 * force all 32). Per-language array rules: each term `trim().min(1)`,
 * `max(40)` chars; `max(10)` terms per language. `.strict()` so an
 * unknown locale code (typo, retired locale) is rejected at the edge —
 * adding a language is a schema bump in types.ts + this file + iOS
 * `AppLanguage`, mirroring the title contract.
 *
 * Merge-field caveat: `searchTerms` is in the merge-field write list,
 * so Firestore's `set(..., {mergeFields})` replaces the entire map. A
 * re-seed that omits a language clears it on the doc — write the
 * language (even as `[]`) to make the clear-vs-preserve intent
 * explicit. The seedShape projection drops empty/absent arrays so
 * `undefined` and an all-empty map round-trip identical at rest.
 *
 * The outer object stays `.optional()` so an item without any
 * alternate vocabulary continues to omit the field entirely
 * (backward-compatible with legacy items). The 32 fields are listed
 * explicitly so zod's `.infer` carries each into `LocalizedSearchTerms`.
 */
const SearchTermArraySchema = z.array(z.string().trim().min(1).max(40)).max(10);
const OptionalSearchTermArraySchema = SearchTermArraySchema.optional();

const SearchTermsSchema = z
  .object({
    en: OptionalSearchTermArraySchema,
    tr: OptionalSearchTermArraySchema,
    ar: OptionalSearchTermArraySchema,
    hy: OptionalSearchTermArraySchema,
    "zh-Hans": OptionalSearchTermArraySchema,
    "zh-Hant": OptionalSearchTermArraySchema,
    hr: OptionalSearchTermArraySchema,
    cs: OptionalSearchTermArraySchema,
    da: OptionalSearchTermArraySchema,
    nl: OptionalSearchTermArraySchema,
    fi: OptionalSearchTermArraySchema,
    fr: OptionalSearchTermArraySchema,
    de: OptionalSearchTermArraySchema,
    el: OptionalSearchTermArraySchema,
    he: OptionalSearchTermArraySchema,
    hu: OptionalSearchTermArraySchema,
    id: OptionalSearchTermArraySchema,
    it: OptionalSearchTermArraySchema,
    ja: OptionalSearchTermArraySchema,
    ko: OptionalSearchTermArraySchema,
    ms: OptionalSearchTermArraySchema,
    nb: OptionalSearchTermArraySchema,
    pl: OptionalSearchTermArraySchema,
    pt: OptionalSearchTermArraySchema,
    ro: OptionalSearchTermArraySchema,
    ru: OptionalSearchTermArraySchema,
    sk: OptionalSearchTermArraySchema,
    es: OptionalSearchTermArraySchema,
    sv: OptionalSearchTermArraySchema,
    th: OptionalSearchTermArraySchema,
    uk: OptionalSearchTermArraySchema,
    vi: OptionalSearchTermArraySchema,
  })
  .strict()
  .optional();

const ImageUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine(isAllowedInspirationUrl, {
    message:
      "imageUrl host is not allowed. Upload the image to the configured S3 bucket (or its CloudFront distribution) first.",
  });

const ImageMimeSchema = z
  .string()
  .trim()
  .regex(/^image\/[a-z0-9.+-]+$/i, "imageMime must be an image/* MIME type")
  .max(64);

/**
 * Body schema for `POST /api/object-categories`. Strict — typo in a field
 * is rejected at the edge rather than silently merged.
 */
export const ObjectCategorySeedInputSchema = z
  .object({
    id: ObjectCategoryIdSchema,
    order: z.number().int().min(0).max(10_000),
    active: z.boolean().optional().default(true),
    title: LocalizedTitleSchema,
    heroImageUrl: ImageUrlSchema,
    heroImageWidth: z.number().int().positive().max(20_000),
    heroImageHeight: z.number().int().positive().max(20_000),
    heroImageMime: ImageMimeSchema.optional(),
    toolTypes: ToolTypesSchema,
  })
  .strict();

export type ObjectCategorySeedInput = z.infer<
  typeof ObjectCategorySeedInputSchema
>;

/**
 * Body schema for `POST /api/object-inspirations`. The plan removed the
 * `force` body flag in favor of `X-Seed-Mode: overwrite` header — that
 * branching happens in the controller, not the body schema.
 */
export const ObjectInspirationSeedInputSchema = z
  .object({
    id: ObjectItemIdSchema,
    categoryId: ObjectCategoryIdSchema,
    order: z.number().int().min(0).max(10_000),
    active: z.boolean().optional().default(true),
    title: LocalizedTitleSchema,
    prompt: z.string().trim().min(1).max(500),
    imageUrl: ImageUrlSchema,
    imageWidth: z.number().int().positive().max(20_000),
    imageHeight: z.number().int().positive().max(20_000),
    imageMime: ImageMimeSchema.optional(),
    toolTypes: ToolTypesSchema,
    searchTerms: SearchTermsSchema,
  })
  .strict();

export type ObjectInspirationSeedInput = z.infer<
  typeof ObjectInspirationSeedInputSchema
>;

/**
 * Body schema for `PATCH /api/object-inspirations/:id`. Whitelist enforced
 * by `.strict()` — any field outside `active`/`order` is rejected (mass
 * assignment defense). PATCH targets only the operational mutability
 * surface; image/prompt/title changes must go through the full POST
 * upsert path so server-side allow-list + audit semantics apply.
 */
export const ObjectInspirationPatchSchema = z
  .object({
    active: z.boolean().optional(),
    order: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine(
    (v) => v.active !== undefined || v.order !== undefined,
    "PATCH body must include at least one whitelisted field (active, order).",
  );

export type ObjectInspirationPatch = z.infer<typeof ObjectInspirationPatchSchema>;

/**
 * Body row schema for the bulk title-update path. Strict so a caller
 * cannot smuggle other fields (prompt/imageUrl/etc.) through this
 * narrow ops surface — those still belong on the full POST upsert
 * path with the allow-list + audit semantics. The handler enforces
 * "doc must already exist" so this path can never create new items.
 */
export const ObjectInspirationTitleUpdateInputSchema = z
  .object({
    id: ObjectItemIdSchema,
    title: LocalizedTitleSchema,
  })
  .strict();

export type ObjectInspirationTitleUpdateInput = z.infer<
  typeof ObjectInspirationTitleUpdateInputSchema
>;

/**
 * Header schema for `POST /api/object-inspirations` overwrite mode.
 * The bulk seed script sends `X-Seed-Mode: overwrite` when invoked with
 * `--overwrite-prompts`; absence (or any other value) keeps prompt
 * preservation semantics.
 */
export type SeedMode = "default" | "overwrite";

export function parseSeedMode(headerValue: unknown): SeedMode {
  return typeof headerValue === "string" && headerValue.toLowerCase() === "overwrite"
    ? "overwrite"
    : "default";
}

/** Re-export the array literal so callers don't import deep paths just to
 *  check membership at boundaries. */
export { OBJECT_TOOL_TYPE_VALUES };
export type { ObjectToolType };
