---
title: "refactor: Store relative image path instead of full URL on inspiration docs"
type: refactor
status: active
date: 2026-06-01
---

# refactor: Store relative image `path` instead of full URL on inspiration docs

> **Spans two repos.** Backend = `HomeDecorAI-Backend` (this repo). iOS = `HomeDecorAI`.
> File paths below are repo-relative; each unit names its target repo.

## Overview

Both inspiration catalogs store **fully-qualified image URLs** in Firestore:

- `objectCategories/{id}.heroImageUrl`
- `objectInspirations/{id}.imageUrl`
- `inspirations/{id}.imageUrl` (Explorer)

The host (`https://home-interior-ai-app.s3.us-east-1.amazonaws.com/...` or a
CloudFront domain) is baked into every doc. If the bucket, region, or CDN
distribution ever changes, every document is stale and must be rewritten.

This refactor replaces those URL fields with a single relative **`path`** field
that carries only the storage-side folder + filename
(e.g. `in_app_images/01_Sectional_Sofa.jpeg`). Consumers compose the full URL at
read time from a base they already own:

- **iOS** prepends its cached CloudFront host (`AWSService.cloudFrontHost`).
- **Backend AI pipeline** reconstructs the full URL from the env base
  (`AWS_CLOUDFRONT_HOST` / S3) before handing the reference photo to the image
  provider.

## Problem Frame

Storing the host couples content rows to infrastructure. A CDN/bucket migration
or multi-environment setup (staging vs prod buckets) currently requires
rewriting all ~800 object items + ~340 explorer rows. A relative `path` makes
the row infrastructure-agnostic: the same doc resolves correctly in any
environment because the base is environment config, not data.

The app is **not yet live** (decision below), so we can do a clean **hard
cutover** — rename the field, drop the old one, re-seed all docs, and ship the
iOS change together. No dual-field transition window.

## Requirements Trace

- **R1.** Object + Explorer Firestore docs store a relative `path` field instead
  of `heroImageUrl` / `imageUrl`.
- **R2.** iOS composes the display URL from `AWSService` CloudFront base + `path`
  for object tiles (wizard) and Explorer feed.
- **R3.** Backend AI pipeline (Replace & Add Object) reconstructs the full
  reference-photo URL from `path` + server base, and the composed URL still
  passes SSRF validation before reaching the provider.
- **R4.** Seed schemas, manifests, and the seed CLI/HTTP paths accept `path` and
  reject unsafe path values (traversal, host smuggling, absolute URLs).
- **R5.** Existing Firestore docs are migrated to the new shape (old URL fields
  removed) via re-seed + a field-cleanup pass.
- **R6.** Seeding docs (`INSPIRATIONS-GUIDE.md`, `manifests/README.md`) reflect
  `path`.

## Scope Boundaries

- **Not** changing where images physically live in S3, nor re-uploading images.
- **Not** introducing a dual-field/back-compat window (hard cutover — app not live).
- **Not** changing the iOS remote-config mechanism that already delivers the
  CloudFront host (`ConfigService` / `AWSService`); we reuse it.
- **Not** touching generated-output image URLs (`outputImageUrl` /
  `outputImageCDNUrl`) — those already have their own CDN-rewrite path and are
  unrelated to inspiration content.
- **Not** changing Firestore security rules' `active == true` predicate.

## Context & Research

### Relevant Code and Patterns

**Backend (`HomeDecorAI-Backend`)**
- `src/lib/objectInspiration/schemas.ts` — `ImageUrlSchema` (refined by
  `isAllowedInspirationUrl`), used for `heroImageUrl` + `imageUrl`; `ImageMimeSchema`.
- `src/lib/objectInspiration/types.ts` — `ObjectInspirationCategoryDoc.heroImageUrl`,
  `ObjectInspirationItemDoc.imageUrl`.
- `src/lib/objectInspiration/seedShape.ts` — `buildObjectCategoryDoc` /
  `buildObjectInspirationDoc`, and `OBJECT_CATEGORY_MERGE_FIELDS` /
  `OBJECT_INSPIRATION_DEFAULT_MERGE_FIELDS` (contain `heroImageUrl` / `imageUrl`).
- `src/lib/inspiration/schemas.ts` — `allowedInspirationHosts()`,
  `isAllowedInspirationUrl`, explorer `imageUrl` field.
