/**
 * Replace & Add Object prompt builder (v4.0 — Nano Banana multi-image
 * instructional).
 *
 * **Why v4.0 is a full rewrite, not another caption tweak.**
 *
 * v1.x → v3.0 lived inside the Flux Fill (`black-forest-labs/flux-fill-*`)
 * pipeline and emitted bare captions ("a rattan pendant, photorealistic, …").
 * That pipeline shipped five prompt iterations against the same two bugs:
 *
 *   - **Replace bug:** picking a specific inspiration (rattan pendant)
 *     returned a different same-category item (plain pendant).
 *   - **Add bug:** painting over blank wall/floor returned the unmodified
 *     input or surrounding-texture extension.
 *
 * The structural root cause: Flux Fill is a caption-fill model. It
 * accepts `image + mask + prompt-as-caption`. It does NOT accept a
 * reference image of the object the user picked, and it cannot express
 * the Replace vs. Add semantic distinction in its prompt slot — both
 * read as "describe what should occupy the masked region". No amount
 * of caption rewording fixes either failure mode.
 *
 * v4.0 switches the pipeline to `google/nano-banana` (Gemini 2.5 Flash
 * Image): an instruction-following multi-image edit model that accepts
 * up to 14 reference images per call. The room photo, the inspiration
 * photo, and the brush mask all flow in as first-class `image_input`
 * entries. The model's job becomes a documented Google pattern —
 * "Replace the {object} in image 1 with the {object} from image 2,
 * inside the white region of image 3 (mask)" — instead of caption
 * inference under a silhouette + noun-phrase bias.
 *
 * See `docs/plans/2026-05-17-001-refactor-replace-add-object-nano-banana-plan.md`
 * for the full architectural rationale, pricing comparison ($0.020 vs
 * $0.050 per image), and Phase 2 roadmap (crop-and-paste fallback,
 * Nano Banana 2 upgrade).
 *
 * **What this builder emits.**
 *
 * A natural-language instruction string referencing three image slots
 * (image 1 = room, image 2 = inspiration, image 3 = mask). The pipeline
 * (src/lib/generation/multi-image-edit.ts) is responsible for assembling
 * the actual `image_input: [room, inspiration, mask]` array — the
 * builder only produces the text instruction. The `{category}` token
 * interpolates from `params.inspirationTitle`, which `preEnqueueValidate`
 * in tool-types.ts populates from `objectInspirations/{id}.title.en`.
 *
 * Outside-mask pixel preservation is enforced by a post-process
 * composite step (src/lib/generation/composite-masked-result.ts), not
 * by the model. The "Keep all pixels outside the white region of image 3
 * unchanged" clause in the prompt is a best-effort signal to Gemini, not
 * a guarantee; the composite step is what actually preserves the
 * original pixels byte-for-byte after the model returns.
 *
 * **No CFG / guidance scale.** Nano Banana does not expose a CFG knob
 * (`supportsGuidanceScale: false` in capabilities.ts). The provider
 * layer drops the field when `supportsGuidanceScale` is false, so
 * shipping `0` here is a documented sentinel meaning "no override
 * required". The builder's `guidanceBand` is left at `"faithful"` for
 * telemetry continuity with prior versions — it has no functional
 * effect on Gemini.
 *
 * **No `normalizeInspirationNoun` helper.** v3.0 needed the helper to
 * derive a clean noun ("a cactus") from the seed-template boilerplate
 * ("A cactus suitable for interior design placement."). v4.0 reads the
 * already-clean `title.en` ("Sectional Sofa") from Firestore — no noun
 * extraction, no article repair, no silent-h handling. The legacy
 * regex helper is intentionally not preserved.
 */

import type { z } from "zod";
import type { PromptResult } from "../types.js";
import type { CreateReplaceAddObjectBody } from "../../../schemas/generated/api.js";

