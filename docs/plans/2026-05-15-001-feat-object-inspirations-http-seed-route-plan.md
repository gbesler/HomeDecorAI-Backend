---
title: "feat: Object Inspirations HTTP Bulk Seed Route"
type: feat
status: completed
date: 2026-05-15
origin: docs/brainstorms/2026-05-15-001-object-inspirations-http-seed-route-requirements.md
---

# feat: Object Inspirations HTTP Bulk Seed Route

## Overview

Add `POST /api/object-inspirations/bulk-seed` so the 40-category × 20-item furniture catalog manifest (`scripts/manifests/object-inspirations.full.json`) can be seeded over HTTP from Postman/curl during development and content iteration. Today there is no HTTP write surface — the seed script (`scripts/seed-object-inspirations.ts`) is the only path and requires service-account JSON + full env validation, which blocks ad-hoc seeding.

The new endpoint reuses the **existing** zod schemas, the **existing** Firestore upsert helpers, and the **existing** parse/FK/concurrency utilities from the seed script. The handler is thin glue — no new business logic.

## Problem Frame

- Object inspirations have no HTTP write path; iOS reads Firestore directly (see origin: docs/brainstorms/2026-05-15-001-object-inspirations-http-seed-route-requirements.md)
- Existing script path requires `GOOGLE_APPLICATION_CREDENTIALS`, base64 `FIREBASE_SERVICE_ACCOUNT_KEY`, AWS keys, and FAL/Replicate keys to even reach validation — a high friction barrier for dev/content iteration
- Explorer module already exposes a parallel HTTP seed pattern at `POST /api/explore/inspirations` (`src/routes/explore.ts`, `src/controllers/explore.controller.ts`); object inspirations should mirror it so operational ergonomics line up

## Requirements Trace

- R1. Endpoint accepts the existing manifest format verbatim (`{ categories, items }`)
- R2. Fresh-DB submit creates 40 categories + 800 items; response `summary.created === 840`
- R3. Re-submit upserts; default mode preserves prompts, `X-Seed-Mode: overwrite` replaces them
- R4. Orphan item (`categoryId` missing from payload) → 400 listing the offending id
- R5. Invalid row (bad id regex, missing field, etc.) → 400 with per-row issues
- R6. Unauthenticated request → 401
- R7. Over rate limit → 429
- R8. Existing seed script keeps working unchanged
- R9. Logic source-of-truth lives in one place; script and route both consume it

(see origin: docs/brainstorms/2026-05-15-001-object-inspirations-http-seed-route-requirements.md)

## Scope Boundaries

- **Out:** Per-record `POST /api/object-categories` / `POST /api/object-inspirations` — no current caller
- **Out:** PATCH/DELETE endpoints — mutability stays script-only
- **Out:** Admin custom claim gating — Explorer pattern uses plain `app.authenticate`; matching that keeps consistency. Existing `explore.controller.ts:95` comment explicitly defers admin gating until an authoring surface ships
- **Out:** Async/job pattern — synchronous bounded-concurrency fits 840 docs in the Fastify timeout budget
- **Out:** Touching iOS read path — Firestore snapshot listener stays untouched

## Context & Research

### Relevant Code and Patterns

| File | Role |
|---|---|
| `src/routes/explore.ts` | Fastify plugin pattern (preHandler chain, JSON schemas, error responses) — model for new route file |
| `src/controllers/explore.controller.ts` (`seedInspirationHandler` at line 98) | Handler shape, zod safeParse pattern, structured logging, `userId` extraction |
| `src/lib/objectInspiration/schemas.ts` | `ObjectCategorySeedInputSchema`, `ObjectInspirationSeedInputSchema` — already strict, already enforce id regex / FK shape / URL allow-list |
| `src/lib/objectInspiration/firestore.ts` | `seedObjectCategoryDoc`, `seedObjectInspirationDoc` — transactional upserts with prompt preservation |
| `scripts/seed-object-inspirations.ts` (exports) | `parseRows`, `validateForeignKeys`, `dispatchWithConcurrency`, `summarize`, `parseManifestText` — already pulled out exactly for reuse |
| `src/lib/rate-limiter.ts` + `src/config/rate-limits.ts` | `createRateLimitPreHandler(endpoint)` factory; rate-limit table is a single object keyed by endpoint name |
| `src/routes/index.ts` | Plugin registration with `/explore`, `/account`, etc. prefixes — new route added the same way |

