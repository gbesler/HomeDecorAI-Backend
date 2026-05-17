/**
 * Replace & Add Object prompt builder (inpaint-with-prompt pipeline, Flux Fill).
 *
 * v3.0 — bare-caption format. The earlier mode-aware wrappers (v2.0
 * "Completely replace the masked region with …" → v2.1 "integration-
 * focused" → v2.2 "neutral-anchor") all kept instructional language
 * inside the prompt. The user-reported bugs survived all three:
 *   - Replace returned same-category items (sofa → sofa) regardless of
 *     the picked inspiration.
 *   - Add returned the unmodified input when the painted area was
 *     blank wall/floor.
 *
 * Two converging root causes:
 *
 * 1. **Flux Fill treats `prompt` as a caption of the desired masked
 *    content, not as an instruction.** BFL's own HF sample passes
 *    `prompt="a white paper cup"` — a bare noun phrase. The v2.x
 *    wrappers' meta-commentary tokens ("replace", "masked region",
 *    "existing object", "empty", "in place of the object", "matching
 *    the scene's lighting direction") were parsed as content, diluted
 *    the noun signal, and let the visual context (the brush silhouette
 *    + surrounding pixels) dominate. v2.1/v2.2 trimmed the wording but
 *    did not eliminate the meta-commentary.
 *
 * 2. **Guidance was too high (v2.0 only).** Replicate's `flux-fill-dev`
 *    default is 60, the documented HF example uses 30, and the HF
 *    forum's known failure mode for "Flux Fill ignores the prompt" is
 *    "guidance_scale too high". v2.0 shipped 75 (replace) and 70 (add).
 *    v2.1/v2.2 already lowered to ~30 — this is preserved in v3.0.
 *
 * v3.0 also runs on top of `flux-fill-pro` (default since the v2.2
 * deploy) — Pro follows prompts more reliably than Dev, so the
 * cleanest caption gets the most prompt-faithful model.
 *
 * v3.0 fix: emit the normalized noun phrase plus a short, training-
 * distribution-aligned photography tail. No instructional wording. No
 * mask meta-commentary. Guidance dropped to 30 for both modes (BFL HF
 * sample value).
 *
 * `normalizeInspirationNoun` is unchanged — it still strips the seed-
 * template boilerplate (`"A <noun> suitable for interior design
 * placement."` → `"a <noun>"`) and repairs the indefinite article for
 * vowel-initial and silent-h nouns. The output is now consumed as-is
 * (article and all) by both modes.
 *
 * The add branch keeps a light scene-anchor token (`"placed in the
 * room"`) to encourage commitment to drawing a new object in empty-area
 * masks; without it, Flux Fill on blank-wall masks tends to extend the
 * surrounding texture. The anchor is plain caption language ("a sofa
 * placed in the room"), not meta-commentary.
 *
 * Mask dilation (replace=10px, add=8px) is unchanged in v3.0 — see
 * `src/lib/generation/prompt-inpaint.ts`. Revisit dilation only after
 * the v3.0 prompt + guidance change has been A/B'd on staging.
 *
 * See `docs/brainstorms/2026-05-17-001-replace-add-object-fluxfill-fix-requirements.md`
 * for the full diagnosis and Approach A rationale.
 */

