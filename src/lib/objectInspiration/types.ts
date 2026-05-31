import type admin from "firebase-admin";

/**
 * Object inspiration domain — Replace Object + Add Object wizard step's
 * dynamic catalog. Two-collection model (`objectCategories` +
 * `objectInspirations`) rather than the Explorer feature's single
 * `inspirations` collection: object items have a fundamentally different
 * shape (categoryId, toolTypes array, single i18n title map) and a
 * different content lifecycle (admin-curated prompt-driven, not
 * AI-generated room photo).
 *
 * Stored at:
 *   `objectCategories/{categoryId}` — 40 categories (sofas, beds, ...)
 *   `objectInspirations/{itemId}`    — ~800 items, categoryId reference
 *
 * Both public-read with server-side `active==true` enforcement in
 * `firestore.rules`; client writes blocked, admin SDK only.
 *
 * iOS reads via two snapshot listeners with client-side join (see plan
 * Unit 5). Listener queries must include `.whereField("active", isEqualTo: true)`
 * so the rules-level read filter does not break the listener with
 * `permission-denied` when an item flips to `active=false`.
 */

/** Allowed tool keys for object inspirations. An item visible only to the
 *  Replace tool ships as `["replaceObject"]`; both tools share an item via
 *  `["replaceObject", "addObject"]`. Migration baseline writes every item
 *  with both — per-tool restriction is a future content-side capability. */
export const OBJECT_TOOL_TYPE_VALUES = ["replaceObject", "addObject"] as const;
export type ObjectToolType = (typeof OBJECT_TOOL_TYPE_VALUES)[number];

export const OBJECT_CATEGORIES_COLLECTION = "objectCategories";
export const OBJECT_INSPIRATIONS_COLLECTION = "objectInspirations";

/**
 * Supported language codes for object-inspiration titles. Kept in sync
 * with iOS `AppLanguage` (HomeDecorAI/Shared/Utilities/LanguageManager.swift).
 *
 * `en` + `tr` are required at the schema level so existing manifests
 * (and the curated seed pipeline) stay valid without a backfill. The
 * other 30 codes are optional: a missing translation degrades on iOS
 * to English via `LocalizedTitle.resolve`. Adding a translation is a
 * Firestore write — no schema bump needed.
 *
 * Adding a NEW language code: append it here, mirror the case in
 * iOS `AppLanguage`, and add the matching `.optional()` field in
 * `LocalizedTitleSchema` (schemas.ts). All three surfaces must stay
 * aligned.
 */
export const REQUIRED_LANGUAGES = ["en", "tr"] as const;

export const OPTIONAL_LANGUAGES = [
  "ar",
  "hy",
  "zh-Hans",
  "zh-Hant",
  "hr",
  "cs",
  "da",
  "nl",
  "fi",
  "fr",
  "de",
  "el",
  "he",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "ms",
  "nb",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "es",
  "sv",
  "th",
  "uk",
  "vi",
] as const;

export const SUPPORTED_LANGUAGES = [
  ...REQUIRED_LANGUAGES,
  ...OPTIONAL_LANGUAGES,
] as const;

export type RequiredLanguage = (typeof REQUIRED_LANGUAGES)[number];
export type OptionalLanguage = (typeof OPTIONAL_LANGUAGES)[number];
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Localized title map. Lookup order on iOS: requested locale → en → tr
 * → first non-empty. `en` and `tr` are required; the 30 other
 * supported languages are optional and absent on legacy documents.
 *
 * Adding a new translation is a Firestore write, not a schema change.
 * Adding a new LANGUAGE (i.e. a new code) is a 3-surface change — see
 * `OPTIONAL_LANGUAGES` above.
 */
export type LocalizedTitle = {
  en: string;
  tr: string;
} & Partial<Record<OptionalLanguage, string>>;

