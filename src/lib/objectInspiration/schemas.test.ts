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
