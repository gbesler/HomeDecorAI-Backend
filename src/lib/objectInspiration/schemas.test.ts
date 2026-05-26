import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ObjectCategorySeedInputSchema,
  ObjectInspirationSeedInputSchema,
  ObjectInspirationPatchSchema,
  ObjectInspirationTitleUpdateInputSchema,
  parseSeedMode,
} from "./schemas.js";

// The Explorer allow-list (reused here) reads `env.AWS_CLOUDFRONT_HOST`,
// `env.AWS_S3_BUCKET`, and `env.AWS_S3_REGION` lazily. The test process
// must set these before the first parse so the URL refinement has
// hostnames to compare against. Other backend test files follow the
// same pattern.
process.env["AWS_CLOUDFRONT_HOST"] ??= "cdn.test.local";
process.env["AWS_S3_BUCKET"] ??= "bucket";
process.env["AWS_S3_REGION"] ??= "us-east-1";

const validCategoryBody = {
  id: "sofas",
  order: 0,
  active: true,
  title: { en: "Sofas", tr: "Koltuklar" },
  heroImageUrl: "https://bucket.s3.us-east-1.amazonaws.com/h.jpg",
  heroImageWidth: 1200,
  heroImageHeight: 800,
  heroImageMime: "image/jpeg",
  toolTypes: ["replaceObject", "addObject"] as const,
};

const validItemBody = {
  id: "sofas_1",
  categoryId: "sofas",
  order: 0,
  active: true,
  title: { en: "Sectional Sofa", tr: "Köşe Koltuk" },
  prompt: "A sectional sofa for a modern living room.",
  imageUrl: "https://bucket.s3.us-east-1.amazonaws.com/sofas-1.jpg",
  imageWidth: 1024,
  imageHeight: 1024,
  imageMime: "image/jpeg",
  toolTypes: ["replaceObject", "addObject"] as const,
};

describe("ObjectCategorySeedInputSchema", () => {
  it("accepts a valid body", () => {
    const parsed = ObjectCategorySeedInputSchema.parse(validCategoryBody);
    assert.equal(parsed.id, "sofas");
    assert.deepEqual(parsed.toolTypes, ["replaceObject", "addObject"]);
  });

  it("defaults active=true when omitted", () => {
    const { active: _active, ...rest } = validCategoryBody;
    const parsed = ObjectCategorySeedInputSchema.parse(rest);
    assert.equal(parsed.active, true);
  });

  it("rejects category id with underscore (item-style)", () => {
    assert.throws(() =>
      ObjectCategorySeedInputSchema.parse({ ...validCategoryBody, id: "sofas_1" }),
    );
  });

  it("rejects empty toolTypes array", () => {
    assert.throws(() =>
      ObjectCategorySeedInputSchema.parse({ ...validCategoryBody, toolTypes: [] }),
    );
  });

  it("rejects unknown toolType value", () => {
    assert.throws(() =>
      ObjectCategorySeedInputSchema.parse({
        ...validCategoryBody,
        toolTypes: ["replaceObject", "paintWalls"],
      }),
    );
  });

  it("rejects extra top-level fields (strict)", () => {
    assert.throws(() =>
      ObjectCategorySeedInputSchema.parse({
        ...validCategoryBody,
        unexpected: "field",
      }),
    );
  });

  it("rejects non-allow-listed image hosts", () => {
    assert.throws(() =>
      ObjectCategorySeedInputSchema.parse({
        ...validCategoryBody,
        heroImageUrl: "https://attacker.example.com/h.jpg",
      }),
    );
  });

  it("rejects http:// (non-https)", () => {
    assert.throws(() =>
      ObjectCategorySeedInputSchema.parse({
        ...validCategoryBody,
        heroImageUrl: "http://bucket.s3.us-east-1.amazonaws.com/h.jpg",
      }),
    );
  });

  it("rejects empty title.tr", () => {
    assert.throws(() =>
      ObjectCategorySeedInputSchema.parse({
        ...validCategoryBody,
        title: { en: "Sofas", tr: "" },
      }),
    );
  });

  it("accepts title with optional locales alongside required en+tr", () => {
    const parsed = ObjectCategorySeedInputSchema.parse({
      ...validCategoryBody,
      title: {
        en: "Sofas",
        tr: "Koltuklar",
        de: "Sofas",
        ja: "ソファ",
        "zh-Hans": "沙发",
        ar: "أرائك",
      },
    });
    assert.equal(parsed.title.de, "Sofas");
    assert.equal(parsed.title.ja, "ソファ");
    assert.equal(parsed.title["zh-Hans"], "沙发");
    assert.equal(parsed.title.ar, "أرائك");
  });

  it("rejects title missing the required `tr` (en alone is not enough)", () => {
    assert.throws(() =>
      ObjectCategorySeedInputSchema.parse({
        ...validCategoryBody,
        title: { en: "Sofas" },
      }),
    );
  });

  it("rejects title with an unknown locale key (strict)", () => {
    assert.throws(() =>
      ObjectCategorySeedInputSchema.parse({
        ...validCategoryBody,
        title: { en: "Sofas", tr: "Koltuklar", xx: "bogus" },
      }),
    );
  });

  it("rejects empty optional-locale value (non-empty when present)", () => {
    assert.throws(() =>
      ObjectCategorySeedInputSchema.parse({
        ...validCategoryBody,
        title: { en: "Sofas", tr: "Koltuklar", de: "" },
      }),
    );
  });
});

