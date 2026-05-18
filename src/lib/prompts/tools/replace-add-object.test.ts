import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildReplaceAddObjectPrompt } from "./replace-add-object.js";

// `mode` and `inspirationTitle` are intentionally omitted from this
// shared fixture: every test in this file provides them explicitly so
// it exercises one specific branch. Moving them into `baseParams`
// would silently couple every test to one value and erase that intent.
//
// `prompt` is still set because zod's parsed `CreateReplaceAddObjectBody`
// requires it (min 1 char) — but it is unused by the v4.0 builder. The
// builder reads `inspirationTitle` for the `{category}` noun phrase.
// `prompt` is preserved on the wire shape for backward compatibility
// and analytics logging only.
const baseParams = {
  imageUrl: "https://example.com/room.jpg",
  maskUrl: "https://example.com/mask.png",
  prompt: "ignored by v4.0 builder",
  categoryId: "plants",
  inspirationId: "plants_14",
  inspirationImageUrl: "https://example.com/inspiration.jpg",
} as const;

describe("buildReplaceAddObjectPrompt — v4.0 metadata", () => {
  it("stamps the v4.0 promptVersion", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Cactus",
    });
    assert.equal(
      result.promptVersion,
      "replaceAddObject/v4.0-nano-banana-instructional",
    );
  });

  it("ships guidance=0 (sentinel — Nano Banana has no CFG knob)", () => {
    // Nano Banana's capability entry sets supportsGuidanceScale=false,
    // and the Replicate adapter drops the field when the capability
    // matrix says so. 0 here is the documented sentinel meaning "no
    // caller override required" — matches `callerGuidance > 0` logic
    // in src/lib/ai-providers/replicate.ts.
    const replace = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Cactus",
    });
    const add = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      inspirationTitle: "Cactus",
    });
    assert.equal(replace.guidanceScale, 0);
    assert.equal(add.guidanceScale, 0);
  });

  it("ships actionMode=transform, guidanceBand=faithful, empty positiveAvoidance", () => {
    // These three fields exist on PromptResult for telemetry / shared
    // metadata across tools. v4.0 preserves the v3.0 values so the
    // analytics-side cross-version comparison stays meaningful.
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Cactus",
    });
    assert.equal(result.actionMode, "transform");
    assert.equal(result.guidanceBand, "faithful");
    assert.equal(result.positiveAvoidance, "");
  });
});

describe("buildReplaceAddObjectPrompt — replace mode", () => {
  it("interpolates the inspirationTitle as the {category} noun", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Sectional Sofa",
    });
    assert.match(
      result.prompt,
      /replace the object inside the white region of image 3 .* with the Sectional Sofa shown in image 2/i,
    );
  });

  it("references image 1, image 2, and image 3 explicitly", () => {
    // Structural guard: the pipeline's `image_input` assembly order
    // (room, inspiration, mask) is mirrored by these three references
    // in the prompt. If the builder ever drops one, the model loses a
    // signal it needs to disambiguate the three inputs.
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Cactus",
    });
    assert.match(result.prompt, /\bimage 1\b/);
    assert.match(result.prompt, /\bimage 2\b/);
    assert.match(result.prompt, /\bimage 3\b/);
  });

  it("includes the mask-preservation clause", () => {
    // Best-effort signal to Gemini. The composite post-process step
    // (src/lib/generation/composite-masked-result.ts) is what actually
    // enforces outside-mask preservation, but the prompt clause
    // measurably reduces the diff Gemini introduces outside the mask
    // — fewer pixels for the composite to clobber, faster blends.
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Cactus",
    });
    assert.match(
      result.prompt,
      /keep every pixel outside the white region of image 3 unchanged/i,
    );
  });

  it("includes a 'photorealistic' output directive", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Cactus",
    });
    assert.match(result.prompt, /photorealistic/i);
  });

  it("documents image 3 as a binary mask (white = modify, black = preserve)", () => {
    // Mask convention echo. Repeated here AND in the prompt because
    // Gemini sometimes ignores conventions it has to infer from the
    // image alone — surfacing the convention in the instruction
    // measurably improves mask interpretation.
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Cactus",
    });
    assert.match(
      result.prompt,
      /binary mask, white = modify, black = preserve/i,
    );
  });
});

