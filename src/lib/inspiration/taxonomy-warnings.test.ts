import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  collectTaxonomyWarnings,
  collectTaxonomyWarningsForRows,
  formatTaxonomyWarnings,
  type TaxonomyWarningInput,
} from "./taxonomy-warnings.js";

const baseRow: TaxonomyWarningInput = {
  id: "livingroom-modern-001",
  toolType: "interiorDesign",
  designStyle: "modern",
  roomType: "livingRoom",
};

describe("collectTaxonomyWarnings", () => {
  it("returns no warnings when all loose axes are valid", () => {
    const warnings = collectTaxonomyWarnings({
      ...baseRow,
      gardenStyle: "japanese",
      colorPaletteId: "surpriseMe",
    });
    assert.deepEqual(warnings, []);
  });

  it("warns on an out-of-set roomType but does NOT throw (soft)", () => {
    const warnings = collectTaxonomyWarnings({
      ...baseRow,
      roomType: "spaceStation",
    });
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0], {
      rowId: "livingroom-modern-001",
      field: "roomType",
      axis: "roomType",
      value: "spaceStation",
    });
  });

  it("emits no warning when an optional loose axis is absent or null", () => {
    assert.deepEqual(collectTaxonomyWarnings(baseRow), []);
    assert.deepEqual(
      collectTaxonomyWarnings({ ...baseRow, gardenStyle: null }),
      [],
    );
    assert.deepEqual(
      collectTaxonomyWarnings({ ...baseRow, gardenStyle: undefined }),
      [],
    );
  });

  it("collects one warning per invalid axis in the same row", () => {
    const warnings = collectTaxonomyWarnings({
      ...baseRow,
      roomType: "spaceStation",
      gardenStyle: "martian",
      colorPaletteId: "neonVoid",
    });
    assert.equal(warnings.length, 3);
    assert.deepEqual(
      warnings.map((w) => w.field).sort(),
      ["colorPaletteId", "gardenStyle", "roomType"],
    );
    // colorPaletteId maps to the registry "colorPalette" axis.
    const cp = warnings.find((w) => w.field === "colorPaletteId");
    assert.equal(cp?.axis, "colorPalette");
  });

  it("does not treat free-form tags as a closed set", () => {
    const warnings = collectTaxonomyWarnings({
      ...baseRow,
      tags: ["anythingGoes", "noSuchEnum"],
    });
    assert.deepEqual(warnings, []);
  });
});

describe("collectTaxonomyWarningsForRows", () => {
  it("aggregates warnings across rows preserving rowId", () => {
    const warnings = collectTaxonomyWarningsForRows([
      { ...baseRow, id: "a", roomType: "spaceStation" },
      { ...baseRow, id: "b" },
      { ...baseRow, id: "c", poolStyle: "lavaPool" },
    ]);
    assert.equal(warnings.length, 2);
    assert.deepEqual(
      warnings.map((w) => `${w.rowId}:${w.field}`).sort(),
      ["a:roomType", "c:poolStyle"],
    );
  });
});

describe("formatTaxonomyWarnings", () => {
  it("produces a human line per warning", () => {
    const lines = formatTaxonomyWarnings([
      {
        rowId: "a",
        field: "roomType",
        axis: "roomType",
        value: "spaceStation",
      },
    ]);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /a/);
    assert.match(lines[0]!, /roomType/);
    assert.match(lines[0]!, /spaceStation/);
  });

  it("returns an empty array for no warnings", () => {
    assert.deepEqual(formatTaxonomyWarnings([]), []);
  });
});
