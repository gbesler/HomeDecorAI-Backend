---
title: "feat: Reference-Style Model Swap + Hard-Failure Fallback"
type: feat
status: completed
date: 2026-04-23
origin: docs/brainstorms/2026-04-23-001-reference-style-model-swap-requirements.md
---

# feat: Reference-Style Model Swap + Hard-Failure Fallback

## Overview

Route the reference-style tool off `prunaai/p-image-edit` (weak at cross-image style transfer, producing near-identity output in production) and onto a reference-aware editing model. Ship with a hard-failure fallback on a different provider for reliability. No changes to any other tool.

## Problem Frame

Users report reference-style output is effectively the input image with only minor aspect-ratio re-encoding. Pruna p-image-edit is a distilled sub-second edit model with no CFG knob and weak prompt adherence — its `reference_image` index flags which image to preserve, not which to extract style from. The secondary `fal-ai/flux-2/klein/9b/edit` is also undocumented for multi-reference behavior (see origin: `docs/brainstorms/2026-04-23-001-reference-style-model-swap-requirements.md`). Neither currently-wired model is a verified fit.

## Requirements Trace

- R1. Reference-style produces visibly transferred output on representative (input, reference) pairs (origin §Success criteria #1)
- R2. Hard-failure fallback (timeout/5xx/schema-reject) transparently serves a result from a different provider (origin §Success criteria #2)
- R3. No regression on other tools — they stay on `prunaai/p-image-edit` (origin §Success criteria #3, §Non-goals)
- R4. Quality-failure fallback is explicitly out of scope (origin §Non-goals)

## Scope Boundaries

- Only the reference-style tool's model routing changes. Interior, exterior, garden, patio, pool, virtual-staging, outdoor-lighting, exterior-painting, floor-restyle, paint-walls untouched.
- No perceptual-similarity oracle, no retry-on-near-identity logic.
- UI bug (iOS renders an empty "tool parameters" card for reference-style) is tracked separately.
- Seedream 4 is held in reserve — added only if Kontext Multi under-performs in manual review.

## Context & Research

### Relevant Code and Patterns

- `src/lib/ai-providers/router.ts` — `callDesignGeneration(models, input)` already implements hard-failure fallback via circuit breaker + retry. Today it's hardcoded Replicate-primary → fal-fallback. Per-tool primary override is the natural extension point.
- `src/lib/ai-providers/capabilities.ts` — per-model capability matrix (`supportsReferenceImage`, `supportsGuidanceScale`, `maxPromptTokens`). `PROVIDER_CAPABILITIES` is keyed on model slug and consumed by both adapters.
- `src/lib/ai-providers/falai.ts` — sends `image_urls` (array of URL strings). Kontext Max Multi uses the same schema (verified on the fal model page during execution, not different as an earlier draft suggested). The existing Klein code path handles it without a branch; only the capability registration changes.
- `src/lib/ai-providers/replicate.ts` — Pruna-specific logic around `reference_image` index + `images[]`. A new Replicate model (Nano Banana) will need its own input-shape branch.
- `src/lib/tool-types.ts:148` — each tool declares `models: { replicate, falai }`. Reference-style's pair is where the swap lands.
- `src/lib/prompts/tools/reference-style.ts` — prompt builder. Currently preservation-heavy ("merely restyle materials"); a model with strong transfer capability benefits from a more direct directive.
- `src/services/generation-processor.ts:458` — the single call site: `callDesignGeneration(tool.models, {...})`.

### Institutional Learnings

- Positive-avoidance invariant for Flux models is already codified in `src/lib/prompts/primitives/positive-avoidance.ts`. Kontext Multi is also BFL Flux-family — the same "no negative prompts" rule applies. Reuse the primitive.

### External References

- fal Kontext Max Multi schema (verified via WebFetch on the fal model page during execution): `image_urls: string[]` + `prompt`, plus optional `guidance_scale` (default 3.5), `seed`, `num_images`, `output_format`, `aspect_ratio`, `safety_tolerance`, `enhance_prompt`, `sync_mode`. Same field name and shape as Klein 9B Edit — the trained-for-multi-reference semantics differ, not the payload shape. (Source: fal.ai/models/fal-ai/flux-pro/kontext/max/multi/api)
- Replicate Nano Banana (`google/nano-banana`) schema was not retrievable via context7. First implementation unit must fetch it from `https://api.replicate.com/v1/models/google/nano-banana` openapi_schema before wiring the adapter.

## Key Technical Decisions

- **Primary + fallback:** `fal-ai/flux-pro/kontext/max/multi` as primary, `google/nano-banana` as fallback. Provider diversity (fal ↔ Replicate) preserved — if one cloud degrades, the tool still serves. Rationale: (a) Kontext Multi's schema is explicitly multi-reference, (b) Nano Banana is multimodal Gemini with semantic understanding of "apply style of image 2 to image 1", (c) different providers → independent failure domains.
- **Router extension via provider-primary override:** add optional `primaryProvider: "replicate" | "falai"` on `ToolModelConfig` (default `"replicate"`). Router reads it and dispatches accordingly. This keeps every other tool's flow byte-identical while unblocking the reference-style swap. Rationale: smaller blast radius than a full router refactor.
- **Separate breaker counters per provider:** existing `designCircuitBreaker` tracks Replicate health globally. With a second tool pushing fal as primary, one shared counter mixes unrelated signals. Introduce a paired breaker so each provider's health is tracked independently. Rationale: without this, Pruna flakes on the 10 other tools would open the breaker and route reference-style's Nano Banana fallback through a breaker it doesn't need.
- **Kontext Multi prompt body:** drop the "merely restyle" hedging. A model with strong transfer capability doesn't need instructions to avoid changing things — that framing fought Pruna's weakness, not a real requirement. Keep structural preservation (geometry, layout) explicit; lean harder on "adopt image 2's palette/materials/lighting".
- **Guidance scale:** Kontext Max Multi documentation surfaces `prompt` + `images` only; no `guidance_scale` in the multi endpoint schema. Remove `guidanceScale` / `guidanceBand` from the reference-style `PromptResult` payload when targeting Kontext Multi. Verify during Unit 1 schema fetch — if a guidance knob exists, calibrate it later; this plan does not assume it.
- **No quality-gated fallback:** a near-identity output is not a fallback trigger. Hard-failure only (timeout, 5xx, schema reject, 4xx with error body). Quality is resolved by model selection, not retry logic.

## Open Questions

### Resolved During Planning

- **Primary vs fallback side:** fal is primary because Kontext Multi is the schema-verified multi-reference model. Nano Banana is the semantic-understanding backup.
- **Router architecture:** extend in place with per-call primary-provider flag, not parallel router entry point.
- **Fallback scope:** hard-failure only (origin-confirmed).
- **Scope of change:** one tool only — reference-style.

### Deferred to Implementation

- **Nano Banana input shape:** exact field name for the second image (`image_input`, `images`, `reference_image`, or array under `prompt`-adjacent field). Unit 1 fetches the OpenAPI schema before the adapter branch is written.
- **Circuit-breaker separation:** whether to duplicate the class (`replicateCircuitBreaker` + `falaiCircuitBreaker`) or parameterize the existing one. Decide when touching `src/lib/circuit-breaker.ts` in Unit 3.
- ~~**Kontext Multi `content_type` derivation**~~ — moot: the verified schema uses `image_urls: string[]`, not `images: [{url, content_type}]`. No MIME inference needed.
- **Final prompt tuning:** Kontext prefers natural-language directives. Exact wording settles during manual A/B after Unit 4 lands.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Tool registry (reference-style entry)
  models: { replicate: "google/nano-banana",
            falai:     "fal-ai/flux-pro/kontext/max/multi",
            primaryProvider: "falai" }                     ◄── new optional field

generation-processor.ts:458
  callDesignGeneration(tool.models, input)

router.ts::callDesignGeneration
  ├─ read models.primaryProvider (default "replicate")
  ├─ if "falai":  try fal → on hard-failure → replicate
  └─ if "replicate": try replicate → on hard-failure → fal     ◄── existing flow
       (breaker state tracked per-provider, not shared)

falai.ts
  if model == "fal-ai/flux-pro/kontext/max/multi":
      body = { prompt, image_urls: [url, ...], guidance_scale }  ◄── reuses Klein path
  else (Klein):
      body = { prompt, image_urls: [...], guidance_scale }    ◄── existing

replicate.ts
  if model == "google/nano-banana":
      body = { /* TBD from OpenAPI schema — Unit 1 */ }       ◄── new branch
  else (Pruna):
      body = { images, prompt, reference_image: "1" }         ◄── existing
```

## Implementation Units

- [ ] **Unit 1: Verify schemas and extend capabilities matrix**

**Goal:** Fetch the authoritative input schemas for `fal-ai/flux-pro/kontext/max/multi` and `google/nano-banana`; record capability flags and token budgets in the matrix. Nothing else depends on speculation about field names.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/lib/ai-providers/capabilities.ts`
- Test: `src/lib/ai-providers/__tests__/capabilities.test.ts` (or equivalent — mirror the file the matrix already has; if absent, add alongside)

**Approach:**
- Fetch Kontext Multi schema via fal's published API docs or a lightweight authenticated GET.
- Fetch Nano Banana schema via `GET https://api.replicate.com/v1/models/google/nano-banana` and inspect `latest_version.openapi_schema.components.schemas.Input`.
- Add both models to `PROVIDER_CAPABILITIES` with `role: "edit"`, correct `supportsReferenceImage`, `supportsGuidanceScale`, `supportsNegativePrompt`, `maxPromptTokens`. Include a header comment citing the source URL and the date verified.

**Patterns to follow:**
- Existing entries in `capabilities.ts:86-110` — source URL in comment, verification date, capability flags.

**Test scenarios:**
- Happy path: `getCapabilities("fal-ai/flux-pro/kontext/max/multi")` returns entry with `provider: "falai"`, `supportsReferenceImage: true`.
- Happy path: `getCapabilities("google/nano-banana")` returns entry with `provider: "replicate"`, `supportsReferenceImage: true`.
- Edge case: versioned slug (`google/nano-banana:abc123`) resolves via the existing `split(":")[0]` path.

**Verification:**
- Matrix keys include both new models. Source URL and verification date are in header comments. Tests for the two new lookups pass.

- [ ] **Unit 2: fal adapter — Kontext Multi input shape branch**

**Goal:** Verify the Kontext Multi input body reuses the Klein `image_urls: string[]` shape (confirmed during execution; no per-object structure needed) and refresh the adapter's comment so the multi-reference use case is documented.

**Requirements:** R1

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/ai-providers/falai.ts`
- Test: `src/lib/ai-providers/__tests__/falai.test.ts` (mirror structure if absent)

**Approach:**
- Branch on model slug inside the body builder. Kontext Multi branch maps `GenerationInput` image URLs into objects with URL + inferred content type.
- Derive `content_type` from URL extension (`.jpg`/`.jpeg` → `image/jpeg`, `.png` → `image/png`, `.webp` → `image/webp`). If extension is missing or unrecognized, default to `image/jpeg` and log a warning — do not fail the request.
- Do not send `guidance_scale` for Kontext Multi unless Unit 1 confirmed the field exists on the Multi endpoint.
- Log `{event: "provider.kontext_multi_call", imageCount, contentTypes}` at info.

**Patterns to follow:**
- Existing Klein dispatch in `falai.ts` — conditional on `capabilities.supportsReferenceImage` and branching on input shape.

**Test scenarios:**
- Happy path: two-URL input with `.jpg` and `.png` produces `images: [{url, content_type: "image/jpeg"}, {url, content_type: "image/png"}]`.
- Edge case: URL with no extension (`https://…/abc123?sig=…`) defaults to `image/jpeg` and emits the warning log.
- Edge case: single-image input (no reference) still produces a valid `images` array of length 1.
- Error path: fal returns 400 with error body → adapter throws a hard-failure error that the router can classify for fallback.

**Verification:**
- Kontext Multi body matches the fal documented schema exactly. Klein calls still produce the unchanged `image_urls` shape. Tests green.

- [ ] **Unit 3: Router — per-tool primary-provider override + per-provider breaker**

**Goal:** Let reference-style dispatch fal-first without forking the router or breaking the Replicate-first flow for every other tool.

**Requirements:** R2, R3

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/ai-providers/router.ts`
- Modify: `src/lib/circuit-breaker.ts`
- Test: `src/lib/ai-providers/__tests__/router.test.ts` (mirror structure if absent)

**Approach:**
- Extend `ToolModelConfig` with `primaryProvider?: "replicate" | "falai"` (default `"replicate"`).
- In `callDesignGeneration`, read the flag and branch: existing flow for `"replicate"`, mirrored flow for `"falai"` (try fal first with retry + breaker, hard-failure → Replicate, probe on cooldown).
- Split `designCircuitBreaker` into two independently-tracked breakers (`replicateDesignBreaker`, `falaiDesignBreaker`) so a Replicate degradation doesn't force reference-style's Nano Banana fallback path through a breaker that represents unrelated signals.
- Log which provider was primary and whether fallback fired, including the model slug.

**Patterns to follow:**
- Existing `callDesignGeneration` retry + breaker envelope. Mirror it, don't abstract yet — two instances is fine; premature abstraction hurts readability.

**Test scenarios:**
- Happy path: `primaryProvider` unset → Replicate primary, fal fallback (regression guard for all other tools).
- Happy path: `primaryProvider: "falai"` → fal primary, Replicate fallback.
- Error path: fal primary times out → router catches, calls Replicate, returns its result.
- Error path: fal primary throws schema-reject (4xx with body) → classified as hard failure, fallback fires.
- Edge case: both providers fail → error propagates with both failure reasons logged.
- Integration: breaker open on Replicate → unaffected tools (fal primary) still succeed; open on fal → reference-style falls through to Nano Banana on next call.

**Verification:**
- Every existing tool's generation path behaves identically to pre-change (snapshot via fixture or explicit test). Reference-style's dispatch order is reversed. Breakers counted separately.

- [ ] **Unit 4: Replicate adapter — Nano Banana input shape branch**

**Goal:** Implement the Replicate-side adapter path for `google/nano-banana` so the Unit 3 fallback actually works end-to-end.

**Requirements:** R2

**Dependencies:** Unit 1, Unit 3

**Files:**
- Modify: `src/lib/ai-providers/replicate.ts`
- Test: `src/lib/ai-providers/__tests__/replicate.test.ts`

**Approach:**
- Branch on model slug. Map target + reference URLs into the Nano Banana input shape discovered in Unit 1 (field names deferred until that schema is fetched — do not guess).
- Carry the prompt through unchanged.
- Mirror existing Pruna telemetry (`event: "provider.nano_banana_call"`) with image count and field shape.
- Keep the existing Pruna branch untouched.

**Patterns to follow:**
- Existing Pruna branch in `replicate.ts:73-94`.

**Test scenarios:**
- Happy path: two-URL input produces Nano Banana body with both images wired into the correct fields (per Unit 1 schema).
- Regression: Pruna calls produce unchanged `reference_image: "1"` + `images[]` body.
- Error path: Replicate 422 (schema-reject) surfaces as a hard-failure error the router classifies for fallback (though here it's the fallback side — error propagates to caller).

**Verification:**
- Nano Banana request body matches the Replicate OpenAPI schema. Pruna calls unchanged in shape. Tests green.

- [ ] **Unit 5: Reference-style prompt builder — retune for transfer-capable model + wire model pair**

**Goal:** Update `reference-style.ts` to target Kontext Multi's strengths, drop Pruna-era hedging, and declare the model pair at the tool registry.

**Requirements:** R1, R3

**Dependencies:** Unit 2, Unit 3

**Files:**
- Modify: `src/lib/prompts/tools/reference-style.ts`
- Modify: `src/lib/tool-types.ts` (reference-style registry entry only)
- Test: `src/lib/prompts/tools/__tests__/reference-style.test.ts`

**Approach:**
- Change `PRIMARY_MODEL` to `fal-ai/flux-pro/kontext/max/multi`. Bump `PROMPT_VERSION` to `referenceStyle/v2.0`.
- Rewrite `actionDirective` + `focusDirective` to lead with "apply image 2's palette, materials, and lighting to image 1" without the "merely restyle" softener. Keep `structural-preservation` primitive intact — geometry preservation is still a real requirement.
- Remove `guidanceScale` and `guidanceBand` from the returned `PromptResult` when targeting Kontext Multi (confirm against Unit 1 schema findings). If Unit 1 shows a guidance knob, keep it but set to a transfer-friendly value; do not inherit Klein's `faithful: 5.0`.
- In `src/lib/tool-types.ts`, update the reference-style registry entry's `models` block: `replicate: "google/nano-banana"`, `falai: "fal-ai/flux-pro/kontext/max/multi"`, `primaryProvider: "falai"`.

**Patterns to follow:**
- Existing prompt-layer composition and `trimLayersToBudget` usage in the current `reference-style.ts`. Keep the layer-priority structure; only the text content and PRIMARY_MODEL change.

**Test scenarios:**
- Happy path (interior): prompt composes with new directives; no "merely restyle" substring.
- Happy path (exterior): `scopeNoun` correctly flips to "building"; facade/cladding vocabulary present.
- Edge case: `PROMPT_VERSION` set to `v2.0` (regression guard for version telemetry).
- Edge case: token budget still respected under new Kontext `maxPromptTokens` from Unit 1.
- Integration: registry entry's `models.primaryProvider === "falai"` and both slugs match Unit 1's capability matrix.

**Verification:**
- Running the tool end-to-end against fal hits Kontext Multi and returns an output image whose palette visibly matches image 2 on at least 3 of 5 manual test pairs (interior + exterior mix). Spot-check against "image = input" failure mode.

- [ ] **Unit 6: Observability — provider + model labels in generation telemetry**

**Goal:** Make it possible to tell, from logs alone, which model served a given generation and whether a fallback fired. Needed for the post-ship manual review pass and for debugging the "output looks unchanged" class of complaints.

**Requirements:** R1, R2

**Dependencies:** Unit 3

**Files:**
- Modify: `src/lib/ai-providers/router.ts` (structured log additions)
- Modify: `src/services/generation-processor.ts` (carry `{provider, model, fallbackFired}` into the generation record or its log line)

**Approach:**
- Add `{provider, model, fallbackFired: boolean}` fields to the success + failure log lines emitted around `callDesignGeneration`.
- No persistence changes — log-only. If Firestore needs these labels later, add in a follow-up.

**Patterns to follow:**
- Existing `event:` structured log style throughout `router.ts` and `generation-processor.ts`.

**Test scenarios:**
- Happy path: successful reference-style call logs `{provider: "falai", model: "fal-ai/flux-pro/kontext/max/multi", fallbackFired: false}`.
- Error path: fal primary fails, Replicate succeeds — two log lines, second with `fallbackFired: true, provider: "replicate", model: "google/nano-banana"`.
- Regression: interior-design call (unchanged tool) still logs `{provider: "replicate", model: "prunaai/p-image-edit", fallbackFired: false}` — no new fields missing from existing tools.

**Verification:**
- Staging log search for one reference-style generation shows the new labels. Grep for `fallbackFired: true` is empty under normal operation and non-empty during a forced-failure drill.

## System-Wide Impact

- **Interaction graph:** `generation-processor.ts:458` is the single call site. Controllers, album persistence, and iOS clients are unaffected — they receive the same `GenerationOutput` shape.
- **Error propagation:** hard-failure classification (timeout, 5xx, 4xx with error body, schema reject) already lives in `falai.ts` / `replicate.ts`. No new error taxonomy.
- **State lifecycle risks:** none new. Circuit breaker state is the only stateful surface; splitting it per-provider (Unit 3) is the one risk, addressed by keeping existing tool's state intact via backward-compatible default.
- **API surface parity:** `ToolModelConfig` gains one optional field. All existing tool registry entries continue to validate. No public API changes.
- **Integration coverage:** Unit 3's breaker-separation and Unit 6's telemetry are the cross-layer behaviors — unit tests alone won't prove them. Manual staging verification is required.
- **Unchanged invariants:** every other tool's model pair, prompt builder, guidance band, and dispatch order remain byte-identical. Pruna p-image-edit branch in `replicate.ts`, Klein branch in `falai.ts`, and `designCircuitBreaker`'s existing contract all preserved.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Kontext Multi also produces weak transfer on our image pairs | Unit 5's verification gate is manual review on ≥5 pairs before declaring done. Seedream 4 is the documented swap candidate — add as a third branch in Units 2 and 5 only if needed. |
| Nano Banana schema shape differs from expectation | Unit 1 is dedicated to fetching authoritative schemas before any adapter code. No speculation allowed past Unit 1. |
| Circuit breaker split introduces regression in unrelated tools | Unit 3 explicit test: `primaryProvider` unset path must be byte-identical to current behavior. Snapshot existing `callDesignGeneration` test suite before touching. |
| Kontext Multi latency higher than Pruna (user-visible slowdown) | Expected — Pruna is sub-second, Kontext is seconds. Monitor p95 latency for reference-style in first 48h. No mitigation unless user complaint surfaces. |
| `content_type` inference wrong on edge-case URLs (e.g., S3 with no extension) | Unit 2 defaults to `image/jpeg` with a warning log. Worst case: fal rejects with 400 → fallback to Nano Banana. Not silent. |
| Fallback side also fails on first rollout (both providers degraded) | Hard-failure fallback is not infinite-retry. Second failure surfaces to caller as an error. Iterate on a third model only if post-ship logs show it. |

## Documentation / Operational Notes

- Update `src/lib/ai-providers/capabilities.ts` header with the two new source URLs and verification date (in Unit 1).
- Add a one-paragraph "Reference-style routes fal-primary" note to any backend README or routing doc that currently describes "all edit traffic goes Replicate-primary".
- After ship: 48-hour log review window for `fallbackFired: true` on reference-style — acceptable baseline is <5% of calls; anything higher signals Kontext Multi availability issues.
- Manual A/B images should be saved in `docs/brainstorms/` as a companion image review, not committed binary — reference via URL.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-04-23-001-reference-style-model-swap-requirements.md`
- Related code: `src/lib/ai-providers/router.ts`, `src/lib/ai-providers/capabilities.ts`, `src/lib/prompts/tools/reference-style.ts`, `src/lib/tool-types.ts:148`, `src/services/generation-processor.ts:458`
- External docs:
  - fal Kontext Max Multi: https://fal.ai/models/fal-ai/flux-pro/kontext/max/multi
  - Replicate Nano Banana (schema to fetch in Unit 1): https://api.replicate.com/v1/models/google/nano-banana
  - BFL Flux 2 prompting guide: https://docs.bfl.ml/guides/prompting_guide_flux2
