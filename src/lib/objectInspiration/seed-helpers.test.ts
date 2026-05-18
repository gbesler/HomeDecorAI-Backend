import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  dispatchWithConcurrency,
  parseManifestText,
  parseRows,
  parseTitleUpdateManifestText,
  parseTitleUpdateRows,
  summarize,
  validateForeignKeys,
  validateForeignKeysAsync,
  type Manifest,
  type SeedOutcome,
} from "./seed-helpers.js";
import type {
  ObjectCategorySeedInput,
  ObjectInspirationSeedInput,
} from "./schemas.js";

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

  it("accepts items-only manifest and defaults categories to []", () => {
    const m = parseManifestText('{"items":[]}');
    assert.deepEqual(m.categories, []);
    assert.deepEqual(m.items, []);
  });

  it("accepts categories-only manifest and defaults items to []", () => {
    const m = parseManifestText('{"categories":[]}');
    assert.deepEqual(m.categories, []);
    assert.deepEqual(m.items, []);
  });

  it("rejects manifest without categories or items", () => {
    assert.throws(() => parseManifestText("{}"));
  });

  it("rejects manifest with non-array categories", () => {
    assert.throws(() => parseManifestText('{"categories":{},"items":[]}'));
  });

  it("rejects manifest with non-array items", () => {
    assert.throws(() => parseManifestText('{"categories":[],"items":"x"}'));
  });

  it("rejects literal null JSON", () => {
    assert.throws(() => parseManifestText("null"));
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

  it("collects errors from multiple rows independently", () => {
    const broken: Manifest = {
      categories: [{ ...stubCategoryRow, id: "BAD_ID" }],
      items: [{ ...stubItemRow, id: "no-underscore" }],
    };
    const { errors, categories, items } = parseRows(broken);
    assert.equal(errors.length, 2);
    assert.equal(categories.length, 0);
    assert.equal(items.length, 0);
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

  it("reports one error per orphan when multiple", () => {
    const a: ObjectInspirationSeedInput = { ...stubItemRow, id: "a_1", categoryId: "a" };
    const b: ObjectInspirationSeedInput = { ...stubItemRow, id: "b_1", categoryId: "b" };
    const errs = validateForeignKeys([stubCategoryRow], [a, b]);
    assert.equal(errs.length, 2);
  });
});

describe("validateForeignKeysAsync", () => {
  it("returns empty when items reference categories in the payload", async () => {
    const errs = await validateForeignKeysAsync([stubCategoryRow], [stubItemRow]);
    assert.deepEqual(errs, []);
  });

  it("falls back to resolver when categoryId is missing from payload", async () => {
    const orphan: ObjectInspirationSeedInput = {
      ...stubItemRow,
      id: "ghost_1",
      categoryId: "ghost",
    };
    // Resolver says "ghost" exists in Firestore → no FK error.
    const errs = await validateForeignKeysAsync(
      [],
      [orphan],
      async (ids) => new Set(ids),
    );
    assert.deepEqual(errs, []);
  });

  it("reports orphans the resolver does not find", async () => {
    const orphan: ObjectInspirationSeedInput = {
      ...stubItemRow,
      id: "ghost_1",
      categoryId: "ghost",
    };
    const errs = await validateForeignKeysAsync(
      [],
      [orphan],
      async () => new Set<string>(),
    );
    assert.equal(errs.length, 1);
    assert.match(errs[0]!, /ghost_1/);
  });

  it("deduplicates orphan ids passed to the resolver", async () => {
    const a: ObjectInspirationSeedInput = { ...stubItemRow, id: "a_1", categoryId: "ghost" };
    const b: ObjectInspirationSeedInput = { ...stubItemRow, id: "b_1", categoryId: "ghost" };
    let resolverInputCount = -1;
    await validateForeignKeysAsync([], [a, b], async (ids) => {
      resolverInputCount = ids.length;
      return new Set(ids);
    });
    assert.equal(resolverInputCount, 1, "resolver should receive one deduped id");
  });

  it("skips resolver entirely when there are no orphans", async () => {
    let resolverCalled = false;
    const errs = await validateForeignKeysAsync(
      [stubCategoryRow],
      [stubItemRow],
      async () => {
        resolverCalled = true;
        return new Set<string>();
      },
    );
    assert.deepEqual(errs, []);
    assert.equal(resolverCalled, false);
  });

  it("treats a missing resolver as 'no fallback' (payload-only check)", async () => {
    const orphan: ObjectInspirationSeedInput = {
      ...stubItemRow,
      id: "ghost_1",
      categoryId: "ghost",
    };
    const errs = await validateForeignKeysAsync([], [orphan]);
    assert.equal(errs.length, 1);
    assert.match(errs[0]!, /ghost_1/);
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

  it("invokes onOutcome callback for every outcome in completion order", async () => {
    const seenIds: string[] = [];
    await dispatchWithConcurrency(
      [1, 2, 3],
      1,
      async (n) => ({
        kind: "item" as const,
        id: `id_${n}`,
        status: "created" as const,
        ts: "t",
      }),
      (o) => seenIds.push(o.id),
    );
    assert.deepEqual(seenIds, ["id_1", "id_2", "id_3"]);
  });

  it("swallows onOutcome exceptions so the pool completes the full batch", async () => {
    // A throwing callback must not orphan in-flight workers — the contract
    // is that all inputs produce outcomes regardless of observer behaviour.
    const outcomes = await dispatchWithConcurrency(
      [1, 2, 3],
      2,
      async (n) => ({
        kind: "item" as const,
        id: `id_${n}`,
        status: "created" as const,
        ts: "t",
      }),
      () => {
        throw new Error("observer blew up");
      },
    );
    assert.equal(outcomes.length, 3);
  });
});

describe("summarize", () => {
  it("returns all-zero summary for empty outcomes", () => {
    const summary = summarize([]);
    assert.deepEqual(summary, {
      total: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    });
  });

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

describe("parseTitleUpdateManifestText", () => {
  it("parses a valid `{ titleUpdates: [...] }` manifest", () => {
    const raw = JSON.stringify({
      titleUpdates: [
        { id: "sofas_1", title: { en: "X", tr: "Y" } },
      ],
    });
    const parsed = parseTitleUpdateManifestText(raw);
    assert.equal(parsed.titleUpdates.length, 1);
  });

  it("rejects non-JSON text", () => {
    assert.throws(() => parseTitleUpdateManifestText("not json"));
  });

  it("rejects manifests without a titleUpdates array", () => {
    assert.throws(() => parseTitleUpdateManifestText(JSON.stringify({})));
    assert.throws(() =>
      parseTitleUpdateManifestText(JSON.stringify({ titleUpdates: "x" })),
    );
  });
});

describe("parseTitleUpdateRows", () => {
  it("returns parsed rows when every row is valid", () => {
    const manifest = {
      titleUpdates: [
        { id: "sofas_1", title: { en: "Sofa", tr: "Koltuk" } },
        { id: "sofas_2", title: { en: "Loveseat", tr: "İkili" } },
      ],
    };
    const { updates, errors } = parseTitleUpdateRows(manifest);
    assert.equal(errors.length, 0);
    assert.equal(updates.length, 2);
  });

  it("collects per-row validation errors with the row id", () => {
    const manifest = {
      titleUpdates: [
        { id: "sofas_1", title: { en: "ok", tr: "ok" } },
        { id: "BAD_ID", title: { en: "x", tr: "y" } },
        { id: "sofas_3", title: { en: "x" } },
      ],
    };
    const { updates, errors } = parseTitleUpdateRows(manifest);
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.id, "sofas_1");
    assert.equal(errors.length, 2);
    assert.match(errors[0] ?? "", /BAD_ID/);
    assert.match(errors[1] ?? "", /sofas_3/);
  });

  it("rejects extra fields (mass-assignment defense)", () => {
    const manifest = {
      titleUpdates: [
        {
          id: "sofas_1",
          title: { en: "x", tr: "y" },
          prompt: "should not pass",
        },
      ],
    };
    const { updates, errors } = parseTitleUpdateRows(manifest);
    assert.equal(updates.length, 0);
    assert.equal(errors.length, 1);
  });

  it("flags duplicate ids inside the same manifest", () => {
    const manifest = {
      titleUpdates: [
        { id: "sofas_1", title: { en: "first", tr: "ilk" } },
        { id: "sofas_1", title: { en: "second", tr: "ikinci" } },
      ],
    };
    const { errors } = parseTitleUpdateRows(manifest);
    assert.ok(errors.some((e) => /more than once/.test(e)));
  });
});