### Institutional Learnings

- Memory: Firestore for data, S3 for images (matches existing object-inspiration design)
- `explore.controller.ts:124-126` — `prompt` and request body must NOT be spread into structured logs. Apply the same constraint here

### External References

- None needed — pattern fully established locally; Fastify + zod + Firebase Admin SDK all used identically in adjacent routes

## Key Technical Decisions

- **Reuse, don't reimplement**: helper utilities (`parseRows`, `validateForeignKeys`, `dispatchWithConcurrency`, `summarize`) currently live in `scripts/seed-object-inspirations.ts`. Production route code importing from `scripts/` is awkward; move the helpers to `src/lib/objectInspiration/seed-helpers.ts` and have both the script and the route import from there. Keeps single source of truth without leaking scripts into the production module graph.
- **No per-record endpoint, only bulk**: 840 separate POSTs is impractical and there's no programmatic caller that would do that. Manifest format already exists and validates cleanly.
- **Fastify-level schema = thin wrapper**: top-level shape (`{ categories: array, items: array }`) declared in Fastify schema so we get the standard 400 envelope for grossly malformed bodies; per-row validation stays in zod inside the handler (mirrors Explorer).
- **Concurrency hardcoded at 10**: matches the script's default. Exposing it as a body/header parameter widens the API surface without a reason today.
- **Response shape mirrors script JSONL**: `{ summary, outcomes }`. Reusing the same `SeedOutcome` type means an operator who already understands script output can read HTTP output without retraining.
- **Item-phase failures keep 200**: identical to script semantics. Caller inspects `summary.failed`. Category-phase failures keep abort behavior (no point writing items into a category that never landed).
- **X-Seed-Mode header**: same name & values (`overwrite` vs anything-else) as the script — no parallel concepts to confuse operators.

## Open Questions

### Resolved During Planning

- *Single bulk endpoint or single-record + bulk?* → Bulk only. No single-record caller exists; YAGNI applies.
- *Admin claim gating?* → No, match Explorer pattern (`app.authenticate` only). `explore.controller.ts:95` codifies the deferral.
- *Where do shared helpers live?* → New file `src/lib/objectInspiration/seed-helpers.ts`. Script and route both import from it; the script keeps its current public CLI behavior.
- *Body schema source-of-truth?* → Existing zod schemas in `src/lib/objectInspiration/schemas.ts`. Fastify schema only declares the top-level shape + response envelopes.

### Deferred to Implementation

- Exact OpenAPI response example structure (Fastify generates from schema; pick concrete dimensions during implementation).
- Whether the `outcomes` array should be truncated in the HTTP response when the manifest is very large (840 rows fits comfortably; not worth pre-engineering paging).

## Implementation Units

- [ ] **Unit 1: Extract seed helpers to `src/lib/objectInspiration/seed-helpers.ts`**

**Goal:** Move `parseManifestText`, `parseRows`, `validateForeignKeys`, `dispatchWithConcurrency`, `summarize`, plus the `Manifest` and `SeedOutcome` types out of `scripts/seed-object-inspirations.ts` into a reusable lib module. Update the script to import them. No behavior change.

**Requirements:** R9

**Dependencies:** None