import type { z } from "zod";
import type { PromptResult } from "../types.js";
import type { CreateReplaceAddObjectBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION_CURRENT = "replaceAddObject/v3.0-fluxfill-bare-caption";

export type ReplaceAddObjectParams = z.infer<typeof CreateReplaceAddObjectBody>;

// Silent-h words where "an" is the correct article despite the leading
// consonant letter. The catalog ships `hourglass` today; the rest are
// included defensively for any future seed additions. No word boundary
// so compounds (`hourglass`, `heirloom`) also match — every English
// word with these prefixes happens to be silent-h.
const SILENT_H_PREFIX = /^(hour|honest|heir|honor|herb)/i;

// Latin vowels including accented forms. The catalog ships `étagère`
// (vowel sound) and `bouclé` / `bergère` / `café` (consonant-initial
// despite later accents). Case-insensitive so the same pattern matches
// "Ottoman" and "ottoman".
const VOWEL_INITIAL = /^[aeiouéèêëáàâäíìîïóòôöúùûü]/i;

function startsWithVowelSound(word: string): boolean {
  return VOWEL_INITIAL.test(word) || SILENT_H_PREFIX.test(word);
}

// BFL HF sample value for both Flux Fill Dev and Pro. Same value for
// both modes — v2.1/v2.2 split (30/28) was a marginal A/B move that
// produced no visible quality delta. v3.0 collapses to a single number
// and lets the prompt do the work.
//
// If REPLICATE_INPAINT_MODEL is flipped back to flux-fill-dev (native
// guidance scale ~60), re-tune against fresh staging output rather
// than assuming this number carries over linearly. Paired with the
// dilation values in `src/lib/generation/prompt-inpaint.ts`.
const FLUX_FILL_GUIDANCE = 30;

// Photography tail tokens. Kept short — Flux Fill responds best to
// concise captions per BFL's prompting guidance. The replace tail
// emphasizes integration ("matching the scene's lighting"); the add
// tail emphasizes commitment ("full object visible") to counter Flux
// Fill's empty-area texture-extension bias.
//
// "Scene" (not "room") is load-bearing: the catalog includes 80+
// outdoor items (outdoorSeating, outdoorLighting, patio, garden). The
// v2.2 wrapper explicitly used "scene" for this reason; v3.0's first
// draft regressed to "room" and got caught in code review. Token
// contradictions ("an outdoor sofa … matching the room") confuse
// Flux Fill. "Scene" is room-neutral and works for both indoor and
// outdoor categories. Same rule for "photorealistic" (no "interior
// photography" qualifier).
const REPLACE_TAIL =
  "photorealistic, natural lighting matching the scene";
const ADD_SCENE_ANCHOR = "placed in the scene";
const ADD_TAIL =
  "photorealistic, full object visible, natural shadows";

/**
 * Strip the seed-template boilerplate so the noun composes as a clean
 * caption and emits a grammatical indefinite article:
 *   - "A arc floor lamp suitable for interior design placement." → "an arc floor lamp"
 *   - "A cactus suitable for interior design placement."         → "a cactus"
 *   - "A hourglass side table suitable for …"                    → "an hourglass side table"
 *   - "A pendant" (operator override, no suffix)                 → "a pendant"
 */
export function normalizeInspirationNoun(raw: string): string {
  // The seed-template " ... suitable for interior design placement."
  // suffix is identical across all 800 manifest rows and adds no
  // useful signal — it dilutes the noun for Flux Fill. Anchored to
  // end-of-string so a real prompt that happens to contain the phrase
  // mid-sentence ("lamp suitable for outdoor use") is unaffected.
  const stripped = raw
    .replace(/\s+suitable\s+for\s+interior\s+design\s+placement\.?\s*$/i, "")
    .replace(/\.\s*$/, "")
    .trim();

  const articleMatch = stripped.match(/^(An?)\s+(.+)$/);
  if (articleMatch) {
    const [, , rest = ""] = articleMatch;
    return `${startsWithVowelSound(rest) ? "an" : "a"} ${rest}`;
  }
  return stripped;
}

export function buildReplaceAddObjectPrompt(
  params: ReplaceAddObjectParams,
): PromptResult {
  const noun = normalizeInspirationNoun(params.prompt);

  // `mode` is `"replace" | "add"` — never undefined at this point.
  // Zod's `.default("replace")` is applied during parse, so the
  // inferred output type strips `undefined` even though the input
  // schema marks the field optional. No `?? "replace"` guard needed.
  const prompt =
    params.mode === "replace"
      ? `${noun}, ${REPLACE_TAIL}`
      : `${noun} ${ADD_SCENE_ANCHOR}, ${ADD_TAIL}`;

  return {
    prompt,
    positiveAvoidance: "",
    guidanceScale: FLUX_FILL_GUIDANCE,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion: PROMPT_VERSION_CURRENT,
  };
}
