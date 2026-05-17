import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildReplaceAddObjectPrompt,
  normalizeInspirationNoun,
} from "./replace-add-object.js";

// `mode` and `prompt` are intentionally omitted from this shared
// fixture: every test in this file provides them explicitly so it
// exercises one specific branch (mode=replace vs mode=add, seeded
// noun vs operator-supplied). Moving them into `baseParams` would
// silently couple every test to one value and erase that intent.
const baseParams = {
  imageUrl: "https://example.com/room.jpg",
  maskUrl: "https://example.com/mask.png",
  categoryId: "plants",
  inspirationId: "plants_14",
} as const;

describe("normalizeInspirationNoun", () => {
  it("strips seed-template suffix and keeps consonant-initial 'a'", () => {
    assert.equal(
      normalizeInspirationNoun(
        "A cactus suitable for interior design placement.",
      ),
      "a cactus",
    );
  });

  it("repairs the article before vowel-initial nouns", () => {
    assert.equal(
      normalizeInspirationNoun(
        "A arc floor lamp suitable for interior design placement.",
      ),
      "an arc floor lamp",
    );
    assert.equal(
      normalizeInspirationNoun(
        "A outdoor pillow suitable for interior design placement.",
      ),
      "an outdoor pillow",
    );
  });

  it("treats silent-h prefixes as vowel-sound", () => {
    // hourglass is the only silent-h noun in the current seed catalog;
    // honest/heir/honor/herb are guarded defensively. The heuristic
    // matches the prefix without word boundary, so compounds count.
    assert.equal(
      normalizeInspirationNoun(
        "A hourglass side table suitable for interior design placement.",
      ),
      "an hourglass side table",
    );
    assert.equal(
      normalizeInspirationNoun(
        "A heirloom dresser suitable for interior design placement.",
      ),
      "an heirloom dresser",
    );
  });

  it("uses 'an' before accented-vowel-initial nouns", () => {
    assert.equal(
      normalizeInspirationNoun(
        "A étagère suitable for interior design placement.",
      ),
      "an étagère",
    );
  });

  it("keeps 'a' for consonant-initial nouns even when later letters are accented", () => {
    assert.equal(
      normalizeInspirationNoun(
        "A bouclé sofa suitable for interior design placement.",
      ),
      "a bouclé sofa",
    );
    assert.equal(
      normalizeInspirationNoun(
        "A café curtains suitable for interior design placement.",
      ),
      "a café curtains",
    );
  });

  it("keeps 'a' for aspirated-h nouns", () => {
    assert.equal(
      normalizeInspirationNoun(
        "A hammock suitable for interior design placement.",
      ),
      "a hammock",
    );
    assert.equal(
      normalizeInspirationNoun(
        "A herman miller chair suitable for interior design placement.",
      ),
      "a herman miller chair",
    );
  });

  it("passes operator-supplied prompts that lack the seed suffix", () => {
    assert.equal(normalizeInspirationNoun("A pendant"), "a pendant");
    assert.equal(normalizeInspirationNoun("pendant"), "pendant");
    assert.equal(
      normalizeInspirationNoun("An ottoman"),
      "an ottoman",
    );
  });

  it("does not strip 'suitable for' that appears mid-sentence", () => {
    assert.equal(
      normalizeInspirationNoun("A lamp suitable for outdoor use."),
      "a lamp suitable for outdoor use",
    );
  });
});

describe("buildReplaceAddObjectPrompt — replace mode", () => {
  it("emits the v3.0 bare-caption replace prompt for the seeded cactus", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      prompt: "A cactus suitable for interior design placement.",
    });
    assert.equal(
      result.prompt,
      "a cactus, photorealistic interior photography, natural lighting matching the room",
    );
    assert.equal(
      result.promptVersion,
      "replaceAddObject/v3.0-fluxfill-bare-caption",
    );
    // BFL HF sample guidance. Same value for both modes in v3.0; the
    // v2.0 per-mode split (75/70) was tuned on intuition and pushed
    // the model into image-conditioning territory where it ignored
    // the text prompt.
    assert.equal(result.guidanceScale, 30);
    assert.equal(result.actionMode, "transform");
    assert.equal(result.guidanceBand, "faithful");
    assert.equal(result.positiveAvoidance, "");
  });

  it("uses 'an' for vowel-initial nouns", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      prompt: "A arc floor lamp suitable for interior design placement.",
    });
    assert.equal(
      result.prompt,
      "an arc floor lamp, photorealistic interior photography, natural lighting matching the room",
    );
  });

  it("uses 'an' for silent-h nouns", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      prompt: "A hourglass side table suitable for interior design placement.",
    });
    assert.match(result.prompt, /^an hourglass side table, /);
  });

  it("passes operator-supplied bare nouns through normalize unchanged", () => {
    // Operator override path: no seed suffix and no leading article.
    // The bare-caption format consumes whatever normalize emits, so
    // "pendant" arrives at Flux Fill as-is, without a synthesized
    // article. Flux Fill handles bare-noun captions fine ("white paper
    // cup" is the BFL HF sample), so we don't synthesize an article
    // for operator overrides.
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      prompt: "pendant",
    });
    assert.equal(
      result.prompt,
      "pendant, photorealistic interior photography, natural lighting matching the room",
    );
  });

  it("preserves a pre-articled operator-supplied noun (no seed suffix)", () => {
    // "An ottoman" arriving without the seed boilerplate must survive
    // normalize's article repair (it already has "an" and the noun is
    // vowel-initial, so normalize returns it unchanged) and reach the
    // caption as "an ottoman, ...".
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      prompt: "An ottoman",
    });
    assert.match(result.prompt, /^an ottoman, /);
  });
});