/**
 * Normalized (0..1) bounding box of the brush mask's white-pixel region.
 * When supplied to `buildReplaceAddObjectPrompt` as the second argument,
 * the builder emits a text-spatial instruction ("the rectangular region
 * from left X% to right Y%") instead of referring to "image 3" as a
 * semantic mask.
 *
 * Why text-spatial vs. image-3-as-mask: in v4.0 staging Nano Banana
 * (Replicate google/nano-banana) consistently failed to interpret the
 * third image_input slot as a semantic edit region. The model would
 * place the inspiration object in a different part of the room
 * (typically the visual center, ignoring the brush mask), and the
 * composite step would correctly drop the misplaced edit (outside-mask
 * = original) leaving the user with an unchanged room. Text bounding-
 * box coordinates match Google's documented composition pattern
 * ("place the chair into the empty corner on the left side") and give
 * the model a reliable spatial anchor without depending on 3-image
 * array interpretation that the model is not trained for.
 */
export interface MaskBbox {
  /** Left edge as a fraction of image width (0..1). */
  left: number;
  /** Top edge as a fraction of image height (0..1). */
  top: number;
  /** Right edge as a fraction of image width (0..1). */
  right: number;
  /** Bottom edge as a fraction of image height (0..1). */
  bottom: number;
}

/**
 * Optional bbox-aware prompt-builder extension. Kept on a second argument
 * so the existing `tool.buildPrompt(params)` call site in the generation
 * processor (which has no access to the mask buffer at that point) keeps
 * compiling without changes — that path emits the image-3-as-mask
 * fallback template. The multi-image-edit pipeline computes the bbox
 * after normalize and re-runs the builder with `{ maskBbox }`, getting
 * the text-spatial template that Nano Banana actually follows.
 */
export interface BuildReplaceAddObjectPromptOptions {
  maskBbox?: MaskBbox | null;
}

const PROMPT_VERSION_CURRENT =
  "replaceAddObject/v4.0-nano-banana-instructional";

export type ReplaceAddObjectParams = z.infer<typeof CreateReplaceAddObjectBody>;

// Nano Banana has no CFG knob; the provider layer drops the field
// because the `google/nano-banana` capability entry sets
// `supportsGuidanceScale: false`. Shipping 0 here documents "no caller
// override required" — matches the sentinel logic in
// `src/lib/ai-providers/replicate.ts` (`callerGuidance` check).
const NANO_BANANA_GUIDANCE = 0;

// Fallback noun phrase when an inspiration somehow reaches the builder
// without a populated `inspirationTitle`. Should be unreachable —
// `preEnqueueValidate` in `src/lib/tool-types.ts` 409-rejects any
// inspiration with an empty title.en + title.tr + prompt chain — but
// the type system can't enforce that the field is populated, so a
// defensive default keeps a stray code path from emitting a malformed
// prompt with a bare `${undefined}` token.
const FALLBACK_CATEGORY = "object";

/**
 * Build the v4.0 instructional prompt for Nano Banana multi-image edit.
 *
 * The returned `prompt` string references three image slots:
 *   - image 1: the room photo (the canonical input being edited)
 *   - image 2: the inspiration reference photo (the visual identity of
 *              the object the user picked)
 *   - image 3: the brush mask (white = modify, black = preserve)
 *
 * The pipeline layer assembles the actual provider call with
 * `image_input: [room, inspiration, mask]` in this exact order. If the
 * order ever drifts on the call site, the prompt's "image 2" / "image 3"
 * references become misleading — pin the assembly order in the
 * pipeline's tests, not here.
 */