describe("buildReplaceAddObjectPrompt — add mode", () => {
  it("uses 'place … into' verb framing instead of 'replace … with'", () => {
    // Add mode targets blank wall/floor masks. Reusing the replace
    // verb here would push the model toward looking for an object
    // inside the mask to swap out — exactly the v3.0 add bug where
    // empty masks returned unchanged input or surrounding-texture
    // extension. The verb shift is the load-bearing semantic
    // difference between the two templates.
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      inspirationTitle: "Rattan Pendant",
    });
    assert.match(
      result.prompt,
      /place the Rattan Pendant shown in image 2 into the white region of image 3/i,
    );
    assert.doesNotMatch(result.prompt, /replace the object/i);
  });

  it("includes an explicit shadow directive", () => {
    // Add mode regression guard: blank-area placements need an
    // explicit "cast a shadow" directive because Gemini, like most
    // diffusion-derived models, treats the painted-on object as
    // sticker-flat unless told otherwise. Specific to add — replace
    // mode inherits shadow context from the object being replaced.
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      inspirationTitle: "Cactus",
    });
    assert.match(
      result.prompt,
      /cast a natural shadow appropriate to image 1's existing lighting/i,
    );
  });

  it("references image 1, image 2, and image 3 explicitly", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      inspirationTitle: "Cactus",
    });
    assert.match(result.prompt, /\bimage 1\b/);
    assert.match(result.prompt, /\bimage 2\b/);
    assert.match(result.prompt, /\bimage 3\b/);
  });

  it("includes the mask-preservation clause", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      inspirationTitle: "Cactus",
    });
    assert.match(
      result.prompt,
      /keep every pixel outside the white region of image 3 unchanged/i,
    );
  });
});

describe("buildReplaceAddObjectPrompt — bbox-aware (text-spatial)", () => {
  // The pipeline (multi-image-edit.ts) computes the brush mask's
  // white-pixel bounding box after normalize and re-calls this
  // builder with `{ maskBbox }`. The bbox path emits a
  // text-coordinate region descriptor instead of referring to
  // "image 3" — staging confirmed Nano Banana does not interpret
  // the third image_input slot as a semantic mask, so the bbox
  // text is the load-bearing spatial signal.
  const bbox = { left: 0.09, top: 0.64, right: 0.24, bottom: 0.89 };

  it("emits a bbox-aware replace prompt that names percent coords and drops 'image 3'", () => {
    const result = buildReplaceAddObjectPrompt(
      {
        ...baseParams,
        mode: "replace",
        inspirationTitle: "Pedestal Dining Table",
      },
      { maskBbox: bbox },
    );
    assert.match(
      result.prompt,
      /replacing the existing object inside the rectangular region of image 1 from \(left 9%, top 64%\) to \(right 24%, bottom 89%\) with the Pedestal Dining Table shown in image 2/i,
    );
    assert.doesNotMatch(result.prompt, /\bimage 3\b/i);
    assert.doesNotMatch(result.prompt, /white region/i);
  });

  it("emits a bbox-aware add prompt with 'place into' verb framing", () => {
    const result = buildReplaceAddObjectPrompt(
      {
        ...baseParams,
        mode: "add",
        inspirationTitle: "Rattan Pendant",
      },
      { maskBbox: bbox },
    );
    assert.match(
      result.prompt,
      /placing the Rattan Pendant shown in image 2 into the rectangular region of image 1 from \(left 9%, top 64%\) to \(right 24%, bottom 89%\)/i,
    );
    assert.doesNotMatch(result.prompt, /\bimage 3\b/i);
    assert.match(
      result.prompt,
      /cast a natural shadow appropriate to image 1's existing lighting/i,
    );
  });

  it("rounds bbox coordinates to whole percentage points", () => {
    // Sub-percent precision floats add token weight with no signal.
    const oddBbox = {
      left: 0.0834,
      top: 0.6421,
      right: 0.2401,
      bottom: 0.8888,
    };
    const result = buildReplaceAddObjectPrompt(
      { ...baseParams, mode: "replace", inspirationTitle: "Cactus" },
      { maskBbox: oddBbox },
    );
    assert.match(
      result.prompt,
      /\(left 8%, top 64%\) to \(right 24%, bottom 89%\)/,
    );
    // No decimal points in the percentage tokens.
    assert.doesNotMatch(result.prompt, /\d+\.\d+%/);
  });

  it("falls back to the image-3-as-mask template when maskBbox is null", () => {
    const result = buildReplaceAddObjectPrompt(
      { ...baseParams, mode: "replace", inspirationTitle: "Cactus" },
      { maskBbox: null },
    );
    assert.match(result.prompt, /\bimage 3\b/);
    assert.match(result.prompt, /white region of image 3/);
  });

  it("preserves the v4.0 promptVersion regardless of bbox presence", () => {
    const withBbox = buildReplaceAddObjectPrompt(
      { ...baseParams, mode: "replace", inspirationTitle: "Cactus" },
      { maskBbox: bbox },
    );
    const withoutBbox = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "Cactus",
    });
    assert.equal(withBbox.promptVersion, withoutBbox.promptVersion);
    assert.equal(
      withBbox.promptVersion,
      "replaceAddObject/v4.0-nano-banana-instructional",
    );
  });
});