describe("ObjectInspirationSeedInputSchema", () => {
  it("accepts a valid body", () => {
    const parsed = ObjectInspirationSeedInputSchema.parse(validItemBody);
    assert.equal(parsed.id, "sofas_1");
    assert.equal(parsed.categoryId, "sofas");
  });

  it("rejects item id without underscore (category-style)", () => {
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({ ...validItemBody, id: "sofas" }),
    );
  });

  it("rejects uppercase-leading id (UPPER_CASE)", () => {
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({ ...validItemBody, id: "Sofas_1" }),
    );
  });

  it("rejects prompt > 500 chars", () => {
    const tooLong = "x".repeat(501);
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({ ...validItemBody, prompt: tooLong }),
    );
  });

  it("accepts prompt min 1 char (quality lower bound)", () => {
    const parsed = ObjectInspirationSeedInputSchema.parse({
      ...validItemBody,
      prompt: "x",
    });
    assert.equal(parsed.prompt, "x");
  });

  it("rejects whitespace-only prompt (trim then min check)", () => {
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({ ...validItemBody, prompt: "   " }),
    );
  });

  it("rejects non-allow-listed imageUrl", () => {
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({
        ...validItemBody,
        imageUrl: "https://evil.example/x.jpg",
      }),
    );
  });

  it("accepts CloudFront host (env.AWS_CLOUDFRONT_HOST)", () => {
    const parsed = ObjectInspirationSeedInputSchema.parse({
      ...validItemBody,
      imageUrl: "https://cdn.test.local/sofas-1.jpg",
    });
    assert.equal(parsed.imageUrl, "https://cdn.test.local/sofas-1.jpg");
  });

  it("rejects port-suffixed URLs", () => {
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({
        ...validItemBody,
        imageUrl: "https://bucket.s3.us-east-1.amazonaws.com:9000/sofas-1.jpg",
      }),
    );
  });

  it("rejects unknown toolType value", () => {
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({
        ...validItemBody,
        toolTypes: ["replaceObject", "unknown"],
      }),
    );
  });

  // searchTerms — optional alternate-search vocabulary feeding the iOS
  // matcher's literal-weight third channel. Absence is the backward-
  // compat path; presence is opt-in. Both languages independently
  // optional inside the object, so a partial payload is legal.
  it("accepts a body without searchTerms (backward compat)", () => {
    const parsed = ObjectInspirationSeedInputSchema.parse(validItemBody);
    assert.equal(parsed.searchTerms, undefined);
  });

  it("accepts searchTerms with both en + tr arrays", () => {
    const parsed = ObjectInspirationSeedInputSchema.parse({
      ...validItemBody,
      searchTerms: {
        en: ["couch", "settee", "loveseat"],
        tr: ["kanepe", "divan", "sedir"],
      },
    });
    assert.deepEqual(parsed.searchTerms?.en, ["couch", "settee", "loveseat"]);
    assert.deepEqual(parsed.searchTerms?.tr, ["kanepe", "divan", "sedir"]);
  });

  it("rejects partial-language payload — en + tr are both required when searchTerms is present", () => {
    // Partial-language payload would silently erase the unspecified
    // language on Firestore re-seed (merge-field semantics replace
    // the entire `searchTerms` map). Both arrays must be present so
    // the clear-vs-preserve intent is explicit; an empty array
    // explicitly clears that language.
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({
        ...validItemBody,
        searchTerms: { en: ["couch"] },
      }),
    );
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({
        ...validItemBody,
        searchTerms: { tr: ["kanepe"] },
      }),
    );
  });

  it("accepts explicit empty array for one language", () => {
    // Explicit `[]` is the contract for "this language has no
    // alternate terms" — distinct from omitting the field entirely.
    const parsed = ObjectInspirationSeedInputSchema.parse({
      ...validItemBody,
      searchTerms: { en: ["couch"], tr: [] },
    });
    assert.deepEqual(parsed.searchTerms?.en, ["couch"]);
    assert.deepEqual(parsed.searchTerms?.tr, []);
  });

  it("accepts both arrays empty (treated as absent downstream)", () => {
    const parsed = ObjectInspirationSeedInputSchema.parse({
      ...validItemBody,
      searchTerms: { en: [], tr: [] },
    });
    assert.deepEqual(parsed.searchTerms?.en, []);
    assert.deepEqual(parsed.searchTerms?.tr, []);
  });

  it("trims and accepts terms at the 40-char boundary", () => {
    const at40 = "a".repeat(40);
    const parsed = ObjectInspirationSeedInputSchema.parse({
      ...validItemBody,
      searchTerms: { en: [`  ${at40}  `], tr: [] },
    });
    assert.deepEqual(parsed.searchTerms?.en, [at40]);
  });

  it("rejects a term longer than 40 chars after trim", () => {
    const at41 = "a".repeat(41);
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({
        ...validItemBody,
        searchTerms: { en: [at41], tr: [] },
      }),
    );
  });

  it("rejects empty-string / whitespace-only terms (trim then min(1))", () => {
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({
        ...validItemBody,
        searchTerms: { en: ["valid", ""], tr: [] },
      }),
    );
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({
        ...validItemBody,
        searchTerms: { en: [], tr: ["   "] },
      }),
    );
  });

  it("accepts exactly 10 terms in a language; rejects 11", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `term${i}`);
    const eleven = Array.from({ length: 11 }, (_, i) => `term${i}`);
    const parsed = ObjectInspirationSeedInputSchema.parse({
      ...validItemBody,
      searchTerms: { en: ten, tr: [] },
    });
    assert.equal(parsed.searchTerms?.en?.length, 10);
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({
        ...validItemBody,
        searchTerms: { en: eleven, tr: [] },
      }),
    );
  });

  it("rejects searchTerms with an unknown language key (strict)", () => {
    assert.throws(() =>
      ObjectInspirationSeedInputSchema.parse({
        ...validItemBody,
        searchTerms: { en: ["couch"], tr: [], fr: ["canapé"] },
      }),
    );
  });
});