export function buildReplaceAddObjectPrompt(
  params: ReplaceAddObjectParams,
  options?: BuildReplaceAddObjectPromptOptions,
): PromptResult {
  // `inspirationTitle` is populated by `preEnqueueValidate` from the
  // Firestore doc's `title.en` (sanitized + length-capped). Treated as
  // optional in the wire schema because iOS clients do not send it.
  // See the defensive default rationale above.
  const category = params.inspirationTitle?.trim() || FALLBACK_CATEGORY;
  const bbox = options?.maskBbox ?? null;

  // `mode` is `"replace" | "add"` — Zod's `.default("replace")` is
  // applied during parse, so the inferred output type strips `undefined`
  // even though the input schema marks the field optional. Switch on
  // the narrowed value; the exhaustiveness guard below catches a future
  // enum addition at compile time.
  //
  // When a bbox is supplied, both branches emit the text-spatial
  // template that names the rectangular edit region in percent
  // coordinates — no "image 3" references, so the provider call
  // should ship a 2-image array (room + inspiration) only. When no
  // bbox is supplied (the legacy tool.buildPrompt(params) path used
  // by the processor's generic flow), both branches fall back to
  // the v4.0 image-3-as-mask template. The bbox path is what the
  // multi-image-edit pipeline uses at runtime; the fallback exists
  // for the processor's initial pre-mode-branch buildPrompt call
  // and for any future caller that does not have mask geometry.
  const prompt = (() => {
    switch (params.mode) {
      case "replace":
        return bbox
          ? buildBboxReplaceInstruction(category, bbox)
          : buildMaskReplaceInstruction(category);
      case "add":
        return bbox
          ? buildBboxAddInstruction(category, bbox)
          : buildMaskAddInstruction(category);
    }
    const _exhaustive: never = params.mode;
    throw new Error(
      `unreachable replaceAddObject mode: ${_exhaustive as string}`,
    );
  })();

  return {
    prompt,
    positiveAvoidance: "",
    guidanceScale: NANO_BANANA_GUIDANCE,
    actionMode: "transform",
    guidanceBand: "faithful",
    promptVersion: PROMPT_VERSION_CURRENT,
  };
}

/**
 * Format a normalized bbox as a human-readable percentage region for
 * inclusion in the instructional prompt. Rounds to whole percentage
 * points so the model sees a clean phrase ("left 12%, top 64%, right
 * 24%, bottom 89%") instead of float-precision noise ("12.347%, ...").
 * The model interprets these as approximate region coordinates; sub-
 * percent precision adds no signal but does add token weight.
 */
function formatBboxAsPercentRegion(bbox: MaskBbox): string {
  const leftPct = Math.round(bbox.left * 100);
  const topPct = Math.round(bbox.top * 100);
  const rightPct = Math.round(bbox.right * 100);
  const bottomPct = Math.round(bbox.bottom * 100);
  return `the rectangular region of image 1 from (left ${leftPct}%, top ${topPct}%) to (right ${rightPct}%, bottom ${bottomPct}%)`;
}

/**
 * Bbox-aware Replace template (primary path at runtime). The pipeline
 * computes the brush mask's white-pixel bounding box, expresses it as
 * percent coordinates in image 1's coordinate space, and the instruction
 * names that region explicitly. Matches Google's documented
 * "composition" pattern from the Nano Banana prompting guide:
 *
 *   "Using image 1 as the base and image 2 as the replacement object
 *    reference, replace [object] with this new element while keeping
 *    the rest of the composition intact."
 *
 * The bbox replaces the staging-broken "white region of image 3"
 * reference. Nano Banana does not interpret an image_input array's
 * third slot as a semantic mask — observed in production where the
 * model ignored the mask and placed the inspiration in the visual
 * center of the scene regardless of where the user painted.
 *
 * The instruction is structured as: scene framing → action with
 * region → preservation constraint → output format. Multi-clause,
 * but each clause is a single short imperative that Gemini-family
 * models follow consistently.
 */
