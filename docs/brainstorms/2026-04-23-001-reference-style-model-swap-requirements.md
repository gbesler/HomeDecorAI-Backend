---
title: Reference-Style Model Swap + Hard-Failure Fallback
date: 2026-04-23
status: ready-for-planning
scope: standard
---

# Reference-Style Model Swap + Hard-Failure Fallback

## Problem

The reference-style tool produces near-identity output — users report the result image is effectively unchanged from the input (only a slight aspect-ratio re-encoding). The tool is currently routed to `prunaai/p-image-edit`, a distilled sub-second edit model with no CFG knob and weak prompt adherence. Its `reference_image` parameter only flags which image to preserve — it does not force the model to extract and apply style from the second image. The model is not trained for cross-image style transfer.

The secondary provider (`fal-ai/flux-2/klein/9b/edit`) accepts `image_urls` as an array but its multi-reference behavior is undocumented (noted in `src/lib/ai-providers/capabilities.ts:104-106`). Neither currently-wired model is a verified fit for this tool.

## Goal

Route the reference-style tool to a model genuinely capable of "apply image 2's style to image 1", with a hard-failure fallback on a different provider for reliability.

## Non-goals

- Changing the model for any other tool. Interior, exterior, garden, patio, pool, virtual-staging, outdoor-lighting, exterior-painting, floor-restyle, wall-paint all stay on `prunaai/p-image-edit`. Current flow preserved everywhere except reference-style.
- Quality-failure fallback (perceptual similarity oracle, retry on near-identity output). Out of scope — addressed by model selection, not fallback logic.
- UI bug where reference-style renders an empty "tool parameters" card on iOS. Tracked separately.

## Decisions

**Candidate shortlist (approved):**
1. `fal-ai/flux-pro/kontext/multi` — schema explicitly supports multiple reference images
2. `google/nano-banana` on Replicate — multimodal Gemini 2.5 Flash Image, semantic "apply style of image 2" understanding
3. `bytedance/seedream/v4/edit` — strong multi-image editor, backup candidate

**Routing model:**
- Reference-style tool declares its own `primaryModel` + `fallbackModel`. Other tools untouched.
- Primary and fallback must live on different providers (Replicate ↔ fal) for provider-diversity reliability.
- Working assumption: **primary = `fal-ai/flux-pro/kontext/multi`, fallback = `google/nano-banana`**. Seedream 4 held in reserve as a replacement candidate if A/B shows Kontext Multi under-performs.

**Fallback scope:**
- **Hard-failure only**: HTTP timeout, 5xx, schema reject, provider-level 4xx-with-error-body.
- No quality-gated fallback. A near-identity output is not a trigger for fallback.

## Success criteria

1. On a fixed set of (input, style-reference) image pairs drawn from representative interior and exterior scenes, the primary model produces outputs that visibly adopt the reference's palette/materials/mood while preserving input geometry. "Visibly" judged by manual inspection across ≥5 pairs before production rollout.
2. When the primary provider is unavailable (simulated via forced 5xx or timeout), the reference-style endpoint transparently serves a result from the fallback model within the existing request SLA.
3. No regression on other tools. They remain on `prunaai/p-image-edit` with unchanged behavior.

## Open questions for planning

- Does `fal-ai/flux-pro/kontext/multi` accept the same prompt structure the current builder produces, or does it need a different prompt shape? Verify current schema against existing `reference-style.ts` layer composition.
- Where does the fallback decision live — inside `replicate.ts` / `falai.ts` adapters, or one level up in a provider-router? Current code couples model selection to prompt builder (`PRIMARY_MODEL` const). Registry-level routing is the natural extension.
- Does `google/nano-banana` on Replicate accept 2+ input images in a single call, and what field name? Verify Replicate schema before wiring.
- Guidance scale semantics for Kontext Multi — is `KLEIN_GUIDANCE_BANDS` reusable or does Kontext need its own band table?

## Handoff

Ready for `/ce:plan`. Planning should start by verifying current schemas for the three candidate models via context7, then design the tool-level routing extension.