/**
 * Localized alternate-search terms map. Used by the iOS search matcher
 * as a third literal-weight token channel alongside the item title and
 * the parent category title, so a TR user typing `"kanepe"` matches
 * Koltuk items whose title noun does not contain that word.
 *
 * Covers the same 32 `SUPPORTED_LANGUAGES` as `LocalizedTitle`. Every
 * language is independently optional: an item supplies alternate
 * vocabulary only for the locales where it adds value, and the iOS
 * index iterates whatever keys are present. Unlike `LocalizedTitle`
 * (which requires every language), searchTerms stays opt-in per
 * language because alternate-search synonyms are not equally
 * meaningful in every locale.
 *
 * Merge-field caveat: `searchTerms` is a propagated merge field, so a
 * re-seed replaces the entire stored map — omitting a language on
 * re-seed clears it. See `copySearchTerms` in seedShape.ts.
 */
export type LocalizedSearchTerms = Partial<Record<SupportedLanguage, string[]>>;

/**
 * Firestore document at `objectCategories/{categoryId}`. The category
 * grid (40 tiles) is the entry surface of the wizard step; `heroImageUrl`
 * is its primary visual signal — the migration plan calls out Phase 2
 * content scope must include 40 hero images.
 */
export interface ObjectInspirationCategoryDoc {
  /** Bump on breaking shape changes. Today's value is `1`. */
  schemaVersion: number;
  /** Stable slug, lowercased; matches the doc id and is repeated in the
   *  data block so client reads do not need separate id ↔ data wiring. */
  id: string;
  /** Manual display order; admin-controlled. Lower renders earlier. */
  order: number;
  /** Soft-delete / draft flag. `false` hides the category client-side AND
   *  blocks reads via `firestore.rules`. */
  active: boolean;
  title: LocalizedTitle;
  heroImageUrl: string;
  heroImageWidth: number;
  heroImageHeight: number;
  heroImageMime: string;
  /** Which wizard tools may surface this category. See
   *  `OBJECT_TOOL_TYPE_VALUES`. */
  toolTypes: ObjectToolType[];
  createdAt: admin.firestore.Timestamp;
  updatedAt: admin.firestore.Timestamp;
}

/**
 * Firestore document at `objectInspirations/{itemId}`. `categoryId` is a
 * soft foreign key — orphan items (categoryId set has no matching category)
 * are dropped client-side at join time with a warning log.
 *
 * `prompt` is admin-authored and flows into the AI generation pipeline at
 * submit time. Backend AI endpoint re-validates `active=true` on submit
 * and returns `409 content_unavailable` if the item was deactivated after
 * the user selected it; this closes the moderation gap that would
 * otherwise let deactivated content reach the model.
 */
export interface ObjectInspirationItemDoc {
  schemaVersion: number;
  /** Item slug matching the doc id. Regex `^[a-z][a-zA-Z]*_[0-9]+$`. */
  id: string;
  /** Soft FK to `objectCategories/{categoryId}`. */
  categoryId: string;
  order: number;
  active: boolean;
  title: LocalizedTitle;
  /** Generation prompt. Min 1 char (quality, not security — admin claim is
   *  the trust gate). Max 500 char. */
  prompt: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  imageMime: string;
  toolTypes: ObjectToolType[];
  /**
   * Optional alternate-search vocabulary. Omitted on legacy items; the
   * iOS matcher falls back to title-only matching when absent. See
   * `LocalizedSearchTerms` for shape semantics.
   */
  searchTerms?: LocalizedSearchTerms;
  createdAt: admin.firestore.Timestamp;
  updatedAt: admin.firestore.Timestamp;
}

/** Wire-format DTOs returned by any future REST GET endpoints (the plan
 *  scopes GET out-of-scope today — iOS reads Firestore directly — but the
 *  DTO shape is published for admin/CI tooling). */
export interface ObjectInspirationCategoryDTO
  extends Omit<ObjectInspirationCategoryDoc, "createdAt" | "updatedAt"> {
  createdAt: string;
  updatedAt: string;
}

export interface ObjectInspirationItemDTO
  extends Omit<ObjectInspirationItemDoc, "createdAt" | "updatedAt"> {
  createdAt: string;
  updatedAt: string;
}
