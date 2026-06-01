# Seeding Guide — Object Inspiration & Explorer Inspiration

This directory holds the seed scripts and JSON manifests that populate the
two Firestore-backed content catalogs the app reads:

| Flow | Firestore collections | Powers (iOS) | Manifest shape |
|------|----------------------|--------------|----------------|
| **Object Inspiration** | `objectCategories`, `objectInspirations` | Replace & Add Object wizard (category grid → item grid) | `{ categories: [...], items: [...] }` |
| **Explorer Inspiration** | `inspirations` | Explore tab (room-photo inspiration feed) | flat array `[ {...}, {...} ]` |

Both are **admin/ops content pipelines**, not user-facing. Both validate every
row against the same Zod schemas the HTTP endpoints use, so a row that would be
rejected over HTTP is rejected by the CLI too.

> Deep object-inspiration operator runbook (image upload layout, soft/hard
> delete, audit logging): see [`manifests/README.md`](./manifests/README.md).

---

## Prerequisites

### Environment variables

| Var | Required | Used for |
|-----|----------|----------|
| `FIREBASE_SERVICE_ACCOUNT_KEY` | yes (backend) | Admin SDK credential the **HTTP server** uses |
| `GOOGLE_APPLICATION_CREDENTIALS` | yes (CLI) | Service-account JSON path the **seed scripts** use (or pass `--service-account=`) |
| `AWS_S3_BUCKET` | yes | Builds the image-URL allow-list (`<bucket>.s3[.<region>].amazonaws.com`) |
| `AWS_S3_REGION` | yes | Regional S3 host in the allow-list |
| `AWS_CLOUDFRONT_HOST` | recommended | CloudFront host in the allow-list. **If unset, every CloudFront `imageUrl` is rejected** — a boot warning is logged |

The allow-list is built in `src/lib/inspiration/schemas.ts` (`allowedInspirationHosts`)
and shared by both flows. Every `imageUrl` / `heroImageUrl` must be HTTPS, on a
default port, and match one of: the CloudFront host, `<bucket>.s3.amazonaws.com`,
or `<bucket>.s3.<region>.amazonaws.com`.

### Auth model

- **CLI scripts** write directly via the Firebase Admin SDK (service account).
  No HTTP call, no ID-token mint, no admin claim. This is the recommended path
  for bulk seeding.
- **HTTP endpoints** are guarded by `app.authenticate` — a **valid Firebase
  Bearer token**, identical to every other route. (There is no separate
  `admin: true` custom-claim gate today; the inline comments referencing one
  describe a possible future tightening, not current behavior.)

---

## Object Inspiration

Two-collection model. Categories are the wizard's entry grid (~40 tiles); items
(~800) reference a category via a soft FK (`categoryId`).

### Schema (row shapes)

Source of truth: `src/lib/objectInspiration/schemas.ts`.

**Category** (`objectCategories/{id}`)

```jsonc
{
  "id": "sofas",                  // ^[a-z][a-zA-Z]*$  (lowerCamelCase slug)
  "order": 0,                     // 0–10000
  "active": true,                 // optional, default true
  "title": { "en": "...", "tr": "...", /* +30 optional langs */ },
  "heroImageUrl": "https://<allow-listed-host>/...",
  "heroImageWidth": 1024,
  "heroImageHeight": 1024,
  "heroImageMime": "image/jpeg",  // optional, default image/jpeg
  "toolTypes": ["replaceObject", "addObject"]   // ≥1, from this set
}
```

**Item** (`objectInspirations/{id}`)

```jsonc
{
  "id": "sofas_1",                // ^[a-z][a-zA-Z]*_[0-9]+$
  "categoryId": "sofas",          // soft FK → objectCategories
  "order": 0,
  "active": true,
  "title": { "en": "...", "tr": "...", /* +30 optional langs */ },
  "prompt": "...",                // required, 1–500 chars (feeds the AI pipeline)
  "imageUrl": "https://<allow-listed-host>/...",
  "imageWidth": 1024,
  "imageHeight": 1024,
  "imageMime": "image/jpeg",      // optional
  "toolTypes": ["replaceObject", "addObject"],
  "searchTerms": { /* optional, see below */ }
}
```

