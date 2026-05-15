# Object Inspirations HTTP Seed Route — Requirements

**Date:** 2026-05-15
**Status:** Ready for planning

## Problem

Object inspirations (furniture catalog — sofas, chairs, etc.) currently have **no HTTP write surface**. The only write path is `scripts/seed-object-inspirations.ts`, which requires:

- Firebase service account JSON on disk
- `GOOGLE_APPLICATION_CREDENTIALS` env var (or `--service-account` flag)
- Full backend env validation pass (`FIREBASE_SERVICE_ACCOUNT_KEY` base64, AWS keys, FAL_AI_API_KEY, etc.)

This blocks ad-hoc seeding from Postman/curl during development and content iteration. A 40 × 20 = 800-item manifest exists at `scripts/manifests/object-inspirations.full.json` and is ready to seed.

The Explorer module already exposes a parallel HTTP seed pattern at `POST /api/explore/inspirations` (single-record). Object inspirations should expose a comparable HTTP path so the operational ergonomics line up.

## Goal

Add an HTTP endpoint that accepts the **existing manifest format** (`{ categories: [...], items: [...] }`) and writes both categories and items to Firestore using the same validation, ordering, and idempotency semantics as the seed script.

## Out of scope

- Per-record `POST /api/object-categories` / `POST /api/object-inspirations` endpoints (not currently needed — no iOS or admin-panel caller; YAGNI)
- PATCH/DELETE endpoints (mutability surface stays script-only)
- Admin custom claim gating (Explorer pattern uses plain Firebase auth; matching that keeps consistency; tighten later if abuse appears)
- Async job pattern (the script's synchronous bounded-concurrency pattern fits 800 docs within Fastify timeout budget; revisit only if catalogs grow past ~5k items)

## Endpoint shape

**Path:** `POST /api/object-inspirations/bulk-seed`

**Auth:** `app.authenticate` (Firebase Bearer token) — same as Explorer seed

**Rate limit:** New `objectInspirationSeedLimit` pre-handler, tight ceiling matching `exploreSeedLimit`

**Headers:**
- `X-Seed-Mode: overwrite` (optional) — when present, replaces existing prompts on re-seed; absent/any-other-value preserves existing prompts (matches `--overwrite-prompts` script flag)

**Body:** identical to the manifest format already validated by the seed script:

```json
{
  "categories": [ /* ObjectCategorySeedInput[] */ ],
  "items":      [ /* ObjectInspirationSeedInput[] */ ]
}
```

Reuse existing zod schemas in `src/lib/objectInspiration/schemas.ts` (`ObjectCategorySeedInputSchema`, `ObjectInspirationSeedInputSchema`). No new schemas needed.

**Validation order** (mirrors the script):
1. Parse each row through zod (collect all errors before short-circuiting)
2. FK pre-flight: every `item.categoryId` must appear in the submitted categories
3. Write categories (fail-fast if any category insert fails)
4. Write items with bounded concurrency (10); item-phase failures are reported but do not abort siblings (idempotent upsert makes a re-submit safe)

## Response

**Success (200):**
```json
{
  "summary": { "total": 840, "created": 840, "updated": 0, "failed": 0 },
  "outcomes": [
    { "kind": "category", "id": "sofas", "status": "created", "ts": "..." },
    { "kind": "item",     "id": "sofas_1", "status": "created", "ts": "..." }
  ]
}
```

**Validation error (400):**
```json
{ "error": "Bad Request", "message": "...", "issues": [{ "kind": "category|item", "id": "...", "errors": ["..."] }] }
```

**Partial item failure (200, summary.failed > 0):** Body still 200; caller inspects `summary.failed` and `outcomes[].status === "failed"` to decide whether to retry. (Mirrors the script's "re-run with same manifest to fill gaps" model.)

## Reuse plan

Existing exports from `scripts/seed-object-inspirations.ts`:

- `parseManifestText` — already exported; parses raw JSON into shape
- `parseRows` — already exported; runs each row through zod
- `validateForeignKeys` — already exported; FK pre-flight
- `dispatchWithConcurrency` — already exported; bounded worker pool
- `summarize` — already exported; outcome aggregation

Plus the Firestore helpers:

- `seedObjectCategoryDoc` (`src/lib/objectInspiration/firestore.ts`)
- `seedObjectInspirationDoc` (`src/lib/objectInspiration/firestore.ts`)

The route handler is **thin glue**: read body, call the above, format response. No new business logic.

## Acceptance criteria

1. `POST /api/object-inspirations/bulk-seed` accepts the existing `object-inspirations.full.json` manifest verbatim, no transformation.
2. On a fresh database, all 40 categories + 800 items are persisted; response `summary.created === 840`.
3. On re-submit of the same manifest, `summary.updated === 840` and prompts are preserved (unless `X-Seed-Mode: overwrite`).
4. Submitting an item whose `categoryId` isn't in the same payload returns 400 with the orphan id listed in `issues`.
5. Submitting an invalid row (bad id regex, missing field) returns 400 listing per-row issues.
6. Unauthenticated requests return 401.
7. Repeated bulk submissions within the rate-limit window return 429.
8. Existing seed script (`scripts/seed-object-inspirations.ts`) continues to work unchanged — both paths are valid; the HTTP path is an additive convenience.

## Verification

- `curl` with manifest body against a local backend, assert 200 + summary
- Re-run with `X-Seed-Mode: overwrite` and inspect a Firestore doc's `prompt` field
- Negative tests: drop a `categoryId`, mangle an `id`, omit auth header
- Existing script dry-run still validates the same manifest identically

## Open questions

- None blocking. (Concurrency, error-shape, and atomicity decisions all follow the script's existing semantics. Admin-claim gating deferred — Explorer parity wins consistency; tighten later if needed.)
