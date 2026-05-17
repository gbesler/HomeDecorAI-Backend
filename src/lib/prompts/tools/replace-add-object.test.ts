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
  it("emits the v2.2 replace wrapper with the seeded cactus prompt", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      prompt: "A cactus suitable for interior design placement.",
    });
    assert.equal(
      result.prompt,
      "A cactus in place of the object inside the masked region, matching the scene's lighting direction, perspective, and material palette. Photorealistic, integrated with the surrounding furniture and surfaces.",
    );
    assert.equal(result.promptVersion, "replaceAddObject/v2.2-neutral-anchor");
    // Replace guidance — Pro's BFL default (30). v2.0's 38 over-shot
    // and produced sticker output; v2.1 lets the model lean on scene
    // pixels for integration cues. Raise to 60 if reverting to
    // flux-fill-dev.
    assert.equal(result.guidanceScale, 30);
    assert.equal(result.actionMode, "transform");
    assert.equal(result.guidanceBand, "faithful");
    assert.equal(result.positiveAvoidance, "");
  });

  it("uses 'An' inside the wrapper for vowel-initial nouns", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      prompt: "A arc floor lamp suitable for interior design placement.",
    });
    assert.match(
      result.prompt,
      /^An arc floor lamp in place of the object inside the masked region,/,
    );
  });

  it("uses 'An' inside the wrapper for silent-h nouns", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      prompt: "A hourglass side table suitable for interior design placement.",
    });
    assert.match(
      result.prompt,
      /^An hourglass side table in place of the object inside the masked region,/,
    );
  });

  it("handles operator-supplied bare nouns without doubling the article", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      prompt: "pendant",
    });
    assert.match(
      result.prompt,
      /^A pendant in place of the object inside the masked region,/,
    );
  });

  it("handles pre-articled operator-supplied nouns (no seed suffix)", () => {
    // Guards the operator override path for replace mode: a prompt
    // arriving without the seed boilerplate but already carrying its
    // own article ("An ottoman") must survive the
    // normalize → strip → re-article pipeline without losing the
    // vowel-sound determination.
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      prompt: "An ottoman",
    });
    assert.match(
      result.prompt,
      /^An ottoman in place of the object inside the masked region,/,
    );
  });

  it("does not strip the leading letter of a bare vowel-initial noun", () => {
    // Guards `stripLeadingArticle` against accidentally matching the
    // 'a' in "armchair" as the indefinite article. Without the `\s+`
    // requirement in the strip regex, the function would return
    // "rmchair" and the wrapper would render
    // "An rmchair in place …" — visibly broken but only on bare
    // vowel-initial nouns that no test was exercising.
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "replace",
      prompt: "armchair",
    });
    assert.match(
      result.prompt,
      /^An armchair in place of the object inside the masked region,/,
    );
  });
});

