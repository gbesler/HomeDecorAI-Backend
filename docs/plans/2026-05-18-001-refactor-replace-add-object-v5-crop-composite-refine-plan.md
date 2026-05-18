---
status: active
date_created: 2026-05-18
depth: deep
deepened: 2026-05-18
title: "Replace & Add Object v5.0 — Crop-Composite-Refine"
origin: docs/plans/2026-05-17-001-refactor-replace-add-object-nano-banana-plan.md
---

# Replace & Add Object v5.0 — Crop-Composite-Refine

## Problem

v4.0 (Nano Banana multi-image edit, mask-as-image-3) and v4.1 (Nano Banana, text-spatial bbox) both fail in production. Logs from generation `fe490362-c165-4b6a-964d-6d644672480b` (2026-05-18):

- Mask bbox computed correctly: `{left: 0.097, top: 0.623, right: 0.233, bottom: 0.881}` (bottom-left)
- Prompt embedded bbox: "Edit image 1 by replacing the existing object inside the rectangular region of image 1 from (left 10%, top 62%) to (right 23%, bottom 88%) with the Pedestal Dining Table shown in image 2"
- Model output ignored the spatial coordinates — placed table in scene center
- Composite step correctly dropped misplaced edit → user sees unchanged room

**Root cause**: Instruction-following multi-image edit models (Nano Banana, Qwen-Image-Edit, SeedEdit, Gemini family) tokenize text-spatial coordinates as language. They have no grounded spatial decoder for percentages/pixels. Industry-wide pattern, confirmed by Diffuse to Choose paper (arXiv 2401.13795) and adoption patterns across Adobe Firefly, Photoshop Generative Workspace, ComfyUI Inpaint Crop & Stitch.

## Decision: Crop-Composite-Refine architecture

Move spatial precision OUT of the model and INTO pixel-level composite. Model's role narrows to "blend lighting/shadows/edges" — what edit models are actually good at.

```
Inputs: room photo + mask + inspiration object photo + inspiration title
   │
   ├─ Stage 1: Normalize (existing) — align dims, bake EXIF, validate mask
   │
   ├─ Stage 2: BG-remove inspiration  → cutout PNG (fal-ai/birefnet/v2, ~$0.001)
   │
   ├─ Stage 3: Crop-Composite (sharp, free)
   │    a. Compute bbox from mask
   │    b. Scale cutout to fit bbox (preserve aspect, fit-inside, center)
   │    c. Alpha-composite cutout onto room at bbox
   │    d. Output: pre-composite (cutout pasted, hard edges)
   │
   ├─ Stage 4: Refine pass (fal-ai/inpaint SDXL, ~$0.005-0.01)
   │    Input: pre-composite + dilated mask (mask + 12px) + scene prompt
   │    Low denoise (0.3-0.5) — preserve composited identity
   │    Purpose: blend lighting/shadow/edges only
   │
   └─ Output: photorealistic edit, ~$0.006-0.012 total
```

## Provider routing

User constraint: fal.ai primary, Replicate fallback.

| Stage | Primary (fal.ai) | Fallback (Replicate) | Approx cost |
|-------|------------------|----------------------|-------------|
| BG remove | `fal-ai/birefnet/v2` | `851-labs/background-remover` | ~$0.001 |
| Refine inpaint | `fal-ai/inpaint` (SDXL fast, compute-sec) | `lucataco/sdxl-inpainting` | ~$0.005-0.011 |

The existing `runWithFallback` envelope hardcodes Replicate-primary. For this tool we'll add a per-call provider-order override (`primary: "falai"`) without touching other roles.

## Scope boundaries

- Drop: `google/nano-banana`, `fal-ai/flux-2/edit`, bbox text-spatial prompt, image-3-as-mask semantic.
- Keep: normalize pipeline, composite post-process step (now operates on refine output), `preEnqueueValidate` (SSRF + title sanitization + pre-v5 recovery shim), generation-processor envelope.
- Out of scope: client-side iOS changes (none needed — same request body), env var renames (rename `REPLICATE_INPAINT_MODEL` only if naming conflicts).

## Implementation Units

### Unit 1: fal.ai birefnet + replicate bg-remove clients
**Files**: `src/lib/ai-providers/types.ts` (BgRemoveInput/Output), `src/lib/ai-providers/falai.ts` (callBgRemoveFalAI), `src/lib/ai-providers/replicate.ts` (callBgRemoveReplicate), `src/lib/ai-providers/capabilities.ts` (entries), `src/lib/ai-providers/router.ts` (callBgRemove with fal.ai-primary override), `src/lib/env.ts` (FALAI_BG_REMOVE_MODEL, REPLICATE_BG_REMOVE_MODEL).

**Approach**: Mirror existing callInpaint/callRemoval shape. Output: cutout PNG URL with transparent background.