describe("buildReplaceAddObjectPrompt — add mode", () => {
  it("emits the v3.0 bare-caption add prompt for the seeded cactus", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      prompt: "A cactus suitable for interior design placement.",
    });
    assert.equal(
      result.prompt,
      "a cactus placed in the room, photorealistic interior photography, full object visible, natural shadows",
    );
    assert.equal(
      result.promptVersion,
      "replaceAddObject/v3.0-fluxfill-bare-caption",
    );
    // Same guidance as replace mode in v3.0 — see replace test for
    // rationale.
    assert.equal(result.guidanceScale, 30);
    assert.equal(result.actionMode, "transform");
    assert.equal(result.guidanceBand, "faithful");
    assert.equal(result.positiveAvoidance, "");
  });

  it("uses 'an' for vowel-initial nouns", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      prompt: "An ottoman",
    });
    assert.match(result.prompt, /^an ottoman placed in the room, /);
  });

  it("passes operator-supplied bare nouns through normalize unchanged", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      prompt: "pendant",
    });
    assert.equal(
      result.prompt,
      "pendant placed in the room, photorealistic interior photography, full object visible, natural shadows",
    );
  });
});

describe("manifest contract", () => {
  // One-shot sweep: pins the contract between the manifest and the
  // builder. Adding a manifest row whose `prompt` breaks our
  // normalizer (new boilerplate suffix, leading garbage, etc.) trips
  // this test before it ships to Firestore.
  const manifestPath = new URL(
    "../../../../scripts/manifests/object-inspirations.full.json",
    import.meta.url,
  );
  const data = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    items: Array<{ id: string; categoryId: string; prompt: string }>;
  };

  // v3.0 bare-caption shape. Each branch must:
  //   - lead with a normalized noun (article + noun, or bare noun for
  //     operator overrides). `\p{Ll}` covers lowercase Latin including
  //     accented forms (`é` in `étagère`).
  //   - end with the mode's photography tail.
  const VALID_REPLACE_SHAPE =
    /^(a|an) \p{Ll}[^,]+, photorealistic interior photography, natural lighting matching the room$/u;
  const VALID_ADD_SHAPE =
    /^(a|an) \p{Ll}[^,]+ placed in the room, photorealistic interior photography, full object visible, natural shadows$/u;

  it("every seeded inspiration produces a v3.0 replace caption of the expected shape", () => {
    assert.ok(data.items.length > 0, "manifest must contain items");
    for (const item of data.items) {
      const result = buildReplaceAddObjectPrompt({
        ...baseParams,
        mode: "replace",
        categoryId: item.categoryId,
        inspirationId: item.id,
        prompt: item.prompt,
      });
      assert.match(
        result.prompt,
        VALID_REPLACE_SHAPE,
        `${item.id} produced malformed replace prompt: ${result.prompt}`,
      );
    }
  });

  it("every seeded inspiration produces a v3.0 add caption of the expected shape", () => {
    for (const item of data.items) {
      const result = buildReplaceAddObjectPrompt({
        ...baseParams,
        mode: "add",
        categoryId: item.categoryId,
        inspirationId: item.id,
        prompt: item.prompt,
      });
      assert.match(
        result.prompt,
        VALID_ADD_SHAPE,
        `${item.id} produced malformed add prompt: ${result.prompt}`,
      );
    }
  });

  it("silent-h manifest rows emit 'an ' in both modes", () => {
    // Guards against deleting the SILENT_H_PREFIX branch. Without it,
    // `hourglass side table` would survive normalize as
    // "a hourglass side table" — grammatically wrong.
    const silentH = data.items.filter((it) =>
      /^A\s+(hour|honest|heir|honor|herb)/i.test(it.prompt),
    );
    assert.ok(
      silentH.length > 0,
      "expected at least one silent-h row in seed (today: hourglass side table)",
    );
    for (const item of silentH) {
      const replace = buildReplaceAddObjectPrompt({
        ...baseParams,
        mode: "replace",
        categoryId: item.categoryId,
        inspirationId: item.id,
        prompt: item.prompt,
      });
      assert.match(
        replace.prompt,
        /^an /,
        `${item.id}: silent-h replace prompt should start with "an ", got: ${replace.prompt.slice(0, 60)}`,
      );
      const add = buildReplaceAddObjectPrompt({
        ...baseParams,
        mode: "add",
        categoryId: item.categoryId,
        inspirationId: item.id,
        prompt: item.prompt,
      });
      assert.match(
        add.prompt,
        /^an /,
        `${item.id}: silent-h add prompt should start with "an ", got: ${add.prompt.slice(0, 60)}`,
      );
    }
  });
});
