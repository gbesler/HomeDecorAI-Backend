import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSeedDoc,
  planSeedWrite,
  INSPIRATION_UPSERT_MERGE_FIELDS,
  type InspirationSeedInput,
} from "./seedShape.js";

// Shared image stub — image fields land inline on the seed input. Tests
// spread it into each row so the per-test focus stays on the taxonomy /
// prompt mapping.
const stubImage = {
  path: "in_app_images/x.jpg",
  imageWidth: 1280,
  imageHeight: 1707,
  imageMime: "image/jpeg",
} as const;

describe("buildSeedDoc", () => {
  describe("envelope basics", () => {
    it("sets schemaVersion 1 and kind 'roomPhoto'", () => {
      const row: InspirationSeedInput = {
        id: "livingroom-modern-001",
        roomType: "livingRoom",
        designStyle: "modern",
        toolType: "interiorDesign",
        tags: ["modern"],
        featured: true,
        ...stubImage,
      };

      const doc = buildSeedDoc({ row });

      assert.equal(doc.schemaVersion, 1);
      assert.equal(doc.kind, "roomPhoto");
    });

    it("carries image metadata through unchanged", () => {
      const row: InspirationSeedInput = {
        id: "id-1",
        roomType: "livingRoom",
        designStyle: "modern",
        toolType: "interiorDesign",
        ...stubImage,
      };

      const doc = buildSeedDoc({ row });

      assert.equal(doc.path, stubImage.path);
      assert.equal(doc.imageWidth, 1280);
      assert.equal(doc.imageHeight, 1707);
      assert.equal(doc.imageMime, "image/jpeg");
    });

    it("defaults imageMime to 'image/jpeg' when omitted", () => {
      const row: InspirationSeedInput = {
        id: "id-1",
        roomType: "livingRoom",
        designStyle: "modern",
        toolType: "interiorDesign",
        path: stubImage.path,
        imageWidth: 1280,
        imageHeight: 1707,
      };

      const doc = buildSeedDoc({ row });

      assert.equal(doc.imageMime, "image/jpeg");
    });

    it("preserves featured=false when omitted from the row", () => {
      const row: InspirationSeedInput = {
        id: "id-1",
        roomType: "livingRoom",
        designStyle: "modern",
        toolType: "interiorDesign",
        ...stubImage,
      };

      const doc = buildSeedDoc({ row });

      assert.equal(doc.featured, false);
    });
  });

  describe("taxonomy mapping", () => {
    it("collapses interior flat fields into the nested taxonomy block", () => {
      const row: InspirationSeedInput = {
        id: "interior-1",
        roomType: "livingRoom",
        designStyle: "modern",
        toolType: "interiorDesign",
        tags: ["bright", "minimalist"],
        colorPaletteId: "warmTones",
        ...stubImage,
      };

      const doc = buildSeedDoc({ row });

      assert.equal(doc.taxonomy.toolType, "interiorDesign");
      assert.equal(doc.taxonomy.designStyle, "modern");
      assert.equal(doc.taxonomy.roomType, "livingRoom");
      assert.deepEqual(doc.taxonomy.tags, ["bright", "minimalist"]);
      assert.equal(doc.taxonomy.colorPaletteId, "warmTones");
      // Untouched axes write as null so a previously-populated value can
      // be cleared via re-seed.
      assert.equal(doc.taxonomy.buildingType, null);
      assert.equal(doc.taxonomy.gardenStyle, null);
    });

    it("preserves exterior buildingType while clearing roomType", () => {
      const row: InspirationSeedInput = {
        id: "exterior-1",
        designStyle: "modern",
        toolType: "exteriorDesign",
        buildingType: "house",
        ...stubImage,
      };

      const doc = buildSeedDoc({ row });

      assert.equal(doc.taxonomy.roomType, null);
      assert.equal(doc.taxonomy.buildingType, "house");
    });

    it("preserves garden/patio/pool/outdoor styles independently", () => {
      const exemplar = {
        gardenStyle: "tropical",
        patioStyle: "lounge",
        poolStyle: "infinity",
        outdoorLightingStyle: "warmAmbient",
      } as const;

      const cases: Array<[Partial<InspirationSeedInput>, keyof typeof exemplar]> = [
        [{ gardenStyle: "tropical", toolType: "gardenDesign" }, "gardenStyle"],
        [{ patioStyle: "lounge", toolType: "patioDesign" }, "patioStyle"],
        [{ poolStyle: "infinity", toolType: "poolDesign" }, "poolStyle"],
        [
          { outdoorLightingStyle: "warmAmbient", toolType: "outdoorLightingDesign" },
          "outdoorLightingStyle",
        ],
      ];

      for (const [overrides, expectedKey] of cases) {
        const row: InspirationSeedInput = {
          id: `${expectedKey}-1`,
          designStyle: "modern",
          toolType: "interiorDesign",
          ...stubImage,
          ...overrides,
        };
        const doc = buildSeedDoc({ row });
        assert.equal(
          doc.taxonomy[expectedKey],
          exemplar[expectedKey],
          `expected taxonomy.${expectedKey} to round-trip`,
        );
      }
    });

    it("normalises an empty-string axis to null", () => {
      // Some authoring clients export `"colorPaletteId": ""` rather than
      // omitting the field. The seeder must treat empty strings as
      // absent so the resulting Firestore doc round-trips identically
      // to a row that simply omitted the key.
      const row: InspirationSeedInput = {
        id: "id-1",
        roomType: "livingRoom",
        designStyle: "modern",
        toolType: "interiorDesign",
        colorPaletteId: "",
        ...stubImage,
      };

      const doc = buildSeedDoc({ row });

      assert.equal(doc.taxonomy.colorPaletteId, null);
    });

    it("defaults missing tags to []", () => {
      const row: InspirationSeedInput = {
        id: "id-1",
        roomType: "livingRoom",
        designStyle: "modern",
        toolType: "interiorDesign",
        ...stubImage,
      };

      const doc = buildSeedDoc({ row });

      assert.deepEqual(doc.taxonomy.tags, []);
    });
  });

  describe("prompt handling", () => {
    it("attaches a non-empty prompt verbatim", () => {
      const row: InspirationSeedInput = {
        id: "id-1",
        roomType: "livingRoom",
        designStyle: "modern",
        toolType: "interiorDesign",
        prompt: "Modern living room with warm minimalist palette",
        ...stubImage,
      };

      const doc = buildSeedDoc({ row });

      assert.equal(doc.prompt, "Modern living room with warm minimalist palette");
    });

    it("omits the prompt field entirely when undefined", () => {
      // Critical: the write helper spreads `buildSeedDoc(...)` into a
      // mergeFields write that excludes "prompt" from the merge list.
      // If we wrote `prompt: undefined` here the field would still be
      // overwritten on re-seed. Omitting the key preserves a
      // previously-written prompt across runs that lose the prompt
      // value.
      const row: InspirationSeedInput = {
        id: "id-1",
        roomType: "livingRoom",
        designStyle: "modern",
        toolType: "interiorDesign",
        ...stubImage,
      };

      const doc = buildSeedDoc({ row });

      assert.equal(Object.hasOwn(doc, "prompt"), false, "prompt key must be absent");
    });

    it("omits the prompt field when an empty/whitespace value is supplied", () => {
      const row: InspirationSeedInput = {
        id: "id-1",
        roomType: "livingRoom",
        designStyle: "modern",
        toolType: "interiorDesign",
        prompt: "   ",
        ...stubImage,
      };

      const doc = buildSeedDoc({ row });

      assert.equal(Object.hasOwn(doc, "prompt"), false);
    });
  });

  describe("id stability (favorites contract)", () => {
    it("does not write `id` into the doc payload", () => {
      // `id` becomes the Firestore document name, not a field. Writing
      // it as a body field would create a redundant copy and complicate
      // later admin edits.
      const row: InspirationSeedInput = {
        id: "livingroom-modern-001",
        roomType: "livingRoom",
        designStyle: "modern",
        toolType: "interiorDesign",
        ...stubImage,
      };

      const doc = buildSeedDoc({ row });

      assert.equal(Object.hasOwn(doc, "id"), false);
    });
  });
});

