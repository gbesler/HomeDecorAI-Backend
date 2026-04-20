/**
 * Provider capability matrix — keyed by modelId (not provider name) so
 * future models per provider can coexist with distinct capabilities.
 *
 * Values are authoritative findings from:
 * - BFL Flux 2 Prompting Guide: https://docs.bfl.ml/guides/prompting_guide_flux2
 *   → "FLUX.2 does not support negative prompts."
 * - BFL Flux Kontext I2I Guide: https://docs.bfl.ml/guides/prompting_guide_kontext_i2i
 * - Pruna p-image-edit docs: https://docs.pruna.ai/en/stable/docs_pruna_endpoints/performance_models/p-image-edit.html
 *   → input schema lists only: images, prompt, reference_image, aspect_ratio,
 *     width, height, seed, disable_safety_checker. NO negative_prompt,
 *     NO guidance_scale, NO num_inference_steps.
 * - fal.ai flux-2/klein/9b/edit model page: https://fal.ai/models/fal-ai/flux-2/klein/9b/edit
 *   → schema: prompt, image_urls, seed, num_inference_steps (default 28,
 *     range 4-50), guidance_scale (default 2.5, range 0-20), image_size,
 *     sync_mode, enable_safety_checker, output_format, acceleration.
 *     NO negative_prompt. NO enable_prompt_expansion.
 *
 * Verified: 2026-04-10. If provider updates surface in production (schema
 * rejections, silent drops, quality regressions), re-verify the source docs
 * and update this file.
 *
 * Token budgets:
 * - Pruna: base model unverified; Flux Schnell-class models typically
 *   tolerate 256+ tokens comfortably. Target 280 so the full 7-layer
 *   composition (including photography-quality + lighting tails) survives
 *   without routine truncation. Still well under any reasonable T5 ceiling.
 * - fal Klein: Flux 2 token limit not formally published, but BFL's own
 *   Kontext I2I guide routinely ships 300-400 token prompts. Target 350
 *   so rich style descriptors + preservation clauses fit even for
 *   complex interior scenes. Well above the "<100 words creates confusion"
 *   floor flagged in the Klein guide.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

import type { ProviderId } from "./types.js";

export type { ProviderId };

/**
 * Role of a model in the generation pipeline.
 * - `edit`:    single-step image-to-image (Pruna, Klein) — prompt + image → image.
 * - `segment`: concept-prompted mask generation (SAM 3) — image + concept → mask.
 * - `remove`:  mask-guided object removal (LaMa) — image + mask → image.
 *              No prompt; LaMa extends the surrounding surface using Fourier
 *              convolutions. This is the industry-standard pattern behind
 *              Cleanup.pictures, IOPaint, Magic Eraser, and Apple Clean Up.
 */
export type ModelRole = "edit" | "segment" | "remove" | "inpaint";

export interface ProviderCapabilities {
  provider: ProviderId;
  role: ModelRole;
  supportsNegativePrompt: boolean;
  supportsGuidanceScale: boolean;
  /**
   * Whether the model accepts a second image as a style reference alongside
   * the primary input image. Pruna p-image-edit exposes this via `images[]`
   * (1-5 items) + `reference_image` index. fal.ai flux-2/edit accepts
   * multiple `image_urls`. Single-image models (flux-klein-edit) leave this
   * false so the provider layer does not silently drop the second URL.
   */
  supportsReferenceImage: boolean;
  maxPromptTokens: number;
  defaultAspectRatio?: string;
  defaultImageSize?: string;
}

// ─── Capability matrix ─────────────────────────────────────────────────────

