---
title: Replace & Add Object — Flux Fill prompt + guidance fix
date: 2026-05-17
status: brainstorm
owner: kagan@superblend.com
tool: replaceAddObject
related:
  - src/lib/prompts/tools/replace-add-object.ts
  - src/lib/generation/prompt-inpaint.ts
  - src/lib/ai-providers/replicate.ts
  - src/lib/ai-providers/capabilities.ts
---

## 0. Parallel iterations already on staging (added during conflict-resolution)

While this brainstorm was being authored, staging shipped three additional iterations on the same tool. They land before v3.0 in the branch history; v3.0 is now built on top of them rather than as a parallel attempt.

- `9071fbc feat(replace-add-object): switch inpaint default to flux-fill-pro` — flips `REPLICATE_INPAINT_MODEL` default from `flux-fill-dev` to `flux-fill-pro`. This is Approach C from §5 below, shipped early. v3.0 retains the Pro default.
- `208eee6 fix(replace-add-object): integration-focused v2.1 prompts + lower guidance` — drops guidance toward 30 and rewrites both wrappers around scene-integration tokens ("matching the scene's lighting direction, perspective, material palette").
- `417cad3 fix(replace-add-object): neutral add anchor + Pro cost controls + observability` — v2.2 neutralises the add anchor (removes "on the floor" which was wrong for ~100 wall/ceiling-mounted catalog items), adds Pro cost controls and observability hooks.

v2.1 and v2.2 partially address H2 (guidance) and partially address H1 (the wording is shorter and lighter than v2.0), but they still ship instructional clauses ("in place of the object inside the masked region", "matching the scene's lighting direction"). The user reports the bug still reproduces after the v2.2 + Pro deploy, so the bare-caption hypothesis (H1 taken to its logical conclusion) remains untested in production. v3.0 ships exactly that test, on top of the Pro model already running on staging.

## 1. Symptom

User-reported, reproduced across multiple inspirations:

- **Replace mode** — user paints over an existing item (e.g. a sofa), picks a different inspiration (e.g. an armchair), submits. Output is *another item of the original category*, not the selected inspiration. The masked silhouette is essentially preserved.
- **Add mode** — user paints an empty wall / floor area, picks an inspiration, submits. Output is the unchanged input image (or visually identical — Flux Fill extends the surrounding wall texture instead of drawing the requested object).

## 2. Pipeline trace (verified end-to-end)

The inspiration text **does** reach the model. The pipeline is wired correctly:

1. iOS `ReplaceAddObjectWizardViewModel.generate()` reads `selectedInspiration.prompt` (the per-item caption from the catalog Firestore doc) and sends it as `body.prompt` in `enqueueReplaceAddObject`. `inspiration.prompt` is the same string the manifest ships — e.g. `"A sectional sofa suitable for interior design placement."`. Confirmed at `HomeDecorAI/.../ReplaceAddObjectWizardViewModel.swift:423-432` and `HomeDecorAI/.../DesignAPIService.swift:906-918`.
2. Backend Zod-validates and forwards `params.prompt` to `buildReplaceAddObjectPrompt` (registered at `src/lib/tool-types.ts:1346-1378`).
3. `buildReplaceAddObjectPrompt` normalises the seed boilerplate to `"a sectional sofa"` and wraps it in a mode-specific sentence with `guidance = 75` (replace) or `70` (add). See `src/lib/prompts/tools/replace-add-object.ts:141-197`.
4. `runPromptInpaint` dilates the mask 10 px (replace) / 8 px (add) via the sharp blur-and-threshold approximation, normalises image+mask dims, and calls `callInpaint`. See `src/lib/generation/prompt-inpaint.ts`.
5. `callInpaintReplicate` forwards `prompt`, `guidance` to Flux Fill Dev (`black-forest-labs/flux-fill-dev`). Capability has `supportsGuidanceScale: true`, so the 75/70 values are attached to the API call. See `src/lib/ai-providers/replicate.ts:379-507` and `src/lib/ai-providers/capabilities.ts:300-329`.

**Conclusion:** the inspiration string is preserved through every hop. Both bugs are downstream of the call site — they live in *how* we prompt Flux Fill and *what guidance value* we ship.

## 3. Root cause hypotheses

Three load-bearing problems compound. Each is independently sufficient to explain part of the failure.

### H1. Prompt is over-instrumented (HIGH confidence)

Flux Fill treats its `prompt` argument as a **caption of the desired masked content**, not as an instruction. Evidence:

- The official Hugging Face FLUX.1-Fill-dev sample uses `prompt="a white paper cup"` — a bare noun phrase with no verbs and no meta-commentary about the mask (HuggingFace model card).
- Stable Diffusion Art's Flux Fill guide and the Replicate model description both frame the prompt as "describe what should be in the masked area".
- A HuggingFace forum thread on `FluxInpaintPipeline` returning the input unchanged identifies overly long, instructional prompts as a likely cause and recommends shortening to bare descriptions.

