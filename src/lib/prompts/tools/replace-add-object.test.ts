import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReplaceAddObjectPrompt } from "./replace-add-object.js";

const baseParams = {
  imageUrl: "https://example.com/room.jpg",
  maskUrl: "https://example.com/mask.png",
  prompt: "ignored by v6.0 builder",
  categoryId: "diningTables",
  inspirationId: "diningTables_5",
  inspirationImageUrl: "https://example.com/inspiration.jpg",
} as const;

describe("buildReplaceAddObjectPrompt — v6.0 Kontext inpaint prompt", () => {
  it("stamps the v6.0 promptVersion", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Pedestal Dining Table",
    });
    assert.equal(
      result.promptVersion,
      "replaceAddObject/v6.0-kontext-inpaint",
    );
  });

  it("uses the inspirationTitle as the noun phrase in replace mode", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Pedestal Dining Table",
    });
    assert.match(result.prompt, /Pedestal Dining Table/);
  });

  it("uses the inspirationTitle as the noun phrase in add mode", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      inspirationTitle: "Floor Lamp",
    });
    assert.match(result.prompt, /Floor Lamp/);
  });

  it("emits a scene-level refine prompt with no image-1/2/3 references", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Pedestal Dining Table",
    });
    assert.doesNotMatch(result.prompt, /image 1/i);
    assert.doesNotMatch(result.prompt, /image 2/i);
    assert.doesNotMatch(result.prompt, /image 3/i);
  });

  it("does not embed bbox percentage coordinates", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Pedestal Dining Table",
    });
    assert.doesNotMatch(result.prompt, /left \d+%/i);
    assert.doesNotMatch(result.prompt, /rectangular region/i);
  });

  it("references lighting, shadows, and integration cues", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Pedestal Dining Table",
    });
    assert.match(result.prompt, /lighting/i);
    assert.match(result.prompt, /shadow/i);
    assert.match(result.prompt, /perspective/i);
  });

  it("falls back to 'object' when inspirationTitle is empty", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "",
    });
    assert.match(result.prompt, /\bobject\b/);
  });

  it("falls back to 'object' when inspirationTitle is whitespace-only", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      inspirationTitle: "   ",
    });
    assert.match(result.prompt, /\bobject\b/);
  });

  it("ships guidanceScale=0 sentinel (no caller override)", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Pedestal Dining Table",
    });
    assert.equal(result.guidanceScale, 0);
  });

  it("retains telemetry-friendly actionMode and guidanceBand fields", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Pedestal Dining Table",
    });
    assert.equal(result.actionMode, "transform");
    assert.equal(result.guidanceBand, "faithful");
  });

  it("emits distinct prompts for replace vs add modes", () => {
    const replaceResult = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Pedestal Dining Table",
    });
    const addResult = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      inspirationTitle: "Pedestal Dining Table",
    });
    assert.notEqual(replaceResult.prompt, addResult.prompt);
  });

  it("does not embed v4.x mask-as-image-3 phrasing", () => {
    const replaceResult = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Pedestal Dining Table",
    });
    assert.doesNotMatch(replaceResult.prompt, /white region/i);
    assert.doesNotMatch(replaceResult.prompt, /binary mask/i);
  });
});
