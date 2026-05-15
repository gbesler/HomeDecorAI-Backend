import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildReplaceAddObjectPrompt,
  normalizeInspirationNoun,
} from "./replace-add-object.js";

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
    // `étagère` is the only accented-vowel-initial entry in the
    // current seed, but `é` (and the rest of the Latin diacritic set)
    // must be treated as a vowel sound — "an étagère", not "a étagère".
    assert.equal(
      normalizeInspirationNoun(
        "A étagère suitable for interior design placement.",
      ),
      "an étagère",
    );
  });

  it("keeps 'a' for consonant-initial nouns even when later letters are accented", () => {
    // `bouclé`, `bergère`, `café` — consonant-initial despite the
    // accent later in the word.
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
    // Guards the regex anchor — only the exact trailing seed phrase
    // should be removed, not legitimate uses of the words elsewhere.
    assert.equal(
      normalizeInspirationNoun("A lamp suitable for outdoor use."),
      "a lamp suitable for outdoor use",
    );
  });
});

describe("buildReplaceAddObjectPrompt", () => {
  it("emits the v1.3 noun-first wrapper sentence", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      prompt: "A cactus suitable for interior design placement.",
    });
    assert.equal(
      result.prompt,
      "A cactus, photorealistic, prominently visible and naturally integrated with the surrounding room.",
    );
    assert.equal(result.promptVersion, "replaceAddObject/v1.3-fluxfill-visible");
    // 0 is the "defer to capabilities.defaultGuidanceScale" sentinel —
    // bumping the wrapper sentence must not regress that contract.
    assert.equal(result.guidanceScale, 0);
    assert.equal(result.actionMode, "transform");
    assert.equal(result.guidanceBand, "faithful");
    assert.equal(result.positiveAvoidance, "");
  });

  it("capitalizes the article for vowel-initial nouns", () => {
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      prompt: "A arc floor lamp suitable for interior design placement.",
    });
    assert.equal(
      result.prompt,
      "An arc floor lamp, photorealistic, prominently visible and naturally integrated with the surrounding room.",
    );
  });

  it("capitalizes the no-article fallback path", () => {
    // Operator override path: a raw noun with no leading article still
    // produces a sentence-cased opener so the prompt does not ship to
    // Flux Fill starting lowercase.
    const result = buildReplaceAddObjectPrompt({
      ...baseParams,
      prompt: "pendant",
    });
    assert.equal(
      result.prompt,
      "Pendant, photorealistic, prominently visible and naturally integrated with the surrounding room.",
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

  // Full v1.3 shape: leading "A " or "An " + lowercase noun (not a
  // comma/space artifact from an empty noun) + every load-bearing
  // token of the wrapper sentence in order. Pins capitalization,
  // article correctness, `prominently visible` (the empty-mask
  // commitment signal), and the trailing integration phrase. Anything
  // looser lets a regression that drops the capitalization step OR
  // the `prominently visible` clause ship to Flux Fill silently.
  // `\p{Ll}` matches any lowercase letter (including accented forms
  // like `é` in `étagère`). Using a plain `[a-z]` here would reject
  // grammatically correct prompts whose noun begins with a non-ASCII
  // letter.
  const VALID_PROMPT_SHAPE =
    /^(A|An) \p{Ll}[^,]+, photorealistic, prominently visible and naturally integrated with the surrounding room\.$/u;

  it("every seeded inspiration produces a v1.3 prompt of the expected shape", () => {
    assert.ok(data.items.length > 0, "manifest must contain items");
    for (const item of data.items) {
      const result = buildReplaceAddObjectPrompt({
        ...baseParams,
        categoryId: item.categoryId,
        inspirationId: item.id,
        prompt: item.prompt,
      });
      assert.match(
        result.prompt,
        VALID_PROMPT_SHAPE,
        `${item.id} produced malformed prompt: ${result.prompt}`,
      );
    }
  });

  it("silent-h manifest rows emit 'An ' (not 'A ')", () => {
    // Guards against deleting the SILENT_H_PREFIX branch. Without it,
    // `hourglass side table` would survive the shape regex above with
    // "A hourglass…" — grammatically wrong, but visually intact. This
    // test fails loudly if the silent-h fix regresses.
    const silentH = data.items.filter((it) =>
      /^A\s+(hour|honest|heir|honor|herb)/i.test(it.prompt),
    );
    assert.ok(
      silentH.length > 0,
      "expected at least one silent-h row in seed (today: hourglass side table)",
    );
    for (const item of silentH) {
      const result = buildReplaceAddObjectPrompt({
        ...baseParams,
        categoryId: item.categoryId,
        inspirationId: item.id,
        prompt: item.prompt,
      });
      assert.match(
        result.prompt,
        /^An /,
        `${item.id}: silent-h prompt should start with "An ", got: ${result.prompt.slice(0, 40)}`,
      );
    }
  });
});
