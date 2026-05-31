import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildObjectCategoryDoc,
  buildObjectInspirationDoc,
  planObjectCategorySeedWrite,
  planObjectInspirationSeedWrite,
  OBJECT_CATEGORY_MERGE_FIELDS,
  OBJECT_INSPIRATION_DEFAULT_MERGE_FIELDS,
  OBJECT_INSPIRATION_OVERWRITE_MERGE_FIELDS,
  type ObjectCategorySeedInput,
  type ObjectInspirationSeedInput,
} from "./seedShape.js";

// S3 host literals match the test env's expected allow-list — the
// seed-shape unit tests bypass the zod refinement, so the URL string just
// needs to be a plausible https URL. The zod allow-list itself is
// covered in `schemas.test.ts`.
const stubHero = {
  heroImageUrl:
    "https://bucket.s3.us-east-1.amazonaws.com/object-inspirations/sofas-hero.jpg",
  heroImageWidth: 1200,
  heroImageHeight: 800,
  heroImageMime: "image/jpeg",
} as const;

const stubItemImage = {
  imageUrl:
    "https://bucket.s3.us-east-1.amazonaws.com/object-inspirations/sofas-1.jpg",
  imageWidth: 1024,
  imageHeight: 1024,
  imageMime: "image/jpeg",
} as const;

const sampleCategoryRow: ObjectCategorySeedInput = {
  id: "sofas",
  order: 0,
  active: true,
  title: { en: "Sofas", tr: "Koltuklar" },
  toolTypes: ["replaceObject", "addObject"],
  ...stubHero,
};

const sampleItemRow: ObjectInspirationSeedInput = {
  id: "sofas_1",
  categoryId: "sofas",
  order: 0,
  active: true,
  title: { en: "Sectional Sofa", tr: "Köşe Koltuk" },
  prompt: "A sectional sofa for a modern living room.",
  toolTypes: ["replaceObject", "addObject"],
  ...stubItemImage,
};

describe("buildObjectCategoryDoc", () => {
  it("sets schemaVersion 1 and copies fields verbatim", () => {
    const doc = buildObjectCategoryDoc(sampleCategoryRow);

    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.id, "sofas");
    assert.equal(doc.order, 0);
    assert.equal(doc.active, true);
    assert.deepEqual(doc.title, { en: "Sofas", tr: "Koltuklar" });
    assert.equal(doc.heroImageUrl, stubHero.heroImageUrl);
    assert.equal(doc.heroImageWidth, stubHero.heroImageWidth);
    assert.equal(doc.heroImageHeight, stubHero.heroImageHeight);
    assert.equal(doc.heroImageMime, "image/jpeg");
    assert.deepEqual(doc.toolTypes, ["replaceObject", "addObject"]);
  });

  it("defaults heroImageMime to 'image/jpeg' when omitted", () => {
    // The schema layer marks heroImageMime optional and the builder
    // applies the same default Explorer uses for `imageMime`. Drop the
    // field at the builder boundary to exercise the default branch.
    const { heroImageMime: _ignored, ...rest } = sampleCategoryRow;
    const doc = buildObjectCategoryDoc(rest as ObjectCategorySeedInput);
    assert.equal(doc.heroImageMime, "image/jpeg");
  });

  it("clones the title and toolTypes so mutating the input does not leak", () => {
    const row: ObjectCategorySeedInput = {
      ...sampleCategoryRow,
      title: { en: "A", tr: "B" },
      toolTypes: ["replaceObject"],
    };
    const doc = buildObjectCategoryDoc(row);
    row.title.en = "MUTATED";
    row.toolTypes.push("addObject");
    assert.equal(doc.title.en, "A");
    assert.deepEqual(doc.toolTypes, ["replaceObject"]);
  });

  it("carries optional-locale translations through to the Firestore doc", () => {
    const row: ObjectCategorySeedInput = {
      ...sampleCategoryRow,
      title: {
        en: "Sofas",
        tr: "Koltuklar",
        de: "Sofas",
        ja: "ソファ",
        "zh-Hans": "沙发",
      },
    };
    const doc = buildObjectCategoryDoc(row);
    assert.equal(doc.title.de, "Sofas");
    assert.equal(doc.title.ja, "ソファ");
    assert.equal(doc.title["zh-Hans"], "沙发");
    // Untouched optional locales stay absent — `Object.keys` is the
    // contract the merge-fields write uses.
    assert.equal(doc.title.fr, undefined);
  });
});