describe("object-inspirations.searchTerms.example.json", () => {
  // Smoke test: keep the reference manifest in lockstep with the
  // schema. If a future contributor tightens a bound (e.g. drops the
  // term length to 30) the example file must update too — this test
  // would catch the drift before a runbook ships stale.
  it("each item parses through ObjectInspirationSeedInputSchema", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifestPath = path.resolve(
      here,
      "../../../scripts/manifests/object-inspirations.searchTerms.example.json",
    );
    const raw = await readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as { items: unknown[] };
    assert.ok(Array.isArray(parsed.items));
    assert.ok(parsed.items.length >= 1);
    for (const item of parsed.items) {
      const result = ObjectInspirationSeedInputSchema.safeParse(item);
      if (!result.success) {
        assert.fail(
          `example item failed schema validation: ${JSON.stringify(result.error.format())}`,
        );
      }
      // Every example item carries searchTerms (that's the whole
      // point of the reference file) — fail loudly if a future edit
      // drops the field.
      assert.ok(
        result.data.searchTerms !== undefined,
        `example item ${result.data.id} is missing searchTerms`,
      );
    }
  });
});

describe("ObjectInspirationPatchSchema", () => {
  it("accepts active-only patch", () => {
    const parsed = ObjectInspirationPatchSchema.parse({ active: false });
    assert.equal(parsed.active, false);
  });

  it("accepts order-only patch", () => {
    const parsed = ObjectInspirationPatchSchema.parse({ order: 42 });
    assert.equal(parsed.order, 42);
  });

  it("accepts both active and order", () => {
    const parsed = ObjectInspirationPatchSchema.parse({ active: true, order: 5 });
    assert.equal(parsed.active, true);
    assert.equal(parsed.order, 5);
  });

  it("rejects empty body", () => {
    assert.throws(() => ObjectInspirationPatchSchema.parse({}));
  });

  it("rejects non-whitelisted fields (strict)", () => {
    assert.throws(() =>
      ObjectInspirationPatchSchema.parse({ active: false, prompt: "evil" }),
    );
    assert.throws(() =>
      ObjectInspirationPatchSchema.parse({ imageUrl: "https://..." }),
    );
  });
});

