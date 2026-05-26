# Object Inspiration Seed Manifests

This directory holds the JSON manifests consumed by
`scripts/seed-object-inspirations.ts` to populate the
`objectCategories` and `objectInspirations` Firestore collections.

Each manifest is a single JSON document:

```json
{
  "categories": [ { "id": "sofas", "order": 0, ... } ],
  "items":      [ { "id": "sofas_1", "categoryId": "sofas", ... } ]
}
```

Row shapes match the zod schemas in
`src/lib/objectInspiration/schemas.ts` exactly — the seed script
imports those schemas directly, so any row that would be rejected by
the HTTP endpoint is rejected here too (allow-listed host, id regex,
prompt length, ...).

## Auth — Service account only

The seed script writes to Firestore via the Firebase Admin SDK using
a service account. It does NOT call the `POST /api/object-categories`
or `POST /api/object-inspirations` HTTP endpoints — those exist for
future admin-panel / Swagger usage and require an `admin: true`
custom claim on the caller's Firebase user. Bulk seed is an ops job,
not a user-facing operation, so it skips HTTP entirely.

You can supply the service account in two ways:

```bash
# Option A (recommended): standard Firebase / GCP env var
export GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/prod-sa.json

# Option B: explicit flag (useful when one terminal targets staging,
# another targets prod)
tsx scripts/seed-object-inspirations.ts \
  --service-account=/abs/path/to/prod-sa.json \
  --manifest=...
```

There is **no admin user setup, no ID token mint, no token rotation**.
The same service account the backend already uses
(`FIREBASE_SERVICE_ACCOUNT_KEY`) is what authorises the script.

## Operator runbook

### 1. Upload images to S3 (rclone)

Images must be public-readable via the env-configured CloudFront
distribution. Typical layout:

```
s3://$AWS_S3_BUCKET/object-inspirations/<categoryId>/<itemId>.jpg
s3://$AWS_S3_BUCKET/object-inspirations/<categoryId>/hero.jpg
```

```bash
rclone copy ./out/object-inspirations/ \
  myremote:$AWS_S3_BUCKET/object-inspirations/ \
  --s3-acl public-read --progress
```

CloudFront URLs in the manifest look like:

```
https://<AWS_CLOUDFRONT_HOST>/object-inspirations/sofas/sofas_1.jpg
```

Virtual-hosted bucket URLs are also accepted by the allow-list — both
forms pass validation.

### 2. Compose the manifest

Build the JSON manually or with a generator. Required minimum:

```jsonc
{
  "categories": [
    {
      "id": "sofas",
      "order": 0,
      "active": true,
      "title": { "en": "Sofas", "tr": "Koltuklar" },
      "heroImageUrl": "https://cdn.example.com/object-inspirations/sofas/hero.jpg",
      "heroImageWidth": 1200,
      "heroImageHeight": 800,
      "heroImageMime": "image/jpeg",
      "toolTypes": ["replaceObject", "addObject"]
    }
  ],
  "items": [
    {
      "id": "sofas_1",
      "categoryId": "sofas",
      "order": 0,
      "active": true,
      "title": { "en": "Sectional Sofa", "tr": "Köşe Koltuk" },
      "prompt": "A modern sectional sofa in a living room",
      "imageUrl": "https://cdn.example.com/object-inspirations/sofas/sofas_1.jpg",
      "imageWidth": 1024,
      "imageHeight": 1024,
      "imageMime": "image/jpeg",
      "toolTypes": ["replaceObject", "addObject"]
    }
  ]
}
```

### Optional: per-item `searchTerms`

Items may carry a per-language alternate-search vocabulary. Feeds the
iOS matcher's literal-weight third channel so a TR user typing
`"kanepe"` matches Koltuk items whose title noun does not contain that
word, with no iOS release needed to extend coverage.

```jsonc
{
  "id": "sofas_1",
  "categoryId": "sofas",
  ...
  "searchTerms": {
    "tr": ["kanepe", "divan", "sedir"],
    "en": ["couch", "settee", "loveseat"]
  }
}
```

- Field is **optional**: items without it fall back to title-only
  matching (today's behaviour). Both `en` and `tr` inside the object
  are independently optional.
- Bounds: max 10 terms per language, each term `trim().min(1).max(40)`.
- Multi-word terms (`"spiral candle"`) tokenise on whitespace —
  every subtoken becomes independently searchable. Prefer single-noun
  synonyms; multi-word terms with category-generic nouns can cause
  cross-category bleed (see brainstorm doc §4.6).
- Re-seed without the field **clears** an existing `searchTerms` on
  the doc (merge-field semantics, same as `title`).

Reference example: `scripts/manifests/object-inspirations.searchTerms.example.json`.

### 3. Dry-run validate

Catches FK errors (item references unknown category) and JSON-schema
typos without touching Firestore:

```bash
tsx scripts/seed-object-inspirations.ts \
  --manifest=scripts/manifests/object-inspirations.initial.json \
  --dry-run
```

Dry-run does not require credentials — it only parses + validates.

### 4. Run the seed

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/prod-sa.json

tsx scripts/seed-object-inspirations.ts \
  --manifest=scripts/manifests/object-inspirations.initial.json \
  --concurrency=5
```

Output is JSONL on stdout (one line per doc); the human-readable
summary is on stderr.

### 5. Re-runs & prompt overwrites

The backend treats each write as an idempotent upsert. Re-running with
the same manifest is safe — existing prompts are preserved by
default. To intentionally overwrite prompts (e.g. you fixed a typo
across many items):

```bash
tsx scripts/seed-object-inspirations.ts \
  --manifest=... --overwrite-prompts
```

Backend logs an audit line per overwrite (actor + doc id + ts; the
prompt text itself is never logged).

### 6. Soft / hard delete

These are one-off operations and DO go through the HTTP endpoints
(which require the `admin: true` custom claim). Out of scope for the
bulk-seed script.

```bash
# Soft delete (preferred)
curl -X PATCH "$API_BASE/object-inspirations/sofas_1" \
  -H "Authorization: Bearer $ADMIN_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"active": false}'

# Hard delete (irreversible — requires Confirm header)
curl -X DELETE "$API_BASE/object-inspirations/sofas_1" \
  -H "Authorization: Bearer $ADMIN_ID_TOKEN" \
  -H "Confirm: true"
```

Mint `ADMIN_ID_TOKEN` from a Firebase user whose UID was granted the
`admin: true` claim via `scripts/set-admin-claim.ts`.