describe("planSeedWrite", () => {
  const baseRow: InspirationSeedInput = {
    id: "livingroom-modern-001",
    roomType: "livingRoom",
    designStyle: "modern",
    toolType: "interiorDesign",
    ...stubImage,
  };

  describe("new doc (first write)", () => {
    it("returns mergeFields=null so the executor does a full set()", () => {
      const plan = planSeedWrite(baseRow, { exists: false, prompt: null });
      assert.equal(plan.mergeFields, null);
      assert.equal(plan.created, true);
    });

    it("includes prompt in the first-write data when the row supplies one", () => {
      const plan = planSeedWrite(
        { ...baseRow, prompt: "Modern living room ..." },
        { exists: false, prompt: null },
      );
      assert.equal(plan.data["prompt"], "Modern living room ...");
    });

    it("omits prompt from first-write data when the row has none", () => {
      const plan = planSeedWrite(baseRow, { exists: false, prompt: null });
      assert.equal(Object.hasOwn(plan.data, "prompt"), false);
    });
  });

  describe("existing doc (re-seed)", () => {
    it("uses INSPIRATION_UPSERT_MERGE_FIELDS verbatim when no prompt is in play", () => {
      const plan = planSeedWrite(baseRow, {
        exists: true,
        prompt: null,
      });
      assert.deepEqual(plan.mergeFields, INSPIRATION_UPSERT_MERGE_FIELDS);
      assert.equal(plan.created, false);
      assert.equal(Object.hasOwn(plan.data, "prompt"), false);
    });

    it("first-time prompt: existing has none, row supplies one → prompt lands", () => {
      const plan = planSeedWrite(
        { ...baseRow, prompt: "Newly authored prompt" },
        { exists: true, prompt: null },
      );
      assert.equal(plan.data["prompt"], "Newly authored prompt");
      assert.ok(
        plan.mergeFields?.includes("prompt"),
        "mergeFields must include 'prompt' so the new prompt is written",
      );
    });

    it("preserves existing prompt when row supplies a different one", () => {
      // The load-bearing rule: a re-seed with a new prompt MUST NOT clobber
      // a curated prompt that's already on the document.
      const plan = planSeedWrite(
        { ...baseRow, prompt: "Attacker-supplied prompt" },
        { exists: true, prompt: "Existing curated prompt" },
      );
      assert.equal(Object.hasOwn(plan.data, "prompt"), false);
      assert.ok(
        !plan.mergeFields?.includes("prompt"),
        "mergeFields must NOT include 'prompt' so existing value is preserved",
      );
    });

    it("preserves existing prompt when row omits prompt", () => {
      const plan = planSeedWrite(baseRow, {
        exists: true,
        prompt: "Existing prompt",
      });
      assert.equal(Object.hasOwn(plan.data, "prompt"), false);
      assert.ok(!plan.mergeFields?.includes("prompt"));
    });

    it("treats whitespace-only prompt as no prompt (buildSeedDoc strips it)", () => {
      const plan = planSeedWrite(
        { ...baseRow, prompt: "   " },
        { exists: true, prompt: null },
      );
      assert.equal(Object.hasOwn(plan.data, "prompt"), false);
    });

    it("treats empty-string existing prompt as no prompt (allows new write)", () => {
      const plan = planSeedWrite(
        { ...baseRow, prompt: "New prompt" },
        { exists: true, prompt: "" },
      );
      assert.equal(plan.data["prompt"], "New prompt");
      assert.ok(plan.mergeFields?.includes("prompt"));
    });
  });
});
