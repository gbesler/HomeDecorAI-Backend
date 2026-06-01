# Inspirations — Usage Guide

A task-oriented guide for seeding and maintaining the two inspiration catalogs
the app reads from Firestore:

- **Object Inspiration** → the **Replace & Add Object** wizard (category grid →
  item grid). Stored in `objectCategories` + `objectInspirations`.
- **Explorer Inspiration** → the **Explore** tab room-photo feed. Stored in
  `inspirations`.

You drive both from the `scripts/` CLI tools. Every change is an **idempotent
upsert** — re-running is always safe.

> Looking for field-by-field schema detail or the image-upload runbook?
> See [`manifests/README.md`](./manifests/README.md). This guide is the
> "how do I do X" companion.

---

## "I want to…" → start here

| Goal | Go to |
|------|-------|
| Stand up a new object **category** with its items | [Add a category + items](#add-a-new-category-with-its-items) |
| Add more **items** to a category that already exists | [Add items only](#add-items-to-an-existing-category) |
| Fix a typo in many **prompts** at once | [Overwrite prompts](#fix-prompts-across-many-items) |
| Add or fix a **translation** without touching anything else | [Update titles only](#update-titles-only-add-a-language) |
| Add **search synonyms** (e.g. "kanepe" → Koltuk) | [Add search terms](#add-search-synonyms) |
| Hide an item/category from the app | [Take content down](#take-an-item-or-category-down) |
| Add room-photo inspirations to the **Explore tab** | [Seed explorer inspirations](#explorer-inspiration--tasks) |

---

## One-time setup

You need a Firebase **service account** JSON and the image-host env vars set:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/prod-sa.json
export AWS_S3_BUCKET=home-interior-ai-app
export AWS_S3_REGION=us-east-1
export AWS_CLOUDFRONT_HOST=cdn.yourdomain.com   # if you serve images via CloudFront
```

Why the AWS vars? Every `imageUrl` / `heroImageUrl` is checked against an
**allow-list** built from these. A URL on any other host is rejected. Allowed
forms:

```
https://<AWS_CLOUDFRONT_HOST>/...
https://<bucket>.s3.amazonaws.com/...
https://<bucket>.s3.<region>.amazonaws.com/...
```

> The seed CLI writes straight to Firestore with the service account — no login,
> no token, no admin panel. (The HTTP endpoints exist too and just need a normal
> Firebase Bearer token, but the CLI is the recommended path for bulk work.)

**Golden rule: always `--dry-run` first.** It validates every row and checks
that each item points at a real category — without writing anything, and without
needing credentials:

```bash
tsx scripts/seed-object-inspirations.ts --manifest=<your-file> --dry-run
```

---

## Object Inspiration — tasks

All object tasks use one manifest shape:

```json
{ "categories": [ … ], "items": [ … ] }
```

Both keys are optional — send only what you're changing.

### Add a new category with its items

1. Upload the images so their URLs resolve on the allow-listed host.
2. Write a manifest with the category **and** its items (items reference the
   category by `categoryId`):

```jsonc
{
  "categories": [
    {
      "id": "floorLamps",            // lowerCamelCase, matches the doc id
      "order": 20,
      "active": true,
      "title": { "en": "Floor Lamps", "tr": "Yer Lambaları" /* +optional langs */ },
      "heroImageUrl": "https://home-interior-ai-app.s3.us-east-1.amazonaws.com/in_app_images/01_Arc_Floor_Lamp.jpeg",
      "heroImageWidth": 1024,
      "heroImageHeight": 1024,
      "heroImageMime": "image/jpeg",
      "toolTypes": ["replaceObject", "addObject"]
    }
  ],
  "items": [
    {
      "id": "floorLamps_1",          // must be <categoryId>_<number>
      "categoryId": "floorLamps",
      "order": 0,
      "active": true,
      "title": { "en": "Arc Floor Lamp", "tr": "Yay Lambader" },
      "prompt": "A floor lamp with a long arcing arm and a graceful curved silhouette",
      "imageUrl": "https://home-interior-ai-app.s3.us-east-1.amazonaws.com/in_app_images/01_Arc_Floor_Lamp.jpeg",
      "imageWidth": 1024,
      "imageHeight": 1024,
      "imageMime": "image/jpeg",
      "toolTypes": ["replaceObject", "addObject"]
    }
  ]
}
```

3. Dry-run, then seed:

```bash
tsx scripts/seed-object-inspirations.ts --manifest=scripts/manifests/new-category.json --dry-run
npm run seed:object-inspirations -- --manifest=scripts/manifests/new-category.json
```

### Add items to an existing category

Send a manifest with **only** `items`. The category is already in Firestore, so
you don't need to re-send it — the foreign-key check falls back to a Firestore
lookup:

```json
{ "items": [ { "id": "floorLamps_2", "categoryId": "floorLamps", … } ] }
```

### Fix prompts across many items

By default a re-seed **preserves existing prompts** (so you can correct an image
or title without disturbing prompts). To intentionally replace prompts, add
`--overwrite-prompts`:

```bash
npm run seed:object-inspirations -- \
  --manifest=scripts/manifests/object-inspirations.full.json \
  --overwrite-prompts
```

### Update titles only (add a language)

Use the dedicated title path — it patches `title` and leaves
prompt/image/order/active untouched. It will **not** create new items (a missing
id reports `failed`).

Manifest (`{ titleUpdates: [...] }`):

```json
{
  "titleUpdates": [
    { "id": "sofas_1", "title": { "en": "Sectional Sofa", "tr": "Köşe Koltuk", "de": "Ecksofa" } }
  ]
}
```

Send it to `POST /api/object-inspirations/bulk-update-titles` (Bearer token), or
re-seed the full item rows with the new `title` via the normal seed (titles are
always overwritten on re-seed).

> `title` supports **32 languages** — `en` + `tr` are required, the other 30 are
> optional. A locale you omit falls back to English on the device.

### Add search synonyms

Put a `searchTerms` map on the item. It feeds the in-app search so a user typing
a synonym still finds the item, with no app release needed.

```jsonc
{
  "id": "sofas_1",
  "categoryId": "sofas",
  /* …all the normal item fields… */
  "searchTerms": {
    "tr": ["kanepe", "köşe koltuk", "oturma grubu"],
    "en": ["couch", "sectional", "corner sofa"],
    "de": ["ecksofa"]
    // any subset of the 32 supported languages — each one optional
  }
}
```

- Limits: ≤10 terms per language, each 1–40 chars.
- **Re-seeding replaces the whole map.** If you re-seed an item and drop a
  language from `searchTerms`, that language's terms are cleared. Include the
  ones you want to keep.

### Take an item or category down

Set `active: false` and re-seed that row (it's a normal field that's overwritten
on every seed). `active: false` hides it in the app **and** blocks reads at the
security-rules layer:

```json
{ "items": [ { "id": "sofas_1", "categoryId": "sofas", "active": false, /* other fields */ } ] }
```

To bring it back, re-seed with `active: true`.

---

## Explorer Inspiration — tasks

Explorer uses a **flat array** manifest (not `{categories, items}`):

```json
[ { "id": "…", "toolType": "…", "designStyle": "…", "imageUrl": "…", … } ]
```

### Seed explorer inspirations (bulk)

1. Compose the array — each row is one room photo with its taxonomy:

```jsonc
[
  {
    "id": "interior_bathroom_coastal001",
    "kind": "roomPhoto",
    "toolType": "interiorDesign",
    "designStyle": "coastal",
    "roomType": "bathroom",            // optional axis per tool
    "tags": ["bathroom", "coastal"],   // optional, ≤20
    "featured": false,
    "imageUrl": "https://home-interior-ai-app.s3.us-east-1.amazonaws.com/in_app_images/bathroom_coastal001.jpeg",
    "imageWidth": 768,
    "imageHeight": 1376,
    "imageMime": "image/jpeg",
    "prompt": "Use the provided empty bathroom image as the master reference. …"
  }
]
```

2. Dry-run, then seed:

```bash
tsx scripts/seed-explore-inspirations.ts --manifest=scripts/manifests/explore-inspirations.full.json --dry-run
tsx scripts/seed-explore-inspirations.ts --manifest=scripts/manifests/explore-inspirations.full.json
```

> There's no npm alias for the explorer script yet — call it with `tsx` directly.

### A note on explorer prompts

Unlike object items, explorer **preserves an existing prompt** on re-seed and
only writes a prompt when the doc is new or its stored prompt was empty. To
change an already-set prompt, clear it first (or edit the doc directly). There's
no `--overwrite-prompts` flag here.

---

## Reading the output

Both scripts print **one JSONL line per doc** to stdout and a human summary to
stderr:

```
{"kind":"item","id":"sofas_1","status":"created","ts":"…"}
{"kind":"item","id":"sofas_2","status":"updated","ts":"…"}
```

`status` is `created` / `updated` / `skipped` / `failed`. A non-zero exit code
means at least one row failed — check the `failed` lines for the `reason`, fix
the manifest, and re-run (upserts make re-runs safe).

---

## CLI flags at a glance

```bash
tsx scripts/seed-object-inspirations.ts \
  --manifest=<path>            # required: the JSON manifest
  [--overwrite-prompts]        # replace prompts on re-seed (object only)
  [--dry-run]                  # validate only, no writes, no creds needed
  [--concurrency=5]            # parallel workers
  [--service-account=<path>]   # or set GOOGLE_APPLICATION_CREDENTIALS

tsx scripts/seed-explore-inspirations.ts \
  --manifest=<path> [--dry-run] [--concurrency=5] [--service-account=<path>]
```

---

## Gotchas

- **`host not allowed`** → your `imageUrl` host isn't in the allow-list. Check
  `AWS_CLOUDFRONT_HOST` / `AWS_S3_BUCKET` / `AWS_S3_REGION`.
- **`references unknown categoryId`** (object) → the category isn't in your
  manifest and doesn't exist in Firestore yet. Seed the category first, or
  include it in the same file.
- **Titles don't switch language in the app** → that locale isn't in the doc's
  `title`. Re-seed with the missing translations; an omitted locale falls back
  to English. (Chinese 简体/繁體 also needed an iOS resolver fix — make sure the
  app build includes it.)
- **A language's search terms disappeared after a re-seed** → expected;
  `searchTerms` replaces the whole map on write. Include every language you want
  to keep.
- **You only updated 2 items but expected the whole catalog to change** → each
  row is independent. The other docs keep their old data until you re-seed them
  too.

---

## File map

| File | What it's for |
|------|---------------|
| `seed-object-inspirations.ts` | Object catalog seeder (`npm run seed:object-inspirations`) |
| `seed-explore-inspirations.ts` | Explorer catalog seeder (`tsx` direct) |
| `manifests/object-inspirations.full.json` | Production object catalog (~40 cat × ~800 items) |
| `manifests/explore-inspirations.full.json` | Production explorer catalog (~340 rows) |
| `manifests/*.example.json` | Copy-paste starting points |
| `manifests/README.md` | Field-by-field schema + image-upload runbook |
