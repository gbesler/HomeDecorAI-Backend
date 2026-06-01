import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractCategoryIds } from "./read-category-ids.js";

describe("extractCategoryIds", () => {
  it("reads category ids from categories[], sorted + deduped", () => {
    const raw = JSON.stringify({
      categories: [{ id: "sofas" }, { id: "beds" }, { id: "sofas" }],
      items: [],
    });
    assert.deepEqual(extractCategoryIds(raw), ["beds", "sofas"]);
  });

  it("falls back to distinct items[].categoryId when categories is empty", () => {
    const raw = JSON.stringify({
      categories: [],
      items: [
        { id: "sofas_1", categoryId: "sofas" },
        { id: "beds_2", categoryId: "beds" },
        { id: "sofas_3", categoryId: "sofas" },
      ],
    });
    assert.deepEqual(extractCategoryIds(raw), ["beds", "sofas"]);
  });

  it("prefers categories[] over items[] when both are present", () => {
    const raw = JSON.stringify({
      categories: [{ id: "lamps" }],
      items: [{ id: "sofas_1", categoryId: "sofas" }],
    });
    assert.deepEqual(extractCategoryIds(raw), ["lamps"]);
  });

  it("returns [] for an empty manifest object", () => {
    assert.deepEqual(extractCategoryIds("{}"), []);
  });

  it("ignores category entries lacking a string id, then falls back to items", () => {
    const raw = JSON.stringify({
      categories: [{ order: 0 }, { id: 42 }],
      items: [{ id: "x_1", categoryId: "x" }],
    });
    // No valid category ids → fallback to items.
    assert.deepEqual(extractCategoryIds(raw), ["x"]);
  });

  it("throws a descriptive error on invalid JSON", () => {
    assert.throws(
      () => extractCategoryIds("{ not json"),
      /Categories manifest is not valid JSON/,
    );
  });
});
