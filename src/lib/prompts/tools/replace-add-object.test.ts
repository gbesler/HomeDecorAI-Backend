import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReplaceAddObjectPrompt,
  normalizeInspirationNoun,
} from "./replace-add-object.js";

// Catalog rows ship the boilerplate template
// "A <noun> suitable for interior design placement."; the builder
// normalizes that, repairs the article, and wraps in mode-aware
// placement directives. The tests below pin both the normalization
// pipeline and the per-mode wrapper structure.
const baseParams = {
  imageUrl: "https://example.com/room.jpg",
  maskUrl: "https://example.com/mask.png",
  prompt: "A velvet sofa suitable for interior design placement.",
  categoryId: "sofas",
  inspirationId: "sofas_7",
  inspirationImageUrl: "https://example.com/inspiration.jpg",
  inspirationTitle: "Velvet Sofa",
} as const;

describe("normalizeInspirationNoun — v2.0 boilerplate stripping", () => {
  it("strips the seed-template suffix and trailing period", () => {
    assert.equal(
      normalizeInspirationNoun(
        "A velvet sofa suitable for interior design placement.",
      ),
      "a velvet sofa",
    );
  });

  it("repairs article on vowel-initial nouns", () => {
    assert.equal(
      normalizeInspirationNoun(
        "A arc floor lamp suitable for interior design placement.",
      ),
      "an arc floor lamp",
    );
  });

  it("repairs article on silent-h nouns", () => {
    assert.equal(
      normalizeInspirationNoun(
        "A hourglass side table suitable for interior design placement.",
      ),
      "an hourglass side table",
    );
  });

  it("keeps 'a' on consonant-initial nouns", () => {
    assert.equal(
      normalizeInspirationNoun(
        "A cactus suitable for interior design placement.",
      ),
      "a cactus",
    );
  });

  it("handles accented vowels", () => {
    assert.equal(
      normalizeInspirationNoun(
        "A étagère suitable for interior design placement.",
      ),
      "an étagère",
    );
  });

  it("preserves operator overrides without boilerplate suffix", () => {
    assert.equal(normalizeInspirationNoun("A pendant"), "a pendant");
  });
});

describe("buildReplaceAddObjectPrompt — v2.0 mode-aware Flux Fill", () => {
  it("stamps the v2.1 promptVersion", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
    });
    assert.equal(
      result.promptVersion,
      "replaceAddObject/v2.1-add-scene-integration",
    );
  });

  it("replace mode wraps with 'Completely replace ...' override directive", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
    });
    assert.match(result.prompt, /Completely replace the masked region/i);
    assert.match(result.prompt, /a velvet sofa/);
    assert.match(result.prompt, /Remove any existing object inside the mask/i);
  });

  it("replace mode ships REPLACE_GUIDANCE=75", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
    });
    assert.equal(result.guidanceScale, 75);
  });

  it("add mode wraps with 'Add ... inside the masked region' placement directive", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
    });
    assert.match(result.prompt, /Add a velvet sofa inside the masked region/i);
    assert.match(result.prompt, /masked area is currently empty/i);
  });

  it("add mode anchors scene integration (lighting, perspective, scale, contact shadows)", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
    });
    assert.match(
      result.prompt,
      /Match the surrounding room's lighting, perspective, and scale/i,
    );
    assert.match(result.prompt, /contact shadows/i);
    assert.match(result.prompt, /ambient occlusion/i);
  });

  it("add mode drops the v2.0 artificial-edge phrases ('sharp focus', 'clearly visible and well-lit')", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
    });
    assert.doesNotMatch(result.prompt, /sharp focus/i);
    assert.doesNotMatch(result.prompt, /clearly visible and well-lit/i);
  });

  it("add mode ships ADD_GUIDANCE=60 (drops from v2.0's 70 for scene integration headroom)", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
    });
    assert.equal(result.guidanceScale, 60);
  });

  it("emits distinct prompts for replace vs add modes", () => {
    const replaceResult = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
    });
    const addResult = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
    });
    assert.notEqual(replaceResult.prompt, addResult.prompt);
  });

  it("strips the boilerplate suffix from the noun inside the wrapper", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
    });
    assert.doesNotMatch(result.prompt, /suitable for interior design placement/i);
  });

  it("repairs vowel-initial article inside the wrapper", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      prompt: "A arc floor lamp suitable for interior design placement.",
      mode: "add",
    });
    assert.match(result.prompt, /Add an arc floor lamp/);
  });

  it("retains telemetry-friendly actionMode and guidanceBand fields", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
    });
    assert.equal(result.actionMode, "transform");
    assert.equal(result.guidanceBand, "faithful");
  });
});
