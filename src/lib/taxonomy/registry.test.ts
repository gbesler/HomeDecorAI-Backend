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
    // Note: no hardcoded counts — the deepEqual against the canonical source
    // already proves both membership AND count, and stays correct when an enum
    // legitimately grows (which is the whole point of deriving the values).
    it("roomType equals Object.values(RoomType)", () => {
      const values = getAllowedValues("roomType");
      assert.deepEqual([...values], Object.values(RoomType));
    });

    it("designStyle equals Object.values(DesignStyle)", () => {
      const values = getAllowedValues("designStyle");
      assert.deepEqual([...values], Object.values(DesignStyle));
    });

    it("gardenStyle equals Object.values(GardenStyle)", () => {
      const values = getAllowedValues("gardenStyle");
      assert.deepEqual([...values], Object.values(GardenStyle));
    });

    it("toolType equals the TOOL_TYPE_KEYS tuple", () => {
      const values = getAllowedValues("toolType");
      assert.deepEqual([...values], [...TOOL_TYPE_KEYS]);
    });

    it("objectToolType mirrors OBJECT_TOOL_TYPE_VALUES", () => {
      const values = getAllowedValues("objectToolType");
      assert.deepEqual([...values], [...OBJECT_TOOL_TYPE_VALUES]);
    });

    it("colorPalette is the deduped, sorted union of exterior + garden palettes", () => {
      const values = getAllowedValues("colorPalette");
      const expected = [
        ...new Set([
          ...Object.values(ExteriorColorPalette),
          ...Object.values(GardenColorPalette),
        ]),
      ].sort();
      assert.deepEqual([...values], expected);
      // No duplicates survived the union.
      assert.equal(new Set(values).size, values.length);
      // "surpriseMe" exists in both palette sets — it must appear exactly once.
      assert.equal(values.filter((v) => v === "surpriseMe").length, 1);
    });
  });

  describe("TOOL_TYPE_KEYS order", () => {
    // The tool keys are spread into the Fastify/Swagger enum arrays consumed by
    // iOS, so their ORDER is a wire contract (the parity guard only checks the
    // SET). This locks the historically-shipped order.
    it("matches the historically-shipped explore tool order", () => {
      assert.deepEqual(
        [...TOOL_TYPE_KEYS],
        [
          "interiorDesign",
          "exteriorDesign",
          "gardenDesign",
          "patioDesign",
          "poolDesign",
          "referenceStyle",
          "replaceAddObject",
          "paintWalls",
          "floorRestyle",
          "virtualStaging",
          "cleanOrganize",
          "removeObjects",
          "exteriorPainting",
          "outdoorLightingDesign",
        ],
      );
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
