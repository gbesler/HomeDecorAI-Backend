import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  collectObjectTaxonomyWarnings,
  formatObjectTaxonomyWarnings,
} from "./generation-guardrails.js";

const KNOWN = ["sofas", "beds", "candles"];

describe("collectObjectTaxonomyWarnings", () => {
  it("returns no warnings when categories and items all reference known categories", () => {
    const warnings = collectObjectTaxonomyWarnings(
      {
        categories: [{ id: "sofas" }],
        items: [
          { id: "sofas_1", categoryId: "sofas" },
          { id: "beds_2", categoryId: "beds" },
        ],
      },
      KNOWN,
    );
    assert.deepEqual(warnings, []);
  });

  it("flags a proposed category that does not exist in the known set (invented)", () => {
    const warnings = collectObjectTaxonomyWarnings(
      { categories: [{ id: "hoverboards" }] },
      KNOWN,
    );
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0], {
      kind: "new-category",
      subjectId: "hoverboards",
      categoryId: "hoverboards",
    });
  });

  it("flags an item referencing a category neither known nor proposed", () => {
    const warnings = collectObjectTaxonomyWarnings(
      { items: [{ id: "ghost_1", categoryId: "ghosts" }] },
      KNOWN,
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.kind, "item-unknown-category");
    assert.equal(warnings[0]?.subjectId, "ghost_1");
    assert.equal(warnings[0]?.categoryId, "ghosts");
  });

  it("does not double-report an item whose (new) category is in the same proposed batch", () => {
    // The new category is reported once; the item pointing at it is NOT also
    // reported as item-unknown-category (that orphan case is the hard FK's job).
    const warnings = collectObjectTaxonomyWarnings(
      {
        categories: [{ id: "lamps" }],
        items: [{ id: "lamps_1", categoryId: "lamps" }],
      },
      KNOWN,
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.kind, "new-category");
    assert.equal(warnings[0]?.categoryId, "lamps");
  });

  it("accepts a Set as the known-category source", () => {
    const warnings = collectObjectTaxonomyWarnings(
      { categories: [{ id: "sofas" }] },
      new Set(KNOWN),
    );
    assert.deepEqual(warnings, []);
  });

  it("treats empty proposed input as no warnings", () => {
    assert.deepEqual(collectObjectTaxonomyWarnings({}, KNOWN), []);
  });
});

describe("formatObjectTaxonomyWarnings", () => {
  it("produces a distinct line per warning kind", () => {
    const lines = formatObjectTaxonomyWarnings([
      { kind: "new-category", subjectId: "hoverboards", categoryId: "hoverboards" },
      { kind: "item-unknown-category", subjectId: "ghost_1", categoryId: "ghosts" },
    ]);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /hoverboards/);
    assert.match(lines[1]!, /ghost_1/);
    assert.match(lines[1]!, /ghosts/);
  });
});
