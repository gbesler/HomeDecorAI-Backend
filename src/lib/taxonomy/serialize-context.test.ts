import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RoomType } from "../../schemas/generated/types/roomType.js";
import { OBJECT_TOOL_TYPE_VALUES } from "../objectInspiration/types.js";
import {
  buildTaxonomyContext,
  serializeTaxonomyContext,
} from "./serialize-context.js";

const CATEGORIES = ["sofas", "beds", "candles"];

describe("buildTaxonomyContext", () => {
  it("includes explore axes with their values but NOT objectToolType", () => {
    const ctx = buildTaxonomyContext({ objectCategoryIds: CATEGORIES });
    const axisKeys = ctx.exploreAxes.map((a) => a.axis);
    assert.ok(axisKeys.includes("roomType"));
    assert.ok(axisKeys.includes("toolType"));
    assert.ok(axisKeys.includes("colorPalette"));
    assert.ok(
      !axisKeys.includes("objectToolType"),
      "objectToolType belongs under objectInspiration, not exploreAxes",
    );
  });

  it("roomType axis carries the canonical values", () => {
    const ctx = buildTaxonomyContext({ objectCategoryIds: CATEGORIES });
    const roomType = ctx.exploreAxes.find((a) => a.axis === "roomType");
    assert.deepEqual([...(roomType?.values ?? [])], Object.values(RoomType));
  });

  it("object section carries toolTypes and the supplied categories", () => {
    const ctx = buildTaxonomyContext({ objectCategoryIds: CATEGORIES });
    assert.deepEqual(
      [...ctx.objectInspiration.toolTypes],
      [...OBJECT_TOOL_TYPE_VALUES],
    );
    assert.deepEqual([...ctx.objectInspiration.categories], CATEGORIES);
  });

  it("carries an explicit no-invented-values instruction", () => {
    const ctx = buildTaxonomyContext({ objectCategoryIds: [] });
    assert.match(ctx.instruction, /only/i);
    assert.match(ctx.instruction, /never invent/i);
  });
});

describe("serializeTaxonomyContext", () => {
  it("emits valid JSON that round-trips to the data object", () => {
    const { data, json } = serializeTaxonomyContext({
      objectCategoryIds: CATEGORIES,
    });
    assert.deepEqual(JSON.parse(json), data);
  });

  it("emits markdown with a section per axis and the object categories", () => {
    const { markdown } = serializeTaxonomyContext({
      objectCategoryIds: CATEGORIES,
    });
    assert.match(markdown, /# Allowed taxonomy values/);
    assert.match(markdown, /Room Type/);
    assert.match(markdown, /livingRoom/);
    assert.match(markdown, /## Object inspiration/);
    assert.match(markdown, /sofas/);
  });

  it("handles an empty object category set without throwing", () => {
    const { data, markdown } = serializeTaxonomyContext({
      objectCategoryIds: [],
    });
    assert.deepEqual([...data.objectInspiration.categories], []);
    assert.match(markdown, /none provided/);
  });
});