Our v2.0 wrapper produces:

- Replace: `"Completely replace the masked region with a sectional sofa. Remove any existing object inside the mask. Photorealistic, prominently visible, matching the room's lighting."`
- Add: `"Add a sectional sofa inside the masked region. The masked area is currently empty; place the object clearly visible and well-lit. Photorealistic, sharp focus, natural shadows."`

Words like `replace`, `masked region`, `remove`, `existing object`, `empty` are treated as content tokens. They dilute the noun signal — the model averages "sectional sofa" against "masked region", "existing object", "empty", etc. — and the visual context (the painted silhouette + surrounding pixels) wins.

The inline rationale in `replace-add-object.ts:10-39` treats the v2.0 wording as load-bearing, but the v1.3 → v2.0 change was made on intuition, not on a benchmark against bare-noun prompts.

### H2. Guidance value is mis-tuned for object swap (HIGH confidence)

- Replicate's `flux-fill-dev` schema lists `guidance` default = 60, range 1.5–100.
- BFL's official HF sample uses `guidance_scale=30` with `num_inference_steps=50` (HuggingFace model card).
- HuggingFace forum thread on Flux Fill ignoring the prompt: top reply attributes it to "guidance_scale is too high".

Our current values are **75 (replace)** and **70 (add)** — above both the model-card example (30) and even the Replicate default (60). Counterintuitively for diffusion CFG, on Flux Fill's distilled guidance scale, *too-high* guidance reinforces the conditioning provided by `image` + `mask` (= the visual context under the brush) at the expense of the text prompt — the exact failure mode the user describes.

The capability matrix at `capabilities.ts:300-329` already documents 60 as the Dev default but the prompt builder ignored that and shipped 75/70 in v2.0.

### H3. Brush-shape silhouette is unbroken (MEDIUM confidence, replace-mode only)

iOS `MaskRenderer` paints a soft-edged blob around the user's brush strokes. For a user who tightly paints around a sofa, the mask is "sofa-shaped". Our backend dilation (blur σ=5, threshold 50) expands the contour by an effective ~5 px — well below the dimension of the object itself. Flux Fill conditions on the mask shape; with a sofa-shaped void and a confusing prompt, it fits another sofa.

The v2.0 dilation bump from 5 → 10 px helped at the margin but is not enough to fully break a 200+ px-wide silhouette.

### H4. Add-mode prompt actively biases toward "empty" (MEDIUM confidence, add-mode only)

The add wrapper includes the literal phrase `"The masked area is currently empty"`. Flux Fill cannot parse this as a meta-statement; it sees `empty` as a content token. Combined with a soft-edge brush on a flat wall (no contour cue inside the mask), the model commits to "fill the masked area with empty wall" — i.e. continues the surrounding texture, which is exactly the reported failure.

## 4. Why automated tests don't catch this

`replace-add-object.test.ts` pins:

- Prompt-string shape via regex.
- Guidance numbers via `assert.equal(75)` / `assert.equal(70)`.
- Article correctness for vowel / silent-h nouns.

Tests verify the builder's *outputs are stable*, but the test contract is itself the bug. The numbers and wording have never been benchmarked against live Flux Fill outputs across the 800-row manifest. The shape-regex tests guarantee that any prompt-quality fix touches the contract — i.e. the tests will need to be updated alongside the fix, not just appended to.

## 5. Approaches considered

### A — Minimal: bare-noun caption + guidance to the BFL default *(recommended starting point)*

- Prompt builder emits the normalised noun phrase plus a short, training-distribution-aligned tail.
  - Replace: `"a sectional sofa, photorealistic interior photography, natural lighting matching the room"`
  - Add: `"a sectional sofa placed in the room, photorealistic interior photography, full object visible, natural shadows"`
- Drop *all* meta-commentary about the mask. No `replace`, `masked region`, `existing object`, `empty`.
- Guidance: 30 (replace) and 30 (add) — match the BFL HF sample. Optionally bump add to 40 if the empty-area commitment proves weak in A/B.
- Mask dilation: keep current 10 / 8 for v1, revisit after the prompt change lands.

**Pros:** smallest diff (one file plus its test), aligned with the official model card, addresses H1 + H2 simultaneously. Low risk — easy to revert via the existing `PROMPT_VERSION_CURRENT` versioning.
**Cons:** does not address H3 for tightly-painted silhouettes; some categories (textiles, art) may still need scene context.
**Best when:** the bugs are dominated by prompt/guidance, not mask shape. Initial diagnosis strongly suggests this.

### B — Bare-noun + scene anchoring + wider replace dilation