describe("buildObjectInspirationDoc", () => {
  it("sets schemaVersion 1 and carries all fields", () => {
    const doc = buildObjectInspirationDoc(sampleItemRow);

    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.id, "sofas_1");
    assert.equal(doc.categoryId, "sofas");
    assert.equal(doc.order, 0);
    assert.equal(doc.active, true);
    assert.deepEqual(doc.title, { en: "Sectional Sofa", tr: "Köşe Koltuk" });
    assert.equal(doc.prompt, "A sectional sofa for a modern living room.");
    assert.equal(doc.imageUrl, stubItemImage.imageUrl);
    assert.equal(doc.imageWidth, 1024);
    assert.equal(doc.imageHeight, 1024);
    assert.equal(doc.imageMime, "image/jpeg");
    assert.deepEqual(doc.toolTypes, ["replaceObject", "addObject"]);
  });

  it("defaults imageMime to 'image/jpeg' when omitted", () => {
    const { imageMime: _ignored, ...rest } = sampleItemRow;
    const doc = buildObjectInspirationDoc(rest as ObjectInspirationSeedInput);
    assert.equal(doc.imageMime, "image/jpeg");
  });

  // searchTerms projection — see `copySearchTerms` in seedShape.ts.
  // Empty arrays MUST omit the field (round-trip identical to absent)
  // so re-seeds don't write needless empty objects.
  it("omits searchTerms when the input field is absent", () => {
    const doc = buildObjectInspirationDoc(sampleItemRow);
    assert.equal(doc.searchTerms, undefined);
    assert.equal(
      Object.prototype.hasOwnProperty.call(doc, "searchTerms"),
      false,
    );
  });

  it("omits searchTerms when both language arrays are empty", () => {
    const doc = buildObjectInspirationDoc({
      ...sampleItemRow,
      searchTerms: { en: [], tr: [] },
    });
    assert.equal(doc.searchTerms, undefined);
    assert.equal(
      Object.prototype.hasOwnProperty.call(doc, "searchTerms"),
      false,
    );
  });

  it("copies a populated searchTerms map and clones arrays", () => {
    const row: ObjectInspirationSeedInput = {
      ...sampleItemRow,
      searchTerms: { en: ["couch", "settee"], tr: ["kanepe", "divan"] },
    };
    const doc = buildObjectInspirationDoc(row);
    assert.deepEqual(doc.searchTerms?.en, ["couch", "settee"]);
    assert.deepEqual(doc.searchTerms?.tr, ["kanepe", "divan"]);
    // Mutating the input must not leak into the projected doc.
    row.searchTerms!.en!.push("MUTATED");
    assert.deepEqual(doc.searchTerms?.en, ["couch", "settee"]);
  });

  it("drops empty language arrays from a partially-populated payload", () => {
    const doc = buildObjectInspirationDoc({
      ...sampleItemRow,
      searchTerms: { en: ["couch"], tr: [] },
    });
    assert.deepEqual(doc.searchTerms?.en, ["couch"]);
    assert.equal(doc.searchTerms?.tr, undefined);
  });

  it("copies non-en/tr supported languages", () => {
    const doc = buildObjectInspirationDoc({
      ...sampleItemRow,
      searchTerms: {
        de: ["sofa", "couch"],
        ja: ["ソファ"],
        "zh-Hans": ["沙发"],
      },
    });
    assert.deepEqual(doc.searchTerms?.de, ["sofa", "couch"]);
    assert.deepEqual(doc.searchTerms?.ja, ["ソファ"]);
    assert.deepEqual(doc.searchTerms?.["zh-Hans"], ["沙发"]);
    // en/tr absent from the input stay absent in the projection.
    assert.equal(doc.searchTerms?.en, undefined);
    assert.equal(doc.searchTerms?.tr, undefined);
  });
});