function buildBboxReplaceInstruction(
  category: string,
  bbox: MaskBbox,
): string {
  // "Edit image 1:" intentionally lacks a "(a room photo)" qualifier.
  // The catalog includes 80+ outdoor items (outdoorSeating,
  // outdoorLighting, patio, garden) where image 1 may itself be an
  // outdoor scene. Indoor-only descriptors contradict the noun for
  // those categories and were the v3.0 outdoor regression. Gemini
  // reads the actual image content; the descriptor adds no useful
  // signal and risks contradiction.
  const region = formatBboxAsPercentRegion(bbox);
  return [
    `Edit image 1 by replacing the existing object inside ${region} with the ${category} shown in image 2.`,
    `Match image 1's lighting direction, shadow placement, perspective, and physical scale.`,
    `Preserve every pixel of image 1 outside that rectangular region exactly.`,
    `Output a photorealistic edit of image 1, with no commentary or markers.`,
  ].join(" ");
}

/**
 * Mask-referencing Replace template (legacy fallback). Used when no
 * bbox is supplied — currently the `tool.buildPrompt(params)` call site
 * in the generation processor's generic flow, which has no mask
 * geometry. The processor's multi-image-edit-with-mask branch rebuilds
 * the prompt via the bbox path before dispatch, so this template is
 * effectively dormant in production today. Retained for two reasons:
 * (1) the processor's promptResult is logged before the mode-specific
 * branch executes, and a missing template here would emit an empty
 * prompt for telemetry; (2) future tools that reuse the same builder
 * without geometry would degrade gracefully rather than crashing.
 */
function buildMaskReplaceInstruction(category: string): string {
  return [
    `Edit image 1: replace the object inside the white region of image 3 (a binary mask, white = modify, black = preserve) with the ${category} shown in image 2.`,
    `Match image 1's lighting direction, shadow placement, perspective, and physical scale.`,
    `Keep every pixel outside the white region of image 3 unchanged.`,
    `Output a photorealistic edit of image 1.`,
  ].join(" ");
}

/**
 * Bbox-aware Add template. Same text-spatial pattern as the bbox
 * Replace template, but the action verb is "place into" rather than
 * "replace ... with", and an explicit shadow directive is included.
 * Add mode targets blank wall/floor masks where the model otherwise
 * defaults to extending surrounding texture instead of synthesizing
 * a new object.
 *
 * No surface-specific anchor ("on the floor", "on the wall"). The
 * builder has no per-category metadata, so a hardcoded anchor would
 * be wrong for ~100 of 800 catalog items (wall sconces vs. floor
 * lamps vs. pendant lights). Phase 2 may revisit this if certain
 * category clusters consistently surface placement bugs.
 */
function buildBboxAddInstruction(category: string, bbox: MaskBbox): string {
  // Image-1-relative phrasing throughout — "image 1's perspective"
  // not "the room's perspective". v3.0 first draft hardcoded indoor-
  // only tokens here and broke outdoor catalog items. Sibling of the
  // bbox Replace template's identical no-descriptor opening.
  const region = formatBboxAsPercentRegion(bbox);
  return [
    `Edit image 1 by placing the ${category} shown in image 2 into ${region}.`,
    `Cast a natural shadow appropriate to image 1's existing lighting and surfaces.`,
    `Match image 1's perspective and physical scale.`,
    `Preserve every pixel of image 1 outside that rectangular region exactly.`,
    `Output a photorealistic edit of image 1, with no commentary or markers.`,
  ].join(" ");
}

/**
 * Mask-referencing Add template (legacy fallback). Sibling of
 * `buildMaskReplaceInstruction` — used when no bbox is supplied. See
 * that function's docstring for the retention rationale.
 */
function buildMaskAddInstruction(category: string): string {
  return [
    `Edit image 1: place the ${category} shown in image 2 into the white region of image 3 (a binary mask, white = where to place, black = preserve).`,
    `Cast a natural shadow appropriate to image 1's existing lighting and surfaces.`,
    `Match image 1's perspective and physical scale.`,
    `Keep every pixel outside the white region of image 3 unchanged.`,
    `Output a photorealistic edit of image 1.`,
  ].join(" ");
}