describe("buildReplaceAddObjectPrompt — fallback when title is missing", () => {
  it("falls back to 'object' when inspirationTitle is undefined", () => {
    // Should be unreachable in production — preEnqueueValidate
    // 409-rejects any inspiration with an empty
    // `title.en || title.tr || prompt` chain. But the wire schema
    // marks the field optional (iOS doesn't send it), so the type
    // system can't enforce the populated invariant. Pin the
    // defensive default so a stray code path can't emit
    // `… with the undefined shown in image 2`.
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: undefined,
    });
    assert.match(result.prompt, /with the object shown in image 2/i);
    assert.doesNotMatch(result.prompt, /undefined/);
  });

  it("falls back to 'object' when inspirationTitle is empty / whitespace", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      inspirationTitle: "   ",
    });
    assert.match(result.prompt, /with the object shown in image 2/i);
  });
});

describe("manifest contract", () => {
  // One-shot sweep: pins the contract between the manifest and the
  // builder. Adding a manifest row whose `title.en` somehow breaks
  // the instructional template (control characters, runaway length,
  // empty post-trim) trips this test before it ships to Firestore.
  const manifestPath = new URL(
    "../../../../scripts/manifests/object-inspirations.full.json",
    import.meta.url,
  );
  const data = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    items: Array<{
      id: string;
      categoryId: string;
      title: { en: string; tr: string };
      prompt: string;
    }>;
  };

  // The 512-token cap from capabilities.ts for `google/nano-banana`.
  // The instructional templates are ~60 words long (~100 tokens),
  // so a passing sweep with hundreds of titles confirms the budget
  // is comfortable. Approximation: 1 token ≈ 4 chars (conservative
  // for English; Gemini's BPE is closer to 1:3.5 but 4 keeps us
  // safe). The check is on character count to avoid bringing in a
  // tokenizer dependency for the test runner.
  const MAX_PROMPT_TOKENS = 512;
  const APPROX_CHARS_PER_TOKEN = 4;
  const PROMPT_CHAR_BUDGET = MAX_PROMPT_TOKENS * APPROX_CHARS_PER_TOKEN;

  it("every seeded inspiration produces a valid replace prompt under the token budget", () => {
    assert.ok(data.items.length > 0, "manifest must contain items");
    for (const item of data.items) {
      const result = buildReplaceAddObjectPrompt({
        ...baseParams,
        mode: "replace",
        categoryId: item.categoryId,
        inspirationId: item.id,
        inspirationTitle: item.title.en,
      });
      assert.match(
        result.prompt,
        /\bimage 1\b.*\bimage 2\b.*\bimage 3\b/s,
        `${item.id} replace prompt missing image references: ${result.prompt.slice(0, 120)}`,
      );
      assert.ok(
        result.prompt.length < PROMPT_CHAR_BUDGET,
        `${item.id} replace prompt over budget (${result.prompt.length} chars): ${result.prompt.slice(0, 120)}`,
      );
      assert.ok(
        result.prompt.includes(item.title.en),
        `${item.id} replace prompt does not interpolate title.en (${item.title.en}): ${result.prompt.slice(0, 120)}`,
      );
    }
  });

  it("every seeded inspiration produces a valid add prompt under the token budget", () => {
    for (const item of data.items) {
      const result = buildReplaceAddObjectPrompt({
        ...baseParams,
        mode: "add",
        categoryId: item.categoryId,
        inspirationId: item.id,
        inspirationTitle: item.title.en,
      });
      assert.match(
        result.prompt,
        /\bimage 1\b.*\bimage 2\b.*\bimage 3\b/s,
        `${item.id} add prompt missing image references: ${result.prompt.slice(0, 120)}`,
      );
      assert.ok(
        result.prompt.length < PROMPT_CHAR_BUDGET,
        `${item.id} add prompt over budget (${result.prompt.length} chars): ${result.prompt.slice(0, 120)}`,
      );
      assert.ok(
        result.prompt.includes(item.title.en),
        `${item.id} add prompt does not interpolate title.en (${item.title.en}): ${result.prompt.slice(0, 120)}`,
      );
    }
  });

  it("never hardcodes a surface-specific anchor (regression guard from v2.2)", () => {
    // v2.1 originally shipped "placed on the floor" inside the add
    // wrapper, which was anatomically wrong for ~100 of 800 catalog
    // items (wall sconces, ceiling lights, wall art, pendants,
    // mirrors, curtains). v2.2 dropped the surface qualifier; v3.0
    // and v4.0 keep it absent. The builder has no per-category
    // metadata, so no future re-edit should accidentally
    // reintroduce a surface-specific token.
    for (const item of [
      {
        categoryId: "pendantLights",
        id: "pendantLights_1",
        title: "Rattan Pendant",
      },
      { categoryId: "wallArt", id: "wallArt_1", title: "Framed Print" },
      {
        categoryId: "ceilingLights",
        id: "ceilingLights_1",
        title: "Flush Mount Ceiling Light",
      },
      {
        categoryId: "wallSconces",
        id: "wallSconces_1",
        title: "Brass Wall Sconce",
      },
      { categoryId: "mirrors", id: "mirrors_1", title: "Arched Mirror" },
      { categoryId: "curtains", id: "curtains_1", title: "Linen Curtain" },
    ]) {
      const result = buildReplaceAddObjectPrompt({
        ...baseParams,
        mode: "add",
        categoryId: item.categoryId,
        inspirationId: item.id,
        inspirationTitle: item.title,
      });
      assert.doesNotMatch(
        result.prompt,
        /(?:placed?|hang(?:ing|s)?|mount(?:ed|ing|s)?)\s+on\s+the\s+(?:floor|wall|ceiling)/i,
        `${item.id}: add prompt must not hardcode a surface-specific anchor; got "${result.prompt.slice(0, 140)}"`,
      );
    }
  });

  it("never hardcodes 'the room' (regression guard from v3.0 outdoor-category bug)", () => {
    // v3.0's first draft hardcoded "interior photography" and "the
    // room" in the photography tail. Those tokens directly
    // contradicted the noun for the 80+ catalog items in
    // outdoorSeating / outdoorLighting / patio / garden (e.g. "an
    // outdoor sofa … matching the room"). v3.0 final + v4.0 collapse
    // to "image 1's lighting / perspective / scale" which is
    // room-neutral. Pin that no future re-edit reintroduces an
    // indoor-only token.
    //
    // The 'interior' token is allowed in test fixtures and code
    // comments but must NOT appear in the emitted prompt — this
    // test reaches into the prompt string itself.
    for (const item of [
      {
        categoryId: "outdoorSeating",
        id: "outdoorSeating_1",
        title: "Outdoor Sofa",
      },
      {
        categoryId: "outdoorLighting",
        id: "outdoorLighting_1",
        title: "Solar Lantern",
      },
      { categoryId: "patio", id: "patio_1", title: "Teak Patio Chair" },
    ]) {
      const replace = buildReplaceAddObjectPrompt({
        ...baseParams,
        mode: "replace",
        categoryId: item.categoryId,
        inspirationId: item.id,
        inspirationTitle: item.title,
      });
      const add = buildReplaceAddObjectPrompt({
        ...baseParams,
        mode: "add",
        categoryId: item.categoryId,
        inspirationId: item.id,
        inspirationTitle: item.title,
      });
      for (const result of [replace, add]) {
        assert.doesNotMatch(
          result.prompt,
          /\bthe room\b/i,
          `${item.id}: prompt must not hardcode 'the room'; got "${result.prompt.slice(0, 140)}"`,
        );
      }
    }
  });
});
