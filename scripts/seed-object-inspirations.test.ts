import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  dispatchWithConcurrency,
  parseManifestText,
  parseRows,
  summarize,
  validateForeignKeys,
  type Manifest,
  type SeedOutcome,
} from "./seed-object-inspirations.js";
import type {
  ObjectCategorySeedInput,
  ObjectInspirationSeedInput,
} from "../src/lib/objectInspiration/schemas.js";

const stubCategoryRow: ObjectCategorySeedInput = {
  id: "sofas",
  order: 0,
  active: true,
  title: { en: "Sofas", tr: "Koltuklar" },
  heroImageUrl: "https://bucket.s3.us-east-1.amazonaws.com/h.jpg",
  heroImageWidth: 1200,
  heroImageHeight: 800,
  heroImageMime: "image/jpeg",
  toolTypes: ["replaceObject", "addObject"],
};

const stubItemRow: ObjectInspirationSeedInput = {
  id: "sofas_1",
  categoryId: "sofas",
  order: 0,
  active: true,
  title: { en: "Sectional", tr: "Köşe" },
  prompt: "p",
  imageUrl: "https://bucket.s3.us-east-1.amazonaws.com/i.jpg",
  imageWidth: 1024,
  imageHeight: 1024,
  imageMime: "image/jpeg",
  toolTypes: ["replaceObject", "addObject"],
};

const stubManifest: Manifest = {
  categories: [stubCategoryRow],
  items: [stubItemRow],
};

describe("parseManifestText", () => {
  it("parses a valid manifest", () => {
    const m = parseManifestText(JSON.stringify(stubManifest));
    assert.equal(m.categories.length, 1);
    assert.equal(m.items.length, 1);
  });

  it("rejects non-JSON", () => {
    assert.throws(() => parseManifestText("not json"));
  });

  it("rejects manifest without categories array", () => {
    assert.throws(() => parseManifestText('{"items":[]}'));
  });

  it("rejects manifest without items array", () => {
    assert.throws(() => parseManifestText('{"categories":[]}'));
  });

  it("rejects manifest with non-array categories", () => {
    assert.throws(() => parseManifestText('{"categories":{},"items":[]}'));
  });
});

describe("parseRows", () => {
  it("validates and returns typed rows", () => {
    const { categories, items, errors } = parseRows(stubManifest);
    assert.equal(errors.length, 0);
    assert.equal(categories.length, 1);
    assert.equal(items.length, 1);
    assert.equal(categories[0]!.id, "sofas");
    assert.equal(items[0]!.id, "sofas_1");
  });

  it("collects errors for malformed category rows", () => {
    const broken: Manifest = {
      categories: [{ ...stubCategoryRow, id: "sofas_1" }], // category id with underscore is invalid
      items: [],
    };
    const { errors } = parseRows(broken);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /category id=sofas_1/);
  });

  it("collects errors for malformed item rows", () => {
    const broken: Manifest = {
      categories: [stubCategoryRow],
      items: [{ ...stubItemRow, prompt: "" }], // empty prompt fails zod min(1)
    };
    const { errors } = parseRows(broken);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /item id=sofas_1/);
  });
});

describe("validateForeignKeys", () => {
  it("returns empty for a valid FK chain", () => {
    assert.deepEqual(validateForeignKeys([stubCategoryRow], [stubItemRow]), []);
  });

  it("reports orphan item referencing unknown category", () => {
    const orphan: ObjectInspirationSeedInput = {
      ...stubItemRow,
      id: "ghost_1",
      categoryId: "ghost",
    };
    const errs = validateForeignKeys([stubCategoryRow], [orphan]);
    assert.equal(errs.length, 1);
    assert.match(errs[0]!, /ghost_1/);
    assert.match(errs[0]!, /ghost/);
  });
});

describe("dispatchWithConcurrency", () => {
  it("invokes the worker for every input and preserves outcomes", async () => {
    const inputs = [1, 2, 3, 4, 5];
    const seen: number[] = [];
    const outcomes = await dispatchWithConcurrency(inputs, 2, async (n) => {
      seen.push(n);
      return {
        kind: "item" as const,
        id: `id_${n}`,
        status: "created" as const,
        ts: "t",
      };
    });
    assert.equal(outcomes.length, inputs.length);
    assert.deepEqual(seen.slice().sort(), inputs.slice().sort());
  });

  it("clamps concurrency below 1 to a single worker", async () => {
    const outcomes = await dispatchWithConcurrency([1, 2], 0, async (n) => ({
      kind: "category" as const,
      id: `id_${n}`,
      status: "created" as const,
      ts: "t",
    }));
    assert.equal(outcomes.length, 2);
  });
});

describe("summarize", () => {
  it("counts each status bucket", () => {
    const outcomes: SeedOutcome[] = [
      { kind: "item", id: "a", status: "created", ts: "t" },
      { kind: "item", id: "b", status: "updated", ts: "t" },
      { kind: "item", id: "c", status: "skipped", ts: "t", reason: "dry-run" },
      { kind: "item", id: "d", status: "failed", ts: "t", reason: "boom" },
      { kind: "category", id: "e", status: "created", ts: "t" },
    ];
    const summary = summarize(outcomes);
    assert.deepEqual(summary, {
      total: 5,
      created: 2,
      updated: 1,
      skipped: 1,
      failed: 1,
    });
  });
});