- `src/lib/inspiration/types.ts` — `InspirationDoc.imageUrl`.
- `src/lib/inspiration/seedShape.ts` — `INSPIRATION_UPSERT_MERGE_FIELDS`.
- `src/lib/tool-types.ts` — `replaceAddObject.preEnqueueValidate` (line ~1531/1582):
  `validatePublicImageUrl(doc.imageUrl,…)` → `inspirationImageUrl: doc.imageUrl`.
- `src/services/generation-processor.ts` (line ~502/511): inline-resolve fallback
  `inspirationImageUrl = doc.imageUrl` + SSRF validation.
- `src/lib/storage/url-validation.ts` — `validatePublicImageUrl` (the SSRF gate to reuse).
- `scripts/manifests/*.json`, `scripts/seed-object-inspirations.ts`,
  `scripts/seed-explore-inspirations.ts`.
- `src/routes/object-inspirations.ts`, `src/routes/explore.ts` — request/response schemas.

**iOS (`HomeDecorAI`)**
- `HomeDecorAI/Core/AWS/AWSService.swift` — `nonisolated static var cloudFrontHost`,
  `s3BucketName`, `isCDNReady`, `rewriteToCDNIfPossible(_:)`. **The base already
  exists and is synchronously readable.** Needs a new `url(forPath:)` composer.
- `HomeDecorAI/Features/Wizard/Models/ObjectInspirationItem.swift` (`imageUrl`),
  `ObjectInspirationCategory.swift` (`heroImageUrl`).
- `HomeDecorAI/Features/Wizard/Models/WizardCatalogSnapshot.swift` — `fromRemote`
  builds `URL(string: cat.heroImageUrl)` / `item.imageUrl`.
- `HomeDecorAI/Features/Wizard/Catalog/ObjectInspirationCatalogCacheService.swift`
  — persists the image field; cache `schemaVersion` must bump.
- `HomeDecorAI/Features/Explore/Models/Inspiration.swift` — `imageUrl: URL`
  (decoded as URL), `displayURL` already calls `AWSService.rewriteToCDNIfPossible`.

### Institutional Learnings

- `docs/solutions/` not searched exhaustively here; the existing CDN-rewrite
  pattern in `AWSService.rewriteToCDNIfPossible` and `DesignAPIService`'s
  `outputImageCDNUrl` are the precedent for "store one form, present another."

### Key existing facts that shape the plan

- iOS already caches the CloudFront host from remote config — **no new config or
  network surface needed on the client.**
- Backend SSRF defense (`validatePublicImageUrl`) is the load-bearing safety net
  for the provider fetch and must remain on the *composed* URL.
- Explorer `imageUrl` is **display-only** — `generation-processor.ts` only
  resolves `objectInspirations` reference photos, never `inspirations`. So
  Explorer needs iOS-side reconstruction only; no backend pipeline change.

## Key Technical Decisions

- **Field name = `path`** (single name across all three collections). Category's
  single image makes the lost "hero" prefix a non-issue.
- **Hard cutover, no back-compat window.** App not live → rename field, drop old
  field, re-seed everything, ship iOS together.
- **`path` is bucket-root-relative**, no leading `/`, no scheme, no host
  (e.g. `in_app_images/01_Sectional_Sofa.jpeg`). Validated by a new strict
  `PathSchema`.
- **Backend reconstructs via the same base the allow-list trusts** — prefer
  `AWS_CLOUDFRONT_HOST`, else the virtual-hosted S3 host — then runs the composed
  URL through the existing `validatePublicImageUrl` so the SSRF guarantee is
  unchanged (base is trusted config, `path` is the only variable).