describe("OBJECT_INSPIRATION_DEFAULT_MERGE_FIELDS", () => {
  it("includes 'searchTerms' so re-seeds propagate the field", () => {
    assert.ok(OBJECT_INSPIRATION_DEFAULT_MERGE_FIELDS.includes("searchTerms"));
  });

  it("'searchTerms' is also inherited by the overwrite merge list", () => {
    assert.ok(
      OBJECT_INSPIRATION_OVERWRITE_MERGE_FIELDS.includes("searchTerms"),
    );
  });
});

describe("planObjectCategorySeedWrite", () => {
  it("first write: mergeFields=null, created=true, full payload", () => {
    const plan = planObjectCategorySeedWrite(sampleCategoryRow, { exists: false });
    assert.equal(plan.mergeFields, null);
    assert.equal(plan.created, true);
    assert.equal(plan.data.id, "sofas");
  });

  it("re-seed: mergeFields includes category whitelist, created=false", () => {
    const plan = planObjectCategorySeedWrite(sampleCategoryRow, { exists: true });
    assert.notEqual(plan.mergeFields, null);
    assert.equal(plan.created, false);
    // Sanity: the merge list propagates heroImage* + toolTypes + title
    // changes (a typo correction re-seed updates them) and never includes
    // createdAt.
    const fields = new Set(plan.mergeFields as readonly string[]);
    for (const expected of OBJECT_CATEGORY_MERGE_FIELDS) {
      assert.ok(fields.has(expected), `expected ${expected} in mergeFields`);
    }
    assert.ok(!fields.has("createdAt"), "createdAt must never be in mergeFields");
  });
});

describe("planObjectInspirationSeedWrite", () => {
  it("first write: mergeFields=null, created=true, full payload incl. prompt", () => {
    const plan = planObjectInspirationSeedWrite(sampleItemRow, {
      exists: false,
    });
    assert.equal(plan.mergeFields, null);
    assert.equal(plan.created, true);
    assert.equal(
      plan.data.prompt,
      "A sectional sofa for a modern living room.",
    );
  });

  it("re-seed default mode: prompt is preserved (not in mergeFields)", () => {
    const plan = planObjectInspirationSeedWrite(
      sampleItemRow,
      { exists: true },
      "default",
    );
    const fields = new Set(plan.mergeFields as readonly string[]);
    assert.ok(
      !fields.has("prompt"),
      "default mode must not include prompt in mergeFields",
    );
    // All non-prompt fields still propagate.
    assert.ok(fields.has("imageUrl"));
    assert.ok(fields.has("title"));
    assert.ok(fields.has("toolTypes"));
    assert.ok(fields.has("active"));
    assert.ok(fields.has("order"));
    assert.ok(fields.has("updatedAt"));
    assert.ok(!fields.has("createdAt"));
  });

  it("re-seed overwrite mode: prompt IS in mergeFields", () => {
    const plan = planObjectInspirationSeedWrite(
      sampleItemRow,
      { exists: true },
      "overwrite",
    );
    const fields = new Set(plan.mergeFields as readonly string[]);
    assert.ok(
      fields.has("prompt"),
      "overwrite mode must include prompt in mergeFields",
    );
    // Overwrite is a strict superset of default.
    for (const expected of OBJECT_INSPIRATION_DEFAULT_MERGE_FIELDS) {
      assert.ok(fields.has(expected), `expected ${expected} in mergeFields`);
    }
  });

  it("default mode is the implicit mode when omitted", () => {
    const planExplicit = planObjectInspirationSeedWrite(
      sampleItemRow,
      { exists: true },
      "default",
    );
    const planImplicit = planObjectInspirationSeedWrite(sampleItemRow, {
      exists: true,
    });
    assert.deepEqual(planImplicit.mergeFields, planExplicit.mergeFields);
  });

  it("OVERWRITE_MERGE_FIELDS is DEFAULT + prompt", () => {
    // Guard against accidental field drift in the constant — if a future
    // PR adds a propagated field to default and forgets the overwrite
    // constant, this catches it.
    const defaultSet = new Set(OBJECT_INSPIRATION_DEFAULT_MERGE_FIELDS);
    const overwriteSet = new Set(OBJECT_INSPIRATION_OVERWRITE_MERGE_FIELDS);
    for (const field of defaultSet) {
      assert.ok(overwriteSet.has(field));
    }
    assert.ok(overwriteSet.has("prompt"));
    assert.equal(overwriteSet.size, defaultSet.size + 1);
  });
});