**Files:**
- Create: `src/lib/objectInspiration/seed-helpers.ts`
- Modify: `scripts/seed-object-inspirations.ts` (delete the moved functions, re-export them so the existing public surface is preserved)
- Test: `src/lib/objectInspiration/seed-helpers.test.ts` (move the relevant cases from `scripts/seed-object-inspirations.test.ts`; the script's test file can keep CLI-glue-specific cases or be slimmed)

**Approach:**
- Pure-function move; no business-logic change
- Script's `main()`, `seedOneCategory`, `seedOneItem`, `initializeFirebase`, `emitJsonl`, `isCli` stay in `scripts/` — they're CLI-shell concerns, not seed semantics
- Preserve the existing exported names from `scripts/seed-object-inspirations.ts` by re-exporting from the new module so any external caller (or test) referring to them still resolves

**Patterns to follow:**
- Same `node:test` + `node:assert/strict` style as existing `seed-object-inspirations.test.ts`
- Same TS module style as `src/lib/objectInspiration/firestore.ts` (named exports, no default exports)

**Test scenarios:**
- Happy path: `parseRows` accepts a valid 2-category/2-item manifest and returns empty errors array
- Happy path: `validateForeignKeys` returns empty array when all items reference a present category
- Edge case: `parseRows` with one invalid category row returns the category in `errors` and continues parsing remaining rows
- Edge case: `parseManifestText` rejects a string whose top-level is not `{ categories: [], items: [] }` (no `categories` key, `items` not an array)
- Edge case: `validateForeignKeys` returns one error per orphan item (item's `categoryId` not in categories list)
- Error path: `dispatchWithConcurrency` propagates worker results; verify total outcomes count equals input count regardless of worker order
- Integration: existing `scripts/seed-object-inspirations.test.ts` cases that depended on these helpers continue to pass through the script's re-exports

**Verification:**
- `npm test` (or `node --test`) passes for both the new test file and the existing script test
- The script can still be invoked with `--dry-run` against the existing manifest and produces identical JSONL output to before

---

- [ ] **Unit 2: Add `objectInspirationSeed` rate-limit entry**

**Goal:** Define the rate-limit envelope for the new endpoint so `createRateLimitPreHandler("objectInspirationSeed")` resolves.

**Requirements:** R7

**Dependencies:** None

**Files:**
- Modify: `src/config/rate-limits.ts`

**Approach:**
- Add one entry to the `rateLimits` map keyed `objectInspirationSeed`
- Use the same envelope as `exploreSeed` (`10/min, 100/hr, 500/day`) — both are admin-style seeds against globally-visible catalogs, identical abuse profile
- Comment cites the parallel: "Object inspiration bulk seed — mirrors exploreSeed envelope; a single request can write 840 docs, so the tight cap is both abuse damper and Firestore-quota guard."

**Patterns to follow:**
- `rateLimits.exploreSeed` (`src/config/rate-limits.ts:138-142`)

**Test scenarios:**
- Test expectation: none — config-only change; behavior is exercised by Unit 4 integration tests via 429 assertions

**Verification:**
- TypeScript compiles
- `createRateLimitPreHandler("objectInspirationSeed")` invoked from Unit 4 does not throw "No rate limit config for endpoint"

---

- [ ] **Unit 3: Implement `bulkSeedObjectInspirationsHandler` controller**

**Goal:** New controller function that consumes a manifest body, runs validation + FK + concurrent upserts, returns `{ summary, outcomes }`.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** Unit 1 (imports the helpers from `seed-helpers.ts`)

**Files:**
- Create: `src/controllers/objectInspiration.controller.ts`
- Test: `src/controllers/objectInspiration.controller.test.ts`

**Approach:**
- Function signature mirrors `seedInspirationHandler` (request, reply)
- Steps:
  1. `userId` guard (`unauthorized(reply)` if absent — `app.authenticate` will normally catch this first; the explicit check matches `explore.controller.ts:103`)
  2. Validate the top-level shape (categories/items must be arrays). If Fastify schema already enforced it (Unit 4), this is a defensive no-op.
  3. Call `parseRows({ categories, items })` from `seed-helpers.ts` → on any per-row error, return 400 with `{ error, message, issues }` where `issues` lists `{ kind: "category"|"item", id, errors[] }`
  4. Call `validateForeignKeys(parsedCategories, parsedItems)` → on any orphan, return 400 with the orphan ids listed
  5. Read `X-Seed-Mode` header via `parseSeedMode(request.headers["x-seed-mode"])` (already exported from `src/lib/objectInspiration/schemas.ts`)
  6. Run categories through `dispatchWithConcurrency` with worker calling `seedObjectCategoryDoc`. If any category outcome is `failed`, return early with `{ summary, outcomes }` and an HTTP 200 — the script also returns failure summary instead of throwing; matching this gives operators a consistent error shape regardless of which seed path they use. (Alternative: 500. Going with 200 + failed summary to mirror script + because partial failure during item phase is also reported as 200 per R8 acceptance — consistency wins.)
  7. Run items through `dispatchWithConcurrency` calling `seedObjectInspirationDoc(row, mode)`
  8. Aggregate via `summarize([...categoryOutcomes, ...itemOutcomes])`
  9. Return `{ summary, outcomes: [...categoryOutcomes, ...itemOutcomes] }`
- Logging: structured log on entry (`event: "objectInspirationSeed.start"`, `userId`, `categoryCount`, `itemCount`), and on completion (`event: "objectInspirationSeed.done"`, `userId`, `summary`). DO NOT log row contents or prompts — same constraint as `explore.controller.ts:124-126`.
- Errors thrown by Firestore helpers already get captured per-row by `dispatchWithConcurrency` into the outcome's `reason`. Top-level try/catch wraps the orchestration to return `internalError(reply, ...)` if something truly unexpected (network drop, admin SDK init) bubbles up.

**Patterns to follow:**
- `src/controllers/explore.controller.ts:98` (`seedInspirationHandler`) — same shape, same logging conventions
- `src/controllers/explore.controller.ts:124-126` — prompt-not-in-logs rule

**Test scenarios:**
- Happy path: well-formed 2-cat/2-item manifest → 200, `summary.total = 4`, `summary.created = 4`
- Happy path: same manifest re-submitted → 200, `summary.updated = 4`, prompts preserved (assert by stubbing `seedObjectInspirationDoc` and verifying `mode = "default"`)
- Happy path: `X-Seed-Mode: overwrite` header → handler invokes `seedObjectInspirationDoc(row, "overwrite")`
- Edge case: empty `categories: []` and empty `items: []` → 200, `summary.total = 0`
- Edge case: 800-item manifest → all items dispatched; assert outcomes.length equals 800
- Error path: missing auth (`request.userId` undefined) → 401
- Error path: row with bad `id` regex → 400, issue mentions the bad id
- Error path: item `categoryId` not present in payload's categories → 400, message names the orphan
- Error path: `seedObjectCategoryDoc` throws → outcome status `failed`, summary reflects it, response 200 with failure summary (no items attempted for the failed category, but items for *other* categories still attempted — sequencing decision documented in Unit 3 approach step 6)
- Error path: one item write fails mid-batch → other items still processed, summary.failed reflects only the failing rows
- Integration: handler invocation goes through to real (in-memory or emulator) Firestore for at least one happy-path case so the seed semantics are end-to-end exercised (mocking the firestore helpers is fine for the validation paths)
- Integration: prompt preservation — submit row with prompt, re-submit same id without prompt under default mode; doc still has original prompt

**Verification:**
- All controller tests pass
- Manual `curl` (deferred to Unit 4 verification) hits 200 with expected summary

---

- [ ] **Unit 4: Wire route file + register under `/object-inspirations` prefix**

**Goal:** Expose the controller as `POST /api/object-inspirations/bulk-seed` behind `app.authenticate` and `objectInspirationSeedLimit`.

**Requirements:** R1, R6, R7, R8

**Dependencies:** Unit 2 (rate-limit key), Unit 3 (controller)

**Files:**
- Create: `src/routes/object-inspirations.ts`
- Modify: `src/routes/index.ts`
- Test: `src/routes/object-inspirations.test.ts` (HTTP-level: assert routing, preHandler chain, 401/429/200 envelopes)

**Approach:**
- New Fastify plugin module exporting `objectInspirationsRoutes: FastifyPluginAsync`
- Single route declaration: `app.post("/bulk-seed", { preHandler: [app.authenticate, objectInspirationSeedLimit], schema: { … }, handler: bulkSeedObjectInspirationsHandler })`
- Fastify schema:
  - Body: `{ type: "object", properties: { categories: { type: "array" }, items: { type: "array" } }, required: ["categories", "items"], additionalProperties: false }` — just the wrapper; per-row validation stays in the controller via zod (matches Explorer)
  - Responses: 200 (summary + outcomes), 400 (validation envelope), 401, 429, 500 — pulled from `shared-schemas.ts` where possible
- Register the plugin in `src/routes/index.ts` with `app.register(objectInspirationsRoutes, { prefix: "/object-inspirations" })`

**Patterns to follow:**
- `src/routes/explore.ts:82-164` (seed route declaration)
- `src/routes/index.ts` registration block

**Test scenarios:**
- Happy path: authenticated request with valid manifest body → 200 + summary
- Edge case: empty body `{}` → 400 (Fastify schema catches missing `categories`/`items`)
- Edge case: body with `extraField` → 400 (`additionalProperties: false`)
- Error path: no Authorization header → 401 (via `app.authenticate`)
- Error path: 11th request inside the same minute → 429 (`objectInspirationSeedLimit`, `minuteLimit: 10`)
- Integration: route correctly mounts at `/api/object-inspirations/bulk-seed` (assert via app.inject URL) — confirms the index registration is wired

**Verification:**
- `curl -X POST $BASE/api/object-inspirations/bulk-seed -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data @scripts/manifests/object-inspirations.full.json` returns 200 with `summary.total === 840`
- Re-running the same curl returns 200 with `summary.updated === 840` and `summary.created === 0`
- Running it with `-H "X-Seed-Mode: overwrite"` overwrites prompts (verifiable by editing one row's prompt locally and confirming the Firestore doc reflects the new prompt)

## System-Wide Impact

- **Interaction graph:** New route plugs into existing `app.authenticate` preHandler chain. No changes to other routes. Firestore writes go through the same `seedObjectCategoryDoc` / `seedObjectInspirationDoc` helpers the script already uses → identical observability and identical write semantics.
- **Error propagation:** Per-row failures captured by `dispatchWithConcurrency` into outcomes; top-level orchestration errors → 500 via `internalError`. The handler does not throw past Fastify's error boundary.
- **State lifecycle risks:** Idempotent upserts mean re-submits are safe. Item-phase partial failure is recoverable by re-submitting the same manifest — the script's existing semantics.
- **API surface parity:** Match Explorer's seed endpoint conventions (auth, error envelope shape, structured logging without bodies). Operators who know one know the other.
- **Integration coverage:** At least one end-to-end test should hit the real Firestore upsert path (emulator preferred) — mocking the firestore helpers verifies routing but not seed semantics.
- **Unchanged invariants:**
  - iOS Firestore snapshot listener for the `objectInspirations` and `objectCategories` collections is untouched
  - `scripts/seed-object-inspirations.ts` retains identical CLI behavior (helpers re-exported through it for backward compatibility)
  - Existing zod schemas in `src/lib/objectInspiration/schemas.ts` unchanged
  - Existing Firestore helpers in `src/lib/objectInspiration/firestore.ts` unchanged

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 840-doc write inside a single HTTP request might exceed Fastify timeout under cold start / slow Firestore | Concurrency 10 keeps wall-clock close to ~Nx single-write latency; if observed timing is too slow, surface as a deferred follow-up (async/queue), not a pre-launch blocker. The script already runs this pattern successfully |
| Memory holding all 840 outcomes in the response body | 840 rows × ~120 bytes each ≈ 100 KB JSON — well within Fastify's default `bodyLimit` (1 MB) |
| Re-exporting moved helpers from `scripts/seed-object-inspirations.ts` could create circular import if the script later imports from the route | Helpers live in `src/lib/`; script imports from `src/lib/`; route imports from `src/lib/`. No edge points back at `scripts/` |
| Operators may forget about prompt-preservation default and assume re-seed overwrites | Document the `X-Seed-Mode` semantics in the route's OpenAPI summary and in `scripts/manifests/README.md` |
| Rate limit (10/min) too tight for legitimate iterative manifest tuning | Envelope mirrors `exploreSeed`, which is the established pattern. If feedback shows iteration is throttled, loosen as a config-only change |

## Documentation / Operational Notes

- Update `scripts/manifests/README.md` with a "HTTP seed alternative" section showing the curl command + `X-Seed-Mode` semantics
- No new env vars required
- No migration required — endpoint is purely additive
- No iOS work — Firestore listeners pick up writes automatically

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-15-001-object-inspirations-http-seed-route-requirements.md](../brainstorms/2026-05-15-001-object-inspirations-http-seed-route-requirements.md)
- Related code:
  - `src/routes/explore.ts` (seed route pattern)
  - `src/controllers/explore.controller.ts:98` (seed handler pattern)
  - `src/lib/objectInspiration/schemas.ts` (zod schemas)
  - `src/lib/objectInspiration/firestore.ts` (upsert helpers)
  - `scripts/seed-object-inspirations.ts` (helpers to be extracted)
  - `src/lib/rate-limiter.ts` + `src/config/rate-limits.ts` (rate limit factory + table)
- Manifest under test: `scripts/manifests/object-inspirations.full.json` (40 × 20 = 800 items)