**`title` — 32 languages.** `en` + `tr` are required; the other 30
(`ar, hy, zh-Hans, zh-Hant, hr, cs, da, nl, fi, fr, de, el, he, hu, id, it, ja,
ko, ms, nb, pl, pt, ro, ru, sk, es, sv, th, uk, vi`) are optional. Each value is
`trim().min(1).max(120)`. The schema is `.strict()` — an unknown locale key is
rejected. A missing translation degrades to English on iOS.

**`searchTerms` — optional, 32 languages, each independently optional.** Feeds
the iOS search matcher's literal-weight third channel (e.g. a TR user typing
`"kanepe"` matches a Koltuk item). Each language array: `max(10)` terms, each
`trim().min(1).max(40)`. `.strict()`.

```jsonc
"searchTerms": {
  "en": ["couch", "sectional", "corner sofa"],
  "tr": ["kanepe", "köşe koltuk"],
  "de": ["ecksofa"]
  // any subset of the 32 supported languages
}
```

> ⚠️ `searchTerms` is a merge field: a re-seed **replaces** the entire stored
> map. Omitting a language on re-seed **clears** it. Include the languages you
> want to keep.

### CLI

```bash
# npm alias (recommended)
npm run seed:object-inspirations -- \
  --manifest=scripts/manifests/object-inspirations.full.json

# or directly
tsx scripts/seed-object-inspirations.ts \
  --manifest=scripts/manifests/object-inspirations.full.json \
  --concurrency=5
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--manifest=<path>` | — (required) | Manifest JSON (`{categories, items}`) |
| `--service-account=<path>` | `$GOOGLE_APPLICATION_CREDENTIALS` | Firebase service account JSON |
| `--overwrite-prompts` | `false` | Sends `X-Seed-Mode: overwrite` semantics (replace `prompt` on re-seed) |
| `--dry-run` | `false` | Validate + FK-check only; no Firestore writes, no credentials needed |
| `--concurrency=<n>` | `5` | Parallel upsert workers |

Output: JSONL per-doc outcomes on stdout, human summary on stderr. Exit code `1`
if any row failed.

### HTTP endpoints

| Method · Path | Body | Notes |
|---------------|------|-------|
| `POST /api/object-inspirations/bulk-seed` | `{ categories?, items? }` (≥1; categories ≤200, items ≤5000) | Header `X-Seed-Mode: overwrite` to replace prompts |
| `POST /api/object-inspirations/bulk-update-titles` | `{ titleUpdates: [{ id, title }] }` (≤5000) | Patches `title` only; missing docs report `failed` (never creates) |

Response (200): `{ summary: {total, created, updated, skipped, failed}, outcomes: [{kind, id, status, reason?, ts}] }`.

### Upsert semantics (re-seed)

Each write is an idempotent upsert. On an existing doc:

- **Preserved by default:** `prompt`, `createdAt`.
- **Always propagated (overwritten):** `title`, `imageUrl`+dims+mime, `order`,
  `active`, `toolTypes`, `searchTerms`, `updatedAt`.
- **`--overwrite-prompts` / `X-Seed-Mode: overwrite`:** adds `prompt` to the
  overwritten set.
- `id` / `categoryId` / `createdAt` are never rewritten.

---

## Explorer Inspiration

Single-collection model (`inspirations`). Each doc is one room-photo inspiration
with a free-form taxonomy keyed by tool axis.

### Schema (row shape)

Source of truth: `src/lib/inspiration/schemas.ts`.

```jsonc
{
  "id": "interior_bathroom_coastal001",   // ID_PATTERN
  "kind": "roomPhoto",                     // optional, default "roomPhoto"
  "toolType": "interiorDesign",            // required enum
  "designStyle": "coastal",                // required enum
  "roomType": "bathroom",                  // optional axis (interior)
  "buildingType": null,                    // optional axis (exterior)
  "gardenStyle": null,                     // optional axis (garden)
  "patioStyle": null,
  "poolStyle": null,
  "outdoorLightingStyle": null,
  "colorPaletteId": null,                  // optional palette ref
  "tags": ["bathroom", "coastal"],         // optional, ≤20, each 1–40 chars
  "featured": false,                       // optional
  "imageUrl": "https://<allow-listed-host>/...",
  "imageWidth": 768,
  "imageHeight": 1376,
  "imageMime": "image/jpeg",               // optional
  "prompt": "..."                          // optional, 1–8000 chars
}
```