export const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  "prunaai/p-image-edit": {
    provider: "replicate",
    role: "edit",
    supportsNegativePrompt: false, // Flux family + Pruna schema does not expose it
    supportsGuidanceScale: false, // Distilled sub-second model, no CFG knob
    // Native reference-style support via images[] + reference_image index.
    // Docs: https://docs.pruna.ai/en/stable/docs_pruna_endpoints/performance_models/p-image-edit.html
    supportsReferenceImage: true,
    maxPromptTokens: 280, // Schnell-class comfortably handles this; leaves headroom for tail layers
    defaultAspectRatio: "16:9",
  },
  "fal-ai/flux-2/klein/9b/edit": {
    provider: "falai",
    role: "edit",
    supportsNegativePrompt: false, // BFL: Flux 2 does not support negative prompts
    supportsGuidanceScale: true, // Documented: default 2.5, range 0-20
    // Klein 9B Edit schema accepts `image_urls` as an array; the
    // reference-style tool ships both target and reference here. Behavior is
    // not formally documented as multi-reference editing — A/B against the
    // primary (Pruna) before relying on the fallback for production traffic.
    supportsReferenceImage: true,
    maxPromptTokens: 350, // BFL Kontext I2I examples routinely exceed 300 tokens
    defaultImageSize: "landscape_4_3",
  },
  // ─── Segmentation: SAM 3 ─────────────────────────────────────────────────
  // Meta Segment Anything 3 (November 2025). Unified foundation model with
  // native concept prompts: short noun phrases like "clutter", "yellow school
  // bus", or image exemplars. GroundingDINO sandwich is no longer required —
  // SAM 3 understands concepts directly. Community Replicate wrapper exposes
  // image + concept inputs and returns a binary mask URL.
  //
  // Paper: https://arxiv.org/abs/2511.16719
  // Replicate: https://replicate.com/mattsays/sam3-image (~$0.001/run)
  "mattsays/sam3-image": {
    provider: "replicate",
    role: "segment",
    supportsNegativePrompt: false,
    supportsGuidanceScale: false,
    // SAM 3 natively supports image exemplars as a second prompt modality.
    // We don't use this today (v1 sticks to concept prompts) but the
    // capability is true at the model level.
    supportsReferenceImage: true,
    // Concept prompts are short noun phrases, typically 1-5 words separated
    // by ".". 128 tokens is generous headroom.
    maxPromptTokens: 128,
  },
  // ─── Removal: LaMa ───────────────────────────────────────────────────────
  // Resolution-robust Large Mask Inpainting with Fourier Convolutions (WACV
  // 2022). Industry standard for "extend the surface that was behind this
  // object" — behind Cleanup.pictures, Sanster/IOPaint, Apple Clean Up.
  //
  // LaMa takes image + mask ONLY. It does NOT accept a prompt; attempting to
  // pass one is ignored at best and schema-rejected at worst. The model
  // reliably extends periodic textures and structured backgrounds without
  // hallucinating new objects — the exact failure mode FLUX Fill has in
  // remove-style use cases.
  //
  // Paper: https://github.com/advimman/lama
  // Primary: https://replicate.com/cjwbw/lama  — active community mirror
  // Fallback (pulled 2026-04-20): https://replicate.com/allenhooo/lama
  //
  // Both slugs stay registered so an env flip back to `allenhooo/lama`
  // (if the upstream returns) or over to any other pinned version hash
  // (`cjwbw/lama:<sha>`) doesn't trip the role-mismatch warning in the
  // router. The input schema (image + mask) is identical across the
  // LaMa forks — `callRemovalReplicate` sends `{ image, mask }` and
  // expects a single output image URL.
  "cjwbw/lama": {
    provider: "replicate",
    role: "remove",
    supportsNegativePrompt: false,
    supportsGuidanceScale: false,
    supportsReferenceImage: false,
    maxPromptTokens: 0,
  },
  "allenhooo/lama": {
    provider: "replicate",
    role: "remove",
    supportsNegativePrompt: false,
    supportsGuidanceScale: false,
    supportsReferenceImage: false,
    maxPromptTokens: 0,
  },
  // ─── Inpainting with prompt: Flux Fill ────────────────────────────────────
  // Black Forest Labs Flux Fill (Dec 2024). Image + mask + prompt →
  // inpainted image. Used by the Replace & Add Object tool: user paints the
  // region, selects an inspiration item, the item's prompt drives what Flux
  // Fill synthesizes inside the mask. Distinct from LaMa (no prompt) — Flux
  // Fill generates NEW content rather than extending surrounding surface.
  //
  // Mask convention on the model: white = region to fill, matches ours.
  // Replicate: https://replicate.com/black-forest-labs/flux-fill-dev (~$0.04/run)
  //            https://replicate.com/black-forest-labs/flux-fill-pro  (~$0.20/run)
  // Guidance scale on Flux Fill is on a different scale than classic CFG —
  // model card defaults: Dev ~60, Pro ~30. Tune via staging A/B.
  "black-forest-labs/flux-fill-dev": {
    provider: "replicate",
    role: "inpaint",
    supportsNegativePrompt: false,
    supportsGuidanceScale: true,
    supportsReferenceImage: false,
    maxPromptTokens: 512,
  },
  "black-forest-labs/flux-fill-pro": {
    provider: "replicate",
    role: "inpaint",
    supportsNegativePrompt: false,
    supportsGuidanceScale: true,
    supportsReferenceImage: false,
    maxPromptTokens: 512,
  },
};

// ─── Guidance scale band → numeric map (fal Klein only) ───────────────────

/**
 * Band → numeric value for fal Klein 9B Edit. Pruna ignores these entirely
 * (supportsGuidanceScale: false).
 *
 * Calibration source: fal Klein guide suggests 2-4 as interpretive and 5-8
 * as strict. Default 2.5 is the Klein default. Relook-Backend ships 3.5 in
 * production for its hair-color route. These are starting points — tune via
 * manual comparison once dictionaries are populated.
 */
export const KLEIN_GUIDANCE_BANDS = {
  creative: 2.0,
  balanced: 3.0,
  faithful: 5.0,
} as const;
