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

/** Localized title map. Lookup order on iOS: requested locale → en → first
 *  non-empty. Adding a new language is a write, not a schema change. */
export interface LocalizedTitle {
  en: string;
  tr: string;
}

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