On write these flatten into the stored `InspirationDoc` whose `taxonomy`
sub-object groups `toolType / designStyle / tags / roomType / …`
(`src/lib/inspiration/types.ts`).

### CLI

No npm alias yet — invoke directly:

```bash
tsx scripts/seed-explore-inspirations.ts \
  --manifest=scripts/manifests/explore-inspirations.full.json \
  --concurrency=5
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--manifest=<path>` | — (required) | Manifest JSON (flat array of rows) |
| `--service-account=<path>` | `$GOOGLE_APPLICATION_CREDENTIALS` | Firebase service account JSON |
| `--dry-run` | `false` | Validate only; no writes |
| `--concurrency=<n>` | `5` | Parallel upsert workers |

There is **no** `--overwrite-prompts` flag — see prompt rule below.

### HTTP endpoints

| Method · Path | Body | Notes |
|---------------|------|-------|
| `POST /api/explore/inspirations` | single row | Returns `{id, created}`; `201` + `Location` when newly created |
| `POST /api/explore/inspirations/bulk-seed` | `{ items: [...] }` (1–2000) | All rows validated up front; any invalid row rejects the whole batch (400) |

Response (200, bulk): `{ summary: {total, created, updated, failed}, outcomes: [{id, status, reason?, ts}] }`.

### Upsert semantics (re-seed)

- **First write:** full doc written, `createdAt` stamped.
- **Re-seed (existing doc):** `schemaVersion, kind, taxonomy, imageUrl`+dims+mime,
  `featured, updatedAt` are overwritten.
- **`prompt` is preserve-on-existing:** written only when the doc is new *or* its
  stored prompt was previously empty. To change an already-set prompt, clear it
  first (or edit the doc directly). This is the explorer analog of the object
  flow's default prompt-preservation.

---

## Common workflow

```bash
# 1. Upload images to S3 so URLs resolve via the allow-listed host
rclone copy ./out/ myremote:$AWS_S3_BUCKET/in_app_images/ --s3-acl public-read

# 2. Compose / generate the manifest (match the schema above)

# 3. Dry-run — catches FK errors + schema typos, no credentials needed
tsx scripts/seed-object-inspirations.ts --manifest=<path> --dry-run

# 4. Seed for real
export GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/prod-sa.json
npm run seed:object-inspirations -- --manifest=<path>

# 5. Re-run anytime — upserts are idempotent (prompts preserved unless --overwrite-prompts)
```

---

## Manifest file reference

`scripts/manifests/`

| File | Flow | Contents |
|------|------|----------|
| `object-inspirations.full.json` | object | Production catalog (~40 categories × ~800 items) |
| `object-inspirations.initial.json` | object | Small pilot sample |
| `object-inspirations.categories-only.json` | object | Categories without items (partial-manifest workflow) |
| `object-inspirations.searchTerms.example.json` | object | Reference showing per-language `searchTerms` |
| `object-inspiration-titles.json` | object | Title-only payload for `/bulk-update-titles` |
| `object-inspiration-titles.example.json` | object | Single title-update example row |
| `object-inspirations.fix-broken-urls.json` | object | Example re-seed correcting image URLs |
| `explore-inspirations.full.json` | explore | Production explore catalog (~340 rows, flat array) |
| `explore-inspirations.bulk.json` | explore | Small explore sample |

---

## Troubleshooting

- **`host not allowed` (400 on every row):** `AWS_CLOUDFRONT_HOST` unset or the
  URL host doesn't match the allow-list. Check the boot warning.
- **`references unknown categoryId` (object):** the item's `categoryId` isn't in
  the manifest's `categories` and doesn't exist in Firestore. Seed the category
  first or include it in the same manifest.
- **Titles don't change per language on iOS:** the doc must carry that language
  in `title`. Re-seed with the missing translations — a missing locale falls
  back to English. (Simplified/Traditional Chinese also required an iOS-side
  resolver fix; ensure the app build includes it.)
- **`searchTerms` cleared after re-seed:** expected — it's a merge field that
  replaces the whole map. Include all languages you want to keep.