describe("ObjectInspirationTitleUpdateInputSchema", () => {
  it("accepts a minimal id+title row", () => {
    const parsed = ObjectInspirationTitleUpdateInputSchema.parse({
      id: "sofas_1",
      title: { en: "Sectional", tr: "Köşe Koltuk" },
    });
    assert.equal(parsed.id, "sofas_1");
    assert.equal(parsed.title.en, "Sectional");
    assert.equal(parsed.title.tr, "Köşe Koltuk");
  });

  it("rejects extra fields (strict — mass-assignment defense)", () => {
    assert.throws(() =>
      ObjectInspirationTitleUpdateInputSchema.parse({
        id: "sofas_1",
        title: { en: "x", tr: "y" },
        prompt: "should not pass",
      }),
    );
    assert.throws(() =>
      ObjectInspirationTitleUpdateInputSchema.parse({
        id: "sofas_1",
        title: { en: "x", tr: "y" },
        active: false,
      }),
    );
  });

  it("rejects malformed id", () => {
    assert.throws(() =>
      ObjectInspirationTitleUpdateInputSchema.parse({
        id: "Sofas_1",
        title: { en: "x", tr: "y" },
      }),
    );
    assert.throws(() =>
      ObjectInspirationTitleUpdateInputSchema.parse({
        id: "sofas",
        title: { en: "x", tr: "y" },
      }),
    );
  });

  it("rejects empty or missing localized title fields", () => {
    assert.throws(() =>
      ObjectInspirationTitleUpdateInputSchema.parse({
        id: "sofas_1",
        title: { en: "", tr: "y" },
      }),
    );
    assert.throws(() =>
      ObjectInspirationTitleUpdateInputSchema.parse({
        id: "sofas_1",
        title: { en: "x" },
      }),
    );
  });

  it("accepts a title-update row with optional locales", () => {
    const parsed = ObjectInspirationTitleUpdateInputSchema.parse({
      id: "sofas_1",
      title: {
        en: "Sectional Sofa",
        tr: "Köşe Koltuk",
        de: "Ecksofa",
        fr: "Canapé d'Angle",
        ko: "섹셔널 소파",
      },
    });
    assert.equal(parsed.title.de, "Ecksofa");
    assert.equal(parsed.title.fr, "Canapé d'Angle");
    assert.equal(parsed.title.ko, "섹셔널 소파");
  });

  it("rejects title-update with unknown locale (strict)", () => {
    assert.throws(() =>
      ObjectInspirationTitleUpdateInputSchema.parse({
        id: "sofas_1",
        title: { en: "x", tr: "y", xx: "bogus" },
      }),
    );
  });
});

describe("parseSeedMode", () => {
  it("returns 'overwrite' for header value 'overwrite' (case-insensitive)", () => {
    assert.equal(parseSeedMode("overwrite"), "overwrite");
    assert.equal(parseSeedMode("OVERWRITE"), "overwrite");
    assert.equal(parseSeedMode("Overwrite"), "overwrite");
  });

  it("returns 'default' for missing / unknown header", () => {
    assert.equal(parseSeedMode(undefined), "default");
    assert.equal(parseSeedMode(""), "default");
    assert.equal(parseSeedMode("any"), "default");
    assert.equal(parseSeedMode(42), "default");
    assert.equal(parseSeedMode(null), "default");
  });
});