- **iOS reconstructs via `AWSService.cloudFrontHost`** with a new
  `AWSService.url(forPath:)`; falls back to the existing skeleton/placeholder
  when CDN not yet configured (same as today's not-ready state).
- **Shared `path` validation lives in one place** and is imported by both object
  and explorer schemas (mirror how `isAllowedInspirationUrl` is shared today).

## Open Questions

### Resolved During Planning

- **Field name?** → `path` (user decision).
- **Back-compat window?** → None; hard cutover (app not live, user decision).
- **Where does iOS get the base?** → Existing `AWSService.cloudFrontHost` (already
  cached from remote config). No new client config.
- **Does Explorer image reach a provider?** → No; display-only. Backend pipeline
  change is object-inspiration-only.

### Deferred to Implementation

- Exact name of the new path-validation helper and the iOS `url(forPath:)` API
  shape (signature finalized when touching the code).
- Whether the obsolete `imageUrl`/`heroImageUrl` fields are stripped by a
  dedicated `FieldValue.delete()` migration pass or by recreating docs — decide
  when writing the migration unit (Unit 5) against real doc counts.
- Whether any `firestore.rules` clause references the old field names (verify;
  expected none).

## High-Level Technical Design

> *Directional guidance for review, not implementation specification.*

```
WRITE (seed)                         READ (consume)
------------                         --------------
manifest { path: "in_app_images/x.jpeg" }
   │  PathSchema (no host/scheme/traversal)
   ▼
Firestore doc { path: "in_app_images/x.jpeg" }
   │                                   ├── iOS:  url = https://<cloudFrontHost>/<path>   → Kingfisher
   │                                   │          (AWSService.url(forPath:))
   │                                   └── Backend AI (object only):
   │                                              url = https://<AWS_CLOUDFRONT_HOST>/<path>
   │                                              → validatePublicImageUrl(url)  ← SSRF gate unchanged
   │                                              → inspirationImageUrl → provider
```

Base resolution (both sides): prefer CloudFront host; fall back to the
virtual-hosted S3 host. `path` is the only data-driven segment.

## Implementation Units

Grouped into phases. Backend data-model first (it defines the contract), then
backend pipeline + migration, then iOS, then docs. iOS and backend can land in
parallel once the contract (Unit 1) is agreed, but must **deploy together**.

### Phase 1 — Backend contract

- [ ] **Unit 1: `path` schema + types (both flows)**

**Goal:** Replace the URL fields with a validated relative `path` in schemas and types.

**Requirements:** R1, R4

**Dependencies:** None

**Files** (repo `HomeDecorAI-Backend`):
- Create: `src/lib/storage/inspiration-path.ts` (shared `PathSchema` + `isSafeInspirationPath`)
- Modify: `src/lib/objectInspiration/schemas.ts` (replace `ImageUrlSchema` use for `heroImageUrl`/`imageUrl` → `path` via `PathSchema`)
- Modify: `src/lib/objectInspiration/types.ts` (`heroImageUrl`→`path`, `imageUrl`→`path`)
- Modify: `src/lib/inspiration/schemas.ts` (`imageUrl`→`path`; retire `isAllowedInspirationUrl` for this field)
- Modify: `src/lib/inspiration/types.ts` (`InspirationDoc.imageUrl`→`path`)
- Test: `src/lib/storage/inspiration-path.test.ts`, update `src/lib/objectInspiration/schemas.test.ts`, `src/lib/inspiration/schemas.test.ts`

**Approach:**
- `PathSchema`: trimmed string, `min(1).max(1024)`, must NOT contain a scheme
  (`://`), leading `/`, `..` segment, backslash, whitespace, `@`, or percent-encoded
  traversal (`%2e%2e`, `%2f`); should look like `folder/.../name.ext`. Keep the
  `image/*` mime field as-is.
- Both `heroImage*`/`image*` dimension + mime fields stay; only the URL field is
  renamed to `path`.

**Patterns to follow:** existing `ImageUrlSchema` refine pattern; share `PathSchema`
the way `isAllowedInspirationUrl` is shared from `lib/inspiration/schemas.ts`.

**Test scenarios:**
- Happy path: `"in_app_images/01_Sectional_Sofa.jpeg"` parses for category, item, explorer.
- Edge: nested subfolders `"a/b/c/x.png"` allowed; single filename `"x.jpeg"` allowed.
- Error: rejects `"https://host/x.jpg"` (scheme), `"/in_app_images/x.jpg"` (leading slash),
  `"../secret.jpg"` and `"a/../../x"` (traversal), `"a\\b.jpg"` (backslash),
  `"%2e%2e/x"` (encoded traversal), empty string, `">1024 chars"`.

**Verification:** schema tests green; types compile; no remaining `imageUrl`/`heroImageUrl`
references in object/explorer schema+type files.

- [ ] **Unit 2: seedShape builders + merge fields (both flows)**

**Goal:** Build the Firestore doc with `path`; update merge-field lists so re-seed propagates `path`.

**Requirements:** R1, R5

**Dependencies:** Unit 1

**Files** (`HomeDecorAI-Backend`):
- Modify: `src/lib/objectInspiration/seedShape.ts` (builders + `OBJECT_CATEGORY_MERGE_FIELDS`, `OBJECT_INSPIRATION_DEFAULT_MERGE_FIELDS`, `OBJECT_INSPIRATION_OVERWRITE_MERGE_FIELDS`)
- Modify: `src/lib/inspiration/seedShape.ts` (`INSPIRATION_UPSERT_MERGE_FIELDS`, builder)
- Test: update `src/lib/objectInspiration/seedShape.test.ts`, `src/lib/inspiration/seedShape.test.ts`

**Approach:** mechanical rename `heroImageUrl`/`imageUrl` → `path` in built doc +
merge-field arrays. Keep prompt-preservation/searchTerms semantics untouched.

**Test scenarios:**
- Happy path: built category/item/explorer doc carries `path`, not the old field.
- Edge: merge-field arrays include `path` (so re-seed overwrites it) and still exclude `prompt` in default mode.

**Verification:** seedShape tests green; merge-field assertions reference `path`.

### Phase 2 — Backend AI pipeline + routes

- [ ] **Unit 3: path→URL reconstruction + SSRF for the AI pipeline (object only)**

**Goal:** Reconstruct the reference-photo URL from `doc.path` + server base, keep the SSRF gate.

**Requirements:** R3

**Dependencies:** Unit 1

**Files** (`HomeDecorAI-Backend`):
- Create: `src/lib/storage/resolve-inspiration-url.ts` (`resolveInspirationImageUrl(path): string` — compose base + path)
- Modify: `src/lib/tool-types.ts` (`replaceAddObject.preEnqueueValidate`: compose from `doc.path`, then `validatePublicImageUrl(composed,…)`, set `inspirationImageUrl`)
- Modify: `src/services/generation-processor.ts` (inline-resolve fallback uses `doc.path` → compose → validate)
- Test: `src/lib/storage/resolve-inspiration-url.test.ts`; update relevant tool-types/processor tests

**Approach:**
- Base = `AWS_CLOUDFRONT_HOST` if set, else `${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com`;
  join with `path` (single `/`, no double slash). Reuse `allowedInspirationHosts()`
  knowledge so the composed host is always allow-listed.
- The composed URL still flows through `validatePublicImageUrl` — unchanged SSRF
  posture; `path` was already validated at seed time, this is defense-in-depth.
- Missing/empty `path` → same `409 CONTENT_UNAVAILABLE` the missing-`imageUrl`
  branch returns today.

**Patterns to follow:** existing `preEnqueueValidate` 409 branches; existing
`validatePublicImageUrl` call site.

**Test scenarios:**
- Happy path: doc `path` → composed CloudFront URL → passes validation → `inspirationImageUrl` set.
- Edge: base with/without trailing slash, path without leading slash → exactly one `/` join.
- Error: empty/missing `path` → 409; a `path` that somehow composes to a private host → SSRF rejection (defense-in-depth).
- Integration: full enqueue path for `replaceAddObject` produces a provider-bound URL identical in form to the pre-refactor URL.

**Verification:** enqueue of a Replace/Add Object generation resolves the reference
photo correctly; SSRF tests green.

- [ ] **Unit 4: HTTP route request/response schemas + DTOs**

**Goal:** Routes accept/emit `path` instead of the URL fields.

**Requirements:** R1, R4

**Dependencies:** Unit 1

**Files** (`HomeDecorAI-Backend`):
- Modify: `src/routes/object-inspirations.ts`, `src/routes/explore.ts` (body/response JSON schemas, field docs, the `AWS_CLOUDFRONT_HOST`-unset boot warning copy)
- Modify: any DTO in `src/lib/*/types.ts` exposing the field
- Test: update route/controller tests referencing the old fields

**Approach:** rename in Fastify JSON schemas + OpenAPI descriptions; the
"host not allowed" guidance becomes "path must be bucket-relative".

**Test scenarios:**
- Happy path: bulk-seed body with `path` validates; response echoes outcomes.
- Error: body with legacy `imageUrl` rejected by `.strict()` (signals stale manifest).

**Verification:** route tests green; Swagger shows `path`.

### Phase 3 — Backend data migration + docs

- [ ] **Unit 5: Migrate existing Firestore docs + regenerate manifests**

**Goal:** Convert all live docs and manifests to `path`; remove obsolete URL fields.

**Requirements:** R5

**Dependencies:** Units 1–4

**Files** (`HomeDecorAI-Backend`):
- Modify: `scripts/manifests/object-inspirations.full.json`, `object-inspirations.initial.json`,
  `object-inspirations.categories-only.json`, `object-inspirations.searchTerms.example.json`,
  `object-inspirations.fix-broken-urls.json`, `explore-inspirations.full.json`,
  `explore-inspirations.bulk.json` (strip host prefix → `path`)
- Create: `scripts/migrate-inspiration-image-path.ts` (one-time: re-seed is upsert, but
  also `FieldValue.delete()` the stale `imageUrl`/`heroImageUrl` on existing docs)
- Modify (if needed): `scripts/seed-object-inspirations.ts`, `scripts/seed-explore-inspirations.ts`
  (no logic change expected beyond schema import; verify)

**Approach:**
- Manifest transform: `url → path` by stripping the known host prefix
  (`https://<host>/`). One-off transform script or manual `sed`/jq; verify every
  row ends up with a bucket-relative `path`.
- Re-seed with overwrite writes `path`; a cleanup pass deletes the old field so
  docs aren't left with both (hard cutover cleanliness).
- **Sequencing:** deploy backend (Units 1–4) + run migration + ship iOS in one
  coordinated release; old field removal only after iOS reads `path`.

**Execution note:** Dry-run every manifest (`--dry-run`) before the real seed;
verify a sample doc in Firestore has `path` and no `imageUrl` after the cleanup pass.

**Test scenarios:**
- Happy path: transformed `object-inspirations.full.json` passes `--dry-run` (all rows valid `path`).
- Edge: a manifest row whose URL host doesn't match the known prefix → transform flags it rather than silently mangling.

**Verification:** dry-run clean on all manifests; post-migration spot check shows
`path` present, legacy field absent.

- [ ] **Unit 6: Update seeding docs**

**Goal:** Docs describe `path`, not URL fields.

**Requirements:** R6

**Dependencies:** Unit 1

**Files** (`HomeDecorAI-Backend`):
- Modify: `scripts/INSPIRATIONS-GUIDE.md`, `scripts/manifests/README.md`

**Approach:** replace `imageUrl`/`heroImageUrl` examples with `path`; update the
allow-list/host section to the path-format rule; update the curl/manifest snippets.

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** guide examples use `path`; no stale `imageUrl` examples remain.

### Phase 4 — iOS

- [ ] **Unit 7: `AWSService.url(forPath:)` composer**

**Goal:** One place that turns a stored `path` into a CloudFront URL.

**Requirements:** R2

**Dependencies:** Unit 1 (contract)

**Files** (repo `HomeDecorAI`):
- Modify: `HomeDecorAI/Core/AWS/AWSService.swift` (add `nonisolated static func url(forPath:) -> URL?`)
- Test: `HomeDecorAITests/.../AWSServiceTests.swift` (create/extend)

**Approach:** `https://<cloudFrontHost>/<path>` (single-slash join, percent-encode
the path safely); return `nil` when `cloudFrontHost` is unset (caller shows the
existing not-ready placeholder). Mirror `rewriteToCDNIfPossible` conventions.

**Test scenarios:**
- Happy path: `("in_app_images/x.jpeg")` with host set → `https://<host>/in_app_images/x.jpeg`.
- Edge: path with leading slash defended; spaces/unicode percent-encoded; host unset → `nil`.

**Verification:** unit tests green.

- [ ] **Unit 8: Object models + cache use `path`**

**Goal:** Wizard catalog models carry `path`; build URLs via Unit 7.

**Requirements:** R2

**Dependencies:** Unit 7

**Files** (`HomeDecorAI`):
- Modify: `HomeDecorAI/Features/Wizard/Models/ObjectInspirationItem.swift` (`imageUrl`→`path`)
- Modify: `HomeDecorAI/Features/Wizard/Models/ObjectInspirationCategory.swift` (`heroImageUrl`→`path`)
- Modify: `HomeDecorAI/Features/Wizard/Models/WizardCatalogSnapshot.swift` (`fromRemote`: `AWSService.url(forPath: cat.path)`; drop categories/items whose URL can't be built — same as today's bad-URL drop)
- Modify: `HomeDecorAI/Features/Wizard/Catalog/ObjectInspirationCatalogCacheService.swift` (`CachedItem`/category field rename + **bump `currentSchemaVersion`** to wipe stale cache)
- Test: update `HomeDecorAITests/.../ObjectInspiration*Tests.swift`, snapshot/cache tests

**Approach:** decode `path` (String) from Firestore; `imageRef` becomes
`.remoteURL(url:…)` built from `AWSService.url(forPath:)`. Cache schema bump forces
old en/URL-shaped caches to wipe cleanly on upgrade.

**Test scenarios:**
- Happy path: decode a doc with `path` → snapshot item has a composed remote URL.
- Edge: `path` present but CDN not ready → item dropped/placeholder (no crash).
- Edge: old-shape cache (schemaVersion mismatch) → wiped, not mis-decoded.

**Verification:** wizard grid renders images from `path`; cache round-trips.

- [ ] **Unit 9: Explorer `Inspiration` model uses `path`**

**Goal:** Explorer feed builds its image URL from `path`.

**Requirements:** R2

**Dependencies:** Unit 7

**Files** (`HomeDecorAI`):
- Modify: `HomeDecorAI/Features/Explore/Models/Inspiration.swift` (`imageUrl: URL`→`path: String`; `displayURL` builds from `AWSService.url(forPath:)`; update `CodingKeys` + decode/encode)
- Test: update `HomeDecorAITests/.../InspirationTests.swift`

**Approach:** decode `path` as String; `displayURL` = `AWSService.url(forPath: path)`.
Removes the current `decode(URL.self,…)` + `rewriteToCDNIfPossible` round-trip.

**Test scenarios:**
- Happy path: decode doc with `path` → `displayURL` composes correct CloudFront URL.
- Edge: missing/empty `path` → row dropped or `displayURL == nil` handled by the feed.

**Verification:** Explore feed renders from `path`.

## System-Wide Impact

- **Interaction graph:** seed (CLI/HTTP) → Firestore `path` → {iOS tiles, Explore
  feed, backend AI reference-photo}. The AI provider fetch is the only
  security-sensitive consumer.
- **Error propagation:** invalid `path` rejected at seed time (schema); a doc that
  somehow holds a bad `path` → backend composes → `validatePublicImageUrl` rejects
  → `409 CONTENT_UNAVAILABLE` (same UX as today's missing-image branch).
- **State lifecycle risks:** iOS on-disk cache shape changes → **must** bump
  `ObjectInspirationCatalogCacheService` schema version or old caches mis-decode.
  Firestore migration must remove the old field so no doc carries both.
- **API surface parity:** both seed entry points (CLI + HTTP) and both flows
  (object + explorer) must rename together; Swagger DTOs included.
- **Integration coverage:** end-to-end Replace & Add Object enqueue must still send
  a working reference-photo URL to the provider (Unit 3 integration test).
- **Unchanged invariants:** image storage location, `outputImage*` URLs, prompt /
  searchTerms / title semantics, `active==true` rules predicate, the
  `validatePublicImageUrl` SSRF contract (now applied to the composed URL).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Old iOS build reads missing `imageUrl` → broken images | App not live; hard cutover ships iOS + migration together (accepted) |
| Composed backend URL bypasses SSRF if base mis-derived | Keep `validatePublicImageUrl` on the composed URL; base is env-trusted, `path` schema-validated |
| iOS cache serves stale URL-shaped rows post-upgrade | Bump cache `schemaVersion` (Unit 8) to force wipe |
| Manifest transform mangles a non-standard host row | Transform flags non-matching hosts instead of silently rewriting (Unit 5) |
| Backend deploys before iOS (or vice versa) | Coordinated single release; old field removed only after iOS reads `path` |
| `path` traversal / host smuggling via seed | Strict `PathSchema` (no scheme/slash-prefix/`..`/encoded traversal) at the edge |

## Documentation / Operational Notes

- Update `scripts/INSPIRATIONS-GUIDE.md` + `scripts/manifests/README.md` (Unit 6).
- Rollout order: (1) merge backend + iOS behind the same release window,
  (2) deploy backend, (3) run re-seed + field-cleanup migration, (4) release iOS.
- Post-migration check: spot-check a sample of `objectInspirations`,
  `objectCategories`, `inspirations` docs for `path` present and legacy field absent;
  smoke-test one Replace & Add Object generation end-to-end.

## Sources & References

- Backend schemas/types/seedShape/pipeline: `src/lib/objectInspiration/*`,
  `src/lib/inspiration/*`, `src/lib/tool-types.ts`, `src/services/generation-processor.ts`,
  `src/lib/storage/url-validation.ts`
- iOS base + models: `HomeDecorAI/Core/AWS/AWSService.swift`,
  `HomeDecorAI/Features/Wizard/Models/*`, `HomeDecorAI/Features/Explore/Models/Inspiration.swift`
- Seed docs: `scripts/INSPIRATIONS-GUIDE.md`, `scripts/manifests/README.md`