describe("buildReplaceAddObjectPrompt — add mode", () => {
  it("emits the v2.2 add wrapper with the seeded cactus prompt (neutral spatial anchor)", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      prompt: "A cactus suitable for interior design placement.",
    });
    assert.equal(
      result.prompt,
      "A cactus inside the masked region, matching the scene's lighting direction, depth of field, and color palette so it blends naturally with the surrounding furniture and surfaces. Photorealistic.",
    );
    assert.equal(result.promptVersion, "replaceAddObject/v2.2-neutral-anchor");
    // Add guidance — Pro's BFL default (~30). 28 maximizes scene
    // blending on blank-area placements without over-anchoring the
    // prompt. Re-tune if REPLICATE_INPAINT_MODEL reverts to Dev.
    assert.equal(result.guidanceScale, 28);
    // Pin the rest of the PromptResult contract for the add branch
    // (the replace-branch canonical test pins these too). A future
    // refactor that moved these fields into the branches must not
    // silently change them on the add path.
    assert.equal(result.actionMode, "transform");
    assert.equal(result.guidanceBand, "faithful");
    assert.equal(result.positiveAvoidance, "");
  });

  it("uses 'An' inside the add wrapper for vowel-initial nouns", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      prompt: "An ottoman",
    });
    assert.match(
      result.prompt,
      /^An ottoman inside the masked region,/,
    );
  });

  it("handles operator-supplied bare nouns without doubling the article", () => {
    // Symmetry with the replace-branch bare-noun test. The
    // normalize → strip → re-article pipeline runs identically for
    // both modes, but exercising it from inside the add wrapper
    // pins the contract that bare nouns reach the wrapper without
    // a stray leading article.
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      prompt: "pendant",
    });
    assert.match(
      result.prompt,
      /^A pendant inside the masked region,/,
    );
  });

  it("does not strip the leading letter of a bare vowel-initial noun", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      mode: "add",
      prompt: "armchair",
    });
    assert.match(
      result.prompt,
      /^An armchair inside the masked region,/,
    );
  });

  it("uses neutral spatial anchor (no floor mention) for wall/ceiling-mounted categories", () => {
    // Guards the v2.2 regression fix: v2.1 hardcoded "placed on the
    // floor" for all categories, which produced anatomically wrong
    // outputs for wallSconces / ceilingLights / wallArt / pendantLights
    // / mirrors / curtains (~100 of 800 catalog items). v2.2 uses a
    // neutral "inside the masked region" anchor that is correct for
    // every category. This test pins that no future re-edit
    // accidentally reintroduces a surface qualifier.
    for (const item of [
      { categoryId: "pendantLights", id: "pendantLights_1", prompt: "A rattan pendant suitable for interior design placement." },
      { categoryId: "wallArt", id: "wallArt_1", prompt: "A framed print suitable for interior design placement." },
      { categoryId: "ceilingLights", id: "ceilingLights_1", prompt: "A flush mount ceiling light suitable for interior design placement." },
    ]) {
      const result = buildReplaceAddObjectPrompt({
        ...baseParams,
        mode: "add",
        categoryId: item.categoryId,
        inspirationId: item.id,
        prompt: item.prompt,
      });
      assert.doesNotMatch(
        result.prompt,
        /on the floor|on the wall|on the ceiling|mounted/i,
        `${item.id}: add prompt must not hardcode a surface-specific anchor; got "${result.prompt.slice(0, 100)}"`,
      );
    }
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

  // v2.1 integration-focused shape regexes. Each branch must:
  //   - open with a capitalized article ("A" or "An") immediately
  //     followed by the noun (no leading verb token — v2.1 dropped
  //     "Add" / "Completely replace" because Flux Fill's inpaint
  //     semantics already imply placement)
  //   - emit a grammatical article via the SILENT_H_PREFIX + Latin-
  //     vowel heuristic
  //   - include the per-mode integration anchors
  // `\p{Ll}` matches any lowercase letter (including accented forms
  // like `é` in `étagère`) so the regex passes the full seed including
  // non-ASCII rows.
  const VALID_REPLACE_SHAPE =
    /^(A|An) \p{Ll}[^,]+ in place of the object inside the masked region, matching the scene's lighting direction, perspective, and material palette\. Photorealistic, integrated with the surrounding furniture and surfaces\.$/u;
  const VALID_ADD_SHAPE =
    /^(A|An) \p{Ll}[^,]+ inside the masked region, matching the scene's lighting direction, depth of field, and color palette so it blends naturally with the surrounding furniture and surfaces\. Photorealistic\.$/u;

  it("every seeded inspiration produces a v2.2 replace prompt of the expected shape", () => {
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

  it("every seeded inspiration produces a v2.2 add prompt of the expected shape", () => {
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

  it("silent-h manifest rows open with 'An ' in both wrappers", () => {
    // Guards against deleting the SILENT_H_PREFIX branch. Without it,
    // `hourglass side table` would survive the shape regex above with
    // "A hourglass…" — grammatically wrong, but visually intact.
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
        /^An /,
        `${item.id}: silent-h replace prompt should start with "An ", got: ${replace.prompt.slice(0, 40)}`,
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
        /^An /,
        `${item.id}: silent-h add prompt should start with "An ", got: ${add.prompt.slice(0, 40)}`,
      );
    }
  });
});