Approach A plus:

- Inject the room context observed in the input image into the caption. Today we don't classify the room, so this would be a static "in the room" anchor for v1 (e.g. `"a sectional sofa placed in the room, photorealistic interior photography"`).
- Bump replace-mode dilation 10 → 18 px to break sofa-shaped masks. Re-tune empirically.

**Pros:** addresses H3 alongside H1/H2. Scene context measurably helps Flux Fill commit to drawing a new object rather than re-styling the masked pixels.
**Cons:** more code; larger dilation can clip into adjacent furniture for tight scenes. Worth one staging pass to confirm.
**Best when:** A alone proves insufficient on the replace path after a staging A/B.

### C — Flip the inpaint model to Flux Fill Pro (or fal Flux Pro Fill)

- Single env flip: `REPLICATE_INPAINT_MODEL=black-forest-labs/flux-fill-pro`.
- Pro is calibrated tighter (default guidance 30 per capability matrix), follows prompts more reliably.
- ~5× cost per call (~$0.20 vs $0.04 on Replicate).

**Pros:** zero code change; instant uplift if Dev's prompt-following is the dominant cause. Reversible.
**Cons:** materially higher per-call cost on a tool that's freemium-metered; doesn't fix the prompt-engineering root cause — would mask H1/H2 with model strength.
**Best when:** we need an emergency mitigation before A/B is complete, or A+B together still underperform.

### D — Use the inspiration *image* as a visual reference (longer lift)

Move off prompt-only inpainting. Use the inspiration tile's image (we already have its URL in the catalog) as a reference for the inpainted region — e.g. via reference-style inpainting (Flux Kontext, Nano Banana) or a custom pipeline that composes (room, mask, reference) → output.

**Pros:** fundamentally more robust. Text prompts cannot fully specify a unique product; the inspiration tile *is* the spec. Eliminates "sectional sofa" → wrong-shape sofa ambiguity entirely.
**Cons:** large engineering lift — new tool mode, new provider call, new prompt builder, schema changes. Out of scope for this brainstorm unless A/B/C all fail.
**Best when:** post-A/B/C, if quality is still the gating issue and we're willing to pay engineering cost for a step-change.

## 6. Recommendation

Ship **Approach A** on top of the Pro model already on staging (§0). The combination tests the strongest version of the H1+H2 hypothesis: cleanest prompt + most prompt-faithful Flux Fill model.

- It's the smallest defensible change, fully aligned with BFL's own documented usage of the model.
- It targets H1 and H2 — the two hypotheses with the strongest external evidence.
- Validates the diagnosis cheaply: if A meaningfully fixes both bugs, we know the prompt + guidance were the root cause; if not, escalate to B (mask dilation + scene anchor) or C (Pro flip) with much better information.
- Costs nothing extra to run.

**If A is not enough:**

- Replace still produces silhouette-style results → escalate to B.
- Add still produces an unchanged image → check normalize logs for `whitePixelFraction < 0.001` (mask empty); if false, escalate to B (bump add-mode guidance to 40, widen add-mode dilation slightly).
- Both still failing → C (Pro flip) as a stopgap while D is scoped.

## 7. Success criteria

For both replace and add modes across a 20-item smoke set drawn from the manifest (1 from each of the most-used categories), with the same painted region:

- **Replace:** ≥ 80% of outputs visibly match the *selected inspiration category* (sofa→armchair lands an armchair, not a sofa). Today: ~0%.
- **Add:** ≥ 80% of outputs show the requested object clearly visible in the masked region (not an unchanged wall). Today: ~0%.
- No new regressions in surface-integrity, lighting consistency, or shadow plausibility relative to v2.0.

Eval method: manual review of staging outputs. Not a unit test — Flux Fill behavior cannot be unit-tested.

## 8. Open questions

- Does the iOS brush already feather the mask? If so, the backend dilation is double-feathering. (Looks like the renderer is hard-binary; backend blur introduces the only feather. Verify before B.)
- Should we expose `mode` to the user explicitly via the UI segmented control, or infer it from mask whiteness vs. detected-object overlap? (Current default is replace; user can switch — but most users probably don't know to.) Out of scope for this fix but worth a follow-up.
- For v1, do we standardise on one guidance value for both modes (simplicity) or keep per-mode tuning? Default to one value (30) for v1; split only if staging shows a clear difference.

## 9. Handoff

This document is ready for `/ce:plan` to convert into a concrete implementation plan. The plan should cover:

- New prompt-version slug (`replaceAddObject/v3.0-…`) and updated `replace-add-object.ts`.
- Test updates — the shape regexes and `assert.equal` guidance values must move with the code.
- Staging A/B methodology (20-item smoke set, manual review).
- Rollback plan (revert PROMPT_VERSION_CURRENT, redeploy).
