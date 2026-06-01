import admin from "firebase-admin";
import { isTimestamp } from "../firestore-utils.js";
import {
  planObjectCategorySeedWrite,
  planObjectInspirationSeedWrite,
  type SeedMode,
} from "./seedShape.js";
import type {
  ObjectCategorySeedInput,
  ObjectInspirationSeedInput,
} from "./schemas.js";
import {
  OBJECT_CATEGORIES_COLLECTION,
  OBJECT_INSPIRATIONS_COLLECTION,
  OPTIONAL_LANGUAGES,
  REQUIRED_LANGUAGES,
  type LocalizedSearchTerms,
  type LocalizedTitle,
  type ObjectInspirationCategoryDoc,
  type ObjectInspirationCategoryDTO,
  type ObjectInspirationItemDoc,
  type ObjectInspirationItemDTO,
  type ObjectToolType,
  type RequiredLanguage,
} from "./types.js";

function getFirestore(): admin.firestore.Firestore {
  return admin.firestore();
}

function categoriesRef() {
  return getFirestore().collection(OBJECT_CATEGORIES_COLLECTION);
}

function inspirationsRef() {
  return getFirestore().collection(OBJECT_INSPIRATIONS_COLLECTION);
}

export class ObjectCategoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Object category not found: ${id}`);
    this.name = "ObjectCategoryNotFoundError";
  }
}

export class ObjectInspirationNotFoundError extends Error {
  constructor(id: string) {
    super(`Object inspiration not found: ${id}`);
    this.name = "ObjectInspirationNotFoundError";
  }
}

// MARK: - Decoders

const EMPTY_TITLE: LocalizedTitle = { en: "", tr: "" };
const EPOCH = admin.firestore.Timestamp.fromMillis(0);

/**
 * Decode a Firestore `title` map. Required `en` + `tr` fields always
 * surface (empty string fallback so the iOS resolve chain always has a
 * terminal). Each optional language code is included only when the doc
 * actually carries a non-empty translation, so callers can use a
 * presence check (`title["de"] !== undefined`) as a proxy for "this
 * translation exists". Unknown keys (typos, retired locales) are
 * dropped silently — defense against a stale field leaking into the
 * UI.
 */
function decodeTitle(raw: unknown): LocalizedTitle {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...EMPTY_TITLE };
  }
  const obj = raw as Record<string, unknown>;
  const title: LocalizedTitle = {
    en: typeof obj["en"] === "string" ? obj["en"] : "",
    tr: typeof obj["tr"] === "string" ? obj["tr"] : "",
  };
  for (const code of OPTIONAL_LANGUAGES) {
    const value = obj[code];
    if (typeof value === "string" && value.length > 0) {
      title[code] = value;
    }
  }
  return title;
}

function decodeToolTypes(raw: unknown): ObjectToolType[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (v): v is ObjectToolType =>
      typeof v === "string" && (v === "replaceObject" || v === "addObject"),
  );
}

/**
 * Decode a Firestore `searchTerms` map. Returns `undefined` when the
 * field is absent OR when every language array is empty / malformed
 * — that way legacy items (no field) and the boundary case of an
 * empty payload both surface as "no alternate terms" downstream.
 *
 * Defensive filtering mirrors `decodeTitle`'s style: non-string array
 * entries and whitespace-only strings are dropped silently. The trim
 * predicate (`v.trim().length > 0`) matches the seed-time Zod check
 * (`z.string().trim().min(1)`) so a doc written via a non-seed path
 * (direct admin SDK call, future migration) cannot smuggle stale or
 * malformed entries into the iOS index.
 */
function decodeSearchTerms(raw: unknown): LocalizedSearchTerms | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: LocalizedSearchTerms = {};
  // Iterating REQUIRED_LANGUAGES (`en`, `tr`) instead of hardcoded
  // string literals so a future required-language addition (a single
  // edit in types.ts) propagates here automatically — matches the
  // pattern decodeTitle uses for OPTIONAL_LANGUAGES.
  for (const code of REQUIRED_LANGUAGES) {
    const raw = obj[code];
    if (!Array.isArray(raw)) continue;
    const filtered = raw.filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    if (filtered.length > 0) {
      (out as Record<RequiredLanguage, string[]>)[code] = filtered;
    }
  }
  if (out.en === undefined && out.tr === undefined) return undefined;
  return out;
}

export function mapDocToObjectCategory(
  doc:
    | FirebaseFirestore.QueryDocumentSnapshot
    | FirebaseFirestore.DocumentSnapshot,
): ObjectInspirationCategoryDoc {
  const data = doc.data() ?? {};
  return {
    schemaVersion:
      typeof data["schemaVersion"] === "number" ? data["schemaVersion"] : 1,
    id: doc.id,
    order: typeof data["order"] === "number" ? data["order"] : 0,
    active: data["active"] === true,
    title: decodeTitle(data["title"]),
    path: typeof data["path"] === "string" ? data["path"] : "",
    heroImageWidth:
      typeof data["heroImageWidth"] === "number" ? data["heroImageWidth"] : 0,
    heroImageHeight:
      typeof data["heroImageHeight"] === "number"
        ? data["heroImageHeight"]
        : 0,
    heroImageMime:
      typeof data["heroImageMime"] === "string"
        ? data["heroImageMime"]
        : "image/jpeg",
    toolTypes: decodeToolTypes(data["toolTypes"]),
    createdAt: isTimestamp(data["createdAt"]) ? data["createdAt"] : EPOCH,
    updatedAt: isTimestamp(data["updatedAt"]) ? data["updatedAt"] : EPOCH,
  };
}

export function mapDocToObjectInspiration(
  doc:
    | FirebaseFirestore.QueryDocumentSnapshot
    | FirebaseFirestore.DocumentSnapshot,
): ObjectInspirationItemDoc {
  const data = doc.data() ?? {};
  const result: ObjectInspirationItemDoc = {
    schemaVersion:
      typeof data["schemaVersion"] === "number" ? data["schemaVersion"] : 1,
    id: doc.id,
    categoryId:
      typeof data["categoryId"] === "string" ? data["categoryId"] : "",
    order: typeof data["order"] === "number" ? data["order"] : 0,
    active: data["active"] === true,
    title: decodeTitle(data["title"]),
    prompt: typeof data["prompt"] === "string" ? data["prompt"] : "",
    path: typeof data["path"] === "string" ? data["path"] : "",
    imageWidth:
      typeof data["imageWidth"] === "number" ? data["imageWidth"] : 0,
    imageHeight:
      typeof data["imageHeight"] === "number" ? data["imageHeight"] : 0,
    imageMime:
      typeof data["imageMime"] === "string"
        ? data["imageMime"]
        : "image/jpeg",
    toolTypes: decodeToolTypes(data["toolTypes"]),
    createdAt: isTimestamp(data["createdAt"]) ? data["createdAt"] : EPOCH,
    updatedAt: isTimestamp(data["updatedAt"]) ? data["updatedAt"] : EPOCH,
  };
  const searchTerms = decodeSearchTerms(data["searchTerms"]);
  if (searchTerms) result.searchTerms = searchTerms;
  return result;
}

export function objectCategoryToDTO(
  doc: ObjectInspirationCategoryDoc,
): ObjectInspirationCategoryDTO {
  return {
    ...doc,
    createdAt: doc.createdAt.toDate().toISOString(),
    updatedAt: doc.updatedAt.toDate().toISOString(),
  };
}

export function objectInspirationToDTO(
  doc: ObjectInspirationItemDoc,
): ObjectInspirationItemDTO {
  return {
    ...doc,
    createdAt: doc.createdAt.toDate().toISOString(),
    updatedAt: doc.updatedAt.toDate().toISOString(),
  };
}

// MARK: - Reads

export async function getObjectCategory(
  id: string,
): Promise<ObjectInspirationCategoryDoc> {
  const snap = await categoriesRef().doc(id).get();
  if (!snap.exists) throw new ObjectCategoryNotFoundError(id);
  return mapDocToObjectCategory(snap);
}

export async function getObjectInspiration(
  id: string,
): Promise<ObjectInspirationItemDoc> {
  const snap = await inspirationsRef().doc(id).get();
  if (!snap.exists) throw new ObjectInspirationNotFoundError(id);
  return mapDocToObjectInspiration(snap);
}

/**
 * Server-side `active=true` re-validate used by the AI generation
 * endpoint. Returns `null` when the inspiration is missing or inactive —
 * the controller maps this to `409 content_unavailable`, which iOS turns
 * into the "item no longer available" wizard state. This is the
 * moderation gate that closes the deactivated-content-reaches-AI gap.
 */
export async function getActiveObjectInspirationOrNull(
  id: string,
): Promise<ObjectInspirationItemDoc | null> {
  const snap = await inspirationsRef().doc(id).get();
  if (!snap.exists) return null;
  const item = mapDocToObjectInspiration(snap);
  return item.active ? item : null;
}

/**
 * Existence check for a batch of category ids — returns the subset that
 * exists in Firestore. Used by the bulk-seed FK fallback when an item
 * references a categoryId that wasn't inlined in the submitted
 * `categories` array (partial-manifest workflow).
 *
 * Chunked at 30 to stay under Firestore's `in` query limit. For the
 * documented design ceiling (40 categories) this is a single round
 * trip; the chunking only kicks in if a future expansion grows the
 * catalog past 30 distinct categories per request.
 */
export async function getExistingObjectCategoryIds(
  ids: readonly string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  if (ids.length === 0) return existing;
  const chunkSize = 30;
  const documentId = admin.firestore.FieldPath.documentId();
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const snap = await categoriesRef()
      .where(documentId, "in", chunk)
      .select() // metadata-only, no doc body
      .get();
    for (const doc of snap.docs) existing.add(doc.id);
  }
  return existing;
}

// MARK: - Writes

export interface SeedObjectCategoryResult {
  id: string;
  created: boolean;
}

export interface SeedObjectInspirationResult {
  id: string;
  created: boolean;
  mode: SeedMode;
}

/**
 * Transactional upsert at `objectCategories/{row.id}`. Mirrors the
 * Explorer pattern: read-then-write inside `runTransaction` so concurrent
 * upserts cannot both observe `exists: false` and clobber `createdAt`.
 */
export async function seedObjectCategoryDoc(
  row: ObjectCategorySeedInput,
): Promise<SeedObjectCategoryResult> {
  const firestore = getFirestore();
  const docRef = categoriesRef().doc(row.id);

  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const plan = planObjectCategorySeedWrite(row, { exists: snap.exists });
    const now = admin.firestore.FieldValue.serverTimestamp();

    if (plan.mergeFields === null) {
      tx.set(docRef, { ...plan.data, createdAt: now, updatedAt: now });
    } else {
      tx.set(
        docRef,
        { ...plan.data, updatedAt: now },
        { mergeFields: [...plan.mergeFields] },
      );
    }

    return { id: row.id, created: plan.created };
  });
}

/**
 * Transactional upsert at `objectInspirations/{row.id}`. `mode` drives the
 * prompt-preservation rule:
 *   - `"default"` (POST without `X-Seed-Mode: overwrite`) preserves any
 *     existing prompt on re-seed.
 *   - `"overwrite"` (POST with `X-Seed-Mode: overwrite`, only sent by the
 *     bulk seed script in `--overwrite-prompts` mode) overwrites the
 *     prompt. Audit log captured at the controller layer, not here.
 */
export async function seedObjectInspirationDoc(
  row: ObjectInspirationSeedInput,
  mode: SeedMode = "default",
): Promise<SeedObjectInspirationResult> {
  const firestore = getFirestore();
  const docRef = inspirationsRef().doc(row.id);

  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const plan = planObjectInspirationSeedWrite(
      row,
      { exists: snap.exists },
      mode,
    );
    const now = admin.firestore.FieldValue.serverTimestamp();

    if (plan.mergeFields === null) {
      tx.set(docRef, { ...plan.data, createdAt: now, updatedAt: now });
    } else {
      tx.set(
        docRef,
        { ...plan.data, updatedAt: now },
        { mergeFields: [...plan.mergeFields] },
      );
    }

    return { id: row.id, created: plan.created, mode };
  });
}

/**
 * Whitelisted partial update — used by `PATCH /api/object-inspirations/:id`.
 * Body schema (in `schemas.ts`) restricts callers to `active` + `order`.
 * Other fields must go through the POST upsert path so allow-list +
 * full validation apply.
 */
export interface PatchObjectInspirationFields {
  active?: boolean;
  order?: number;
}

export async function patchObjectInspirationDoc(
  id: string,
  fields: PatchObjectInspirationFields,
): Promise<void> {
  const docRef = inspirationsRef().doc(id);
  const snap = await docRef.get();
  if (!snap.exists) throw new ObjectInspirationNotFoundError(id);

  const update: Record<string, unknown> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (typeof fields.active === "boolean") update["active"] = fields.active;
  if (typeof fields.order === "number") update["order"] = fields.order;

  await docRef.update(update);
}

/**
 * Title-only update — used by the bulk title-correction ops path
 * (`POST /api/object-inspirations/bulk-update-titles` and the
 * `update-object-inspiration-titles.ts` script). Errors when the doc
 * is missing rather than upserting: callers who want to create new
 * items must go through the full POST upsert path so the allow-list +
 * full validation apply.
 *
 * Writes only `title` and `updatedAt`. `createdAt`, `prompt`, image
 * fields, etc. stay untouched.
 */
export async function updateObjectInspirationTitleDoc(
  id: string,
  title: LocalizedTitle,
): Promise<void> {
  const docRef = inspirationsRef().doc(id);
  const snap = await docRef.get();
  if (!snap.exists) throw new ObjectInspirationNotFoundError(id);

  // Whole-title replacement so omitted optional locales fall back to
  // unset on the doc — callers must include every translation they
  // want preserved. Matches the zod schema's `.strict()` semantics
  // upstream: there is one canonical `title` value, not a partial
  // patch surface.
  await docRef.update({
    title: { ...title },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Hard delete — used by `DELETE /api/object-inspirations/:id`. Soft
 * deletion goes through `patchObjectInspirationDoc({ active: false })`.
 * Caller is responsible for the `Confirm: true` header UX hurdle + admin
 * claim middleware check.
 */
export async function deleteObjectInspirationDoc(id: string): Promise<void> {
  const docRef = inspirationsRef().doc(id);
  const snap = await docRef.get();
  if (!snap.exists) throw new ObjectInspirationNotFoundError(id);
  await docRef.delete();
}
