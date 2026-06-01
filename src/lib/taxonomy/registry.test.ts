import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RoomType } from "../../schemas/generated/types/roomType.js";
import { DesignStyle } from "../../schemas/generated/types/designStyle.js";
import { GardenStyle } from "../../schemas/generated/types/gardenStyle.js";
import { ExteriorColorPalette } from "../../schemas/generated/types/exteriorColorPalette.js";
import { GardenColorPalette } from "../../schemas/generated/types/gardenColorPalette.js";
import { OBJECT_TOOL_TYPE_VALUES } from "../objectInspiration/types.js";
import {
  TAXONOMY_REGISTRY,
  TOOL_TYPE_KEYS,
  getAllowedValues,
  getAxes,
  isAllowedValue,
  type TaxonomyAxis,
} from "./registry.js";

describe("taxonomy registry", () => {
  describe("getAllowedValues — derived from canonical sources", () => {
    it("roomType equals Object.values(RoomType) (13 values)", () => {
      const values = getAllowedValues("roomType");
      assert.deepEqual([...values], Object.values(RoomType));
      assert.equal(values.length, 13);
    });

    it("designStyle has all 18 canonical values", () => {
      const values = getAllowedValues("designStyle");
      assert.deepEqual([...values], Object.values(DesignStyle));
      assert.equal(values.length, 18);
    });

    it("gardenStyle has 10 canonical values", () => {
      const values = getAllowedValues("gardenStyle");
      assert.deepEqual([...values], Object.values(GardenStyle));
      assert.equal(values.length, 10);
    });

    it("toolType equals the TOOL_TYPE_KEYS tuple (14 tools)", () => {
      const values = getAllowedValues("toolType");
      assert.deepEqual([...values], [...TOOL_TYPE_KEYS]);
      assert.equal(values.length, 14);
    });

    it("objectToolType mirrors OBJECT_TOOL_TYPE_VALUES", () => {
      const values = getAllowedValues("objectToolType");
      assert.deepEqual([...values], [...OBJECT_TOOL_TYPE_VALUES]);
    });

    it("colorPalette is the deduped union of exterior + garden palettes", () => {
      const values = getAllowedValues("colorPalette");
      const expected = [
        ...new Set([
          ...Object.values(ExteriorColorPalette),
          ...Object.values(GardenColorPalette),
        ]),
      ];
      assert.deepEqual([...values], expected);
      // No duplicates survived the union.
      assert.equal(new Set(values).size, values.length);
    });
  });

  describe("registry integrity", () => {
    it("every axis has a non-empty value set and a provenance source", () => {
      for (const axis of getAxes()) {
        const def = TAXONOMY_REGISTRY[axis];
        assert.equal(def.axis, axis, `axis key must match its definition: ${axis}`);
        assert.ok(def.values.length > 0, `axis ${axis} must have values`);
        assert.ok(
          def.source.length > 0,
          `axis ${axis} must declare a source`,
        );
      }
    });

    it("no axis contains empty or duplicate values", () => {
      for (const axis of getAxes()) {
        const values = getAllowedValues(axis);
        assert.ok(
          values.every((v) => typeof v === "string" && v.length > 0),
          `axis ${axis} has an empty value`,
        );
        assert.equal(
          new Set(values).size,
          values.length,
          `axis ${axis} has duplicate values`,
        );
      }
    });
  });

  describe("getAllowedValues — unknown axis", () => {
    it("throws loudly rather than returning undefined", () => {
      assert.throws(
        () => getAllowedValues("notAnAxis" as TaxonomyAxis),
        /Unknown taxonomy axis: notAnAxis/,
      );
    });
  });

  describe("isAllowedValue", () => {
    it("returns true for a member and false for a non-member", () => {
      assert.equal(isAllowedValue("roomType", "livingRoom"), true);
      assert.equal(isAllowedValue("roomType", "spaceStation"), false);
    });
  });
});
