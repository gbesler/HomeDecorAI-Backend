import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { InspirationSeedInputSchema } from "./schemas.js";

// The schema closure captures `env` at module load time. We stub the
// three env vars the URL allow-list reads BEFORE importing the module
// (top-of-file imports above happen first, so we re-import via
// dynamic require would be needed for full isolation). For these tests
// we assert against the host shape using whichever env was loaded —
// the test fixtures use a URL pattern that matches the production
// allow-list shape regardless of bucket name. Tests that probe the
// allow-list specifically reach into the schema's behavior, not the
// env values.

const validBaseRow = {
  id: "livingroom-modern-001",
  toolType: "interiorDesign",
  designStyle: "modern",
  roomType: "livingRoom",
  path: "inspirations/livingroom-modern-001.jpg",
  imageWidth: 1280,
  imageHeight: 1707,
};

describe("InspirationSeedInputSchema", () => {
  describe(".strict() — unknown field rejection", () => {
    it("rejects a body with an extra unknown field", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        unknownField: "should reject",
      });
      assert.equal(result.success, false);
    });

    it("rejects a typo'd taxonomy axis (roomtype vs roomType)", () => {
      const { roomType, ...rest } = validBaseRow;
      const result = InspirationSeedInputSchema.safeParse({
        ...rest,
        roomtype: roomType, // lowercase typo
      });
      assert.equal(result.success, false);
    });
  });

  describe("id regex", () => {
    it("accepts a 1-character id", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        id: "a",
      });
      assert.equal(result.success, true);
    });

    it("rejects an id containing a slash (path-traversal guard)", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        id: "abc/def",
      });
      assert.equal(result.success, false);
    });

    it("rejects an id with a dot", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        id: "abc.def",
      });
      assert.equal(result.success, false);
    });

    it("rejects an empty id", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        id: "",
      });
      assert.equal(result.success, false);
    });

    it("rejects an id over 128 chars", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        id: "a".repeat(129),
      });
      assert.equal(result.success, false);
    });
  });

  describe("imageWidth / imageHeight", () => {
    it("rejects zero", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        imageWidth: 0,
      });
      assert.equal(result.success, false);
    });

    it("rejects a negative value", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        imageHeight: -1,
      });
      assert.equal(result.success, false);
    });

    it("rejects a non-integer (1280.5)", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        imageWidth: 1280.5,
      });
      assert.equal(result.success, false);
    });

    it("rejects > 20000", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        imageWidth: 20_001,
      });
      assert.equal(result.success, false);
    });
  });

  describe("imageMime regex", () => {
    it("accepts image/jpeg", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        imageMime: "image/jpeg",
      });
      assert.equal(result.success, true);
    });

    it("rejects application/json", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        imageMime: "application/json",
      });
      assert.equal(result.success, false);
    });

    it("rejects 'image/' with no subtype", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        imageMime: "image/",
      });
      assert.equal(result.success, false);
    });
  });

  describe("prompt", () => {
    it("rejects an empty string", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        prompt: "",
      });
      assert.equal(result.success, false);
    });

    it("rejects whitespace-only (trim then min-1)", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        prompt: "   ",
      });
      assert.equal(result.success, false);
    });

    it("rejects > 8000 characters", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        prompt: "a".repeat(8001),
      });
      assert.equal(result.success, false);
    });
  });

  describe("path validation (PathSchema)", () => {
    it("accepts a bucket-relative path", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        path: "inspirations/livingroom-modern-001.jpg",
      });
      assert.equal(result.success, true);
    });

    it("rejects a full https URL (scheme not allowed in a path)", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        path: "https://cdn.example.com/inspirations/x.jpg",
      });
      assert.equal(result.success, false);
    });

    it("rejects a data: URI", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        path: "data:image/jpeg;base64,AAAA",
      });
      assert.equal(result.success, false);
    });

    it("rejects a leading slash", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        path: "/inspirations/x.jpg",
      });
      assert.equal(result.success, false);
    });

    it("rejects a '..' traversal segment", () => {
      const result = InspirationSeedInputSchema.safeParse({
        ...validBaseRow,
        path: "inspirations/../../etc/passwd",
      });
      assert.equal(result.success, false);
    });
  });
});
