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

export interface ProviderCapabilities {
  provider: ProviderId;
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