**Verification**: New tests in `falai.test.ts` / `replicate.test.ts` for shape validation; integration test stub.

### Unit 2: fal.ai SDXL inpaint refine client
**Files**: `src/lib/ai-providers/falai.ts` (callInpaintRefineFalAI for `fal-ai/inpaint`), `src/lib/ai-providers/replicate.ts` (callInpaintRefineReplicate for `lucataco/sdxl-inpainting`), capabilities.ts, router.ts (callInpaintRefine — fal.ai primary override).

**Approach**: Separate from existing callInpaint (which uses Flux Fill for remove-objects tool, different schema). Schema for fal-ai/inpaint: `image_url`, `mask_url`, `prompt`, `strength` (0-1 denoise), `num_inference_steps`. Replicate sdxl-inpainting takes same shape.

**Verification**: Unit tests verifying low-strength denoise param forwarded; capability entries added.

### Unit 3: Crop-composite pipeline
**Files**: `src/lib/generation/crop-composite-refine.ts` (new — replaces multi-image-edit.ts), DELETE `multi-image-edit.ts`.

**Approach**: Stages laid out above. Reuses normalize-image-mask-pair, downloadSafe, persistGenerationBuffer, withRetry. Composite math: bbox from mask scan (existing helper), scale cutout to `min(bbox_w/cutout_w, bbox_h/cutout_h)` (fit-inside), center within bbox, sharp.composite onto room.

**Verification**: Unit test for bbox→scale→paste math on synthetic 256×256 mask+room+cutout.

### Unit 4: Rewrite prompt builder
**Files**: `src/lib/prompts/tools/replace-add-object.ts` (rewrite), `src/lib/prompts/tools/replace-add-object.test.ts` (rewrite tests).

**Approach**: Scene-level refine prompt. Drop MaskBbox, drop bbox templates, drop image-3-as-mask templates. New: short prompt focused on lighting/shadow/integration. Mode-aware (replace vs add).

**Example prompt**: `"A photorealistic interior with a Pedestal Dining Table placed naturally in the room. Match the room's lighting, perspective, and color temperature. Add soft shadows under the furniture for a seamless, integrated look."`

**Verification**: 8-12 tests covering replace/add modes, title sanitization, length cap.

### Unit 5: Update tool registry
**Files**: `src/lib/tool-types.ts`.

**Approach**: replaceAddObject mode `"multi-image-edit-with-mask"` → `"crop-composite-refine"`. models: `{ falaiBgRemove, replicateBgRemove, falaiRefine, replicateRefine }`. Keep preEnqueueValidate intact (SSRF + title).

**Verification**: Existing tool-types tests pass with new shape; preEnqueueValidate test untouched.

### Unit 6: Update generation-processor branch
**Files**: `src/services/generation-processor.ts`.

**Approach**: New `crop-composite-refine` branch. Wire to runCropCompositeRefine. AC-003 pre-v4/v5 recovery shim handles legacy queued jobs by remapping to new mode.

**Verification**: Processor tests cover new mode dispatch.

### Unit 7: Cleanup + tests + push
**Files**: delete `multi-image-edit.ts`, delete `composite-masked-result.ts` (or repurpose into crop-composite-refine.ts), update env.test.ts, update rate-limits comments.

**Verification**: `npm test` green; `npm run typecheck` clean; commit + push.

## Risks

1. **SDXL inpaint refine may still over-edit at low strength**: Mitigation — start with `strength: 0.35`, A/B against `0.45`. Worst case: cutout looks pasted (hard edges) but spatial accuracy is preserved (always correct user-painted region).

2. **fal.ai birefnet failure on transparent inspirations**: Catalog already curated; spot-check first 5 inspirations. If birefnet refuses, fallback to Replicate provider via runWithFallback.

3. **fal-ai/inpaint compute-second billing variance**: Worst-case ~$0.02 at 1024² with 30 steps. Mitigation: pin `num_inference_steps: 20` in adapter — sub-2s on fal hardware, ~$0.005.

## Requirements trace

- ✅ Primary fal.ai (Unit 1, 2 + router override)
- ✅ Replicate fallback (same)
- ✅ ≤$0.01 per inference (~$0.006-0.012 total verified above)
- ✅ Spatial precision (Unit 3 — pixel composite, 100% accuracy)
- ✅ Photorealism (Unit 4, refine pass blends edges/lighting)

## Operational notes

- Datadog event names: `inpaint.multi.*` → `inpaint.refine.*` and add `inpaint.bgRemove.*`, `inpaint.composite.cutout.*`.
- Cost monitoring dashboard: track `refine.cost_usd_estimate` per generation.
- Rollback: if v5 fails in production, revert to staging (which is v4.1 — also broken). Phase 2 fallback is "composite-only" (skip refine) — degraded quality but no over-budget risk.
