/**
 * Canonical identifier for an AI provider. Used across the circuit breaker,
 * provider router, and capability matrix. Add new providers here only.
 */
export type ProviderId = "replicate" | "falai";

export interface GenerationInput {
  prompt: string;
  imageUrl: string;
  /**
   * Optional second image used as a style reference (e.g. reference-style tool).
   * Providers that don't expose multi-image input (capabilities.supportsReferenceImage=false)
   * silently ignore this field.
   */
  referenceImageUrl?: string;
  /**
   * Additional images beyond `imageUrl` (slot 1) and `referenceImageUrl`
   * (slot 2). Appended to the provider's image array in order — so the
   * full ordering reaching the model is
   *   [imageUrl, referenceImageUrl, ...extraImageUrls].
   *
   * Used by the Replace & Add Object pipeline to send a brush mask as
   * a third image (image 3 in the instructional prompt). The mask is
   * NOT a "style reference" in the v3.x sense and would be misleading
   * to overload onto `referenceImageUrl`. Providers whose capability
   * matrix does not advertise multi-image support
   * (`supportsReferenceImage: false`) silently drop this field — same
   * behavior as `referenceImageUrl`.
   *
   * Providers' practical image-array caps (per capabilities.ts notes):
   *   google/nano-banana       — 14 images
   *   fal-ai/flux-2/edit       — 4 images
   *   prunaai/p-image-edit     — 5 images (target + up to 4 refs)
   *   fal-ai/flux-2/klein/9b/edit — multiple `image_urls` accepted
   *
   * The router callers are responsible for not exceeding the target
   * model's cap — there is no defensive truncation here because the
   * model's schema rejection is itself a useful regression signal.
   */
  extraImageUrls?: string[];
  outputFormat?: string;
  guidanceScale?: number;
  // (extraImageUrls filter helper lives below — kept colocated with
  // the GenerationInput shape so both provider adapters consume an
  // identical capability gate + URL filter without copy-paste.)
  /**
   * Aspect ratio snapped to one of the provider's supported enum values
   * (e.g. "16:9", "4:3", "1:1", "3:4", "9:16"). When set, the adapter
   * forwards it under the provider-specific field (`aspect_ratio` for
   * Pruna/Kontext/Nano Banana, `image_size` label for Klein) so the
   * output matches the input photo's orientation instead of the
   * provider's undocumented default.
   *
   * When absent, the adapter sends nothing and the provider falls back
   * to its own default — historically this has produced AR mismatches
   * between before/after frames in the iOS detail view.
   */
  aspectRatio?: string;
}

export interface GenerationOutput {
  imageUrl: string;
  provider: ProviderId;
  durationMs: number;
  requestId?: string;
}

/**
 * Provider-adapter helper. Returns the validated subset of
 * `input.extraImageUrls` that should ride along after `imageUrl` and
 * `referenceImageUrl` in the model's image array. Gates on
 * `supportsReferenceImage: true` (same capability that enables the
 * primary reference slot) because a model without multi-image support
 * has no way to disambiguate the extras and would silently drop or
 * schema-reject them. Filters out non-string and empty entries.
 *
 * Shared between `callReplicate` and `callFalAI` so any future change
 * (additional capability gate, length cap, URL validation pass) lives
 * in one place rather than diverging across adapters.
 */
export function resolveExtraImageUrls(
  capabilities: { supportsReferenceImage?: boolean } | undefined,
  input: { extraImageUrls?: string[] },
): string[] {
  if (capabilities?.supportsReferenceImage !== true) return [];
  if (!Array.isArray(input.extraImageUrls)) return [];
  return input.extraImageUrls.filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
}

// ─── Segmentation (Grounded-SAM family) ─────────────────────────────────────

export interface SegmentationInput {
  imageUrl: string;
  /**
   * Comma-separated object taxonomy fed to the text-grounding head, e.g.
   * "clothes, cups, bottles, papers". The model returns the union mask of
   * every matched region.
   */
  textPrompt: string;
}

export interface SegmentationOutput {
  /** Public URL of the binary mask PNG (white = fill, black = preserve). */
  maskUrl: string;
  provider: ProviderId;
  durationMs: number;
}

/**
 * Raised when the segmentation model returns no mask (image genuinely had
 * no matches for the taxonomy). Callers translate this into a user-facing
 * "already clean" message rather than a generic failure.
 */
export class NoMaskDetectedError extends Error {
  constructor(message = "Segmentation returned no mask") {
    super(message);
    this.name = "NoMaskDetectedError";
  }
}

// ─── Removal (LaMa family) ──────────────────────────────────────────────────
//
// LaMa accepts image + mask only. No prompt, no guidance scale. The model
// extends the surrounding surface behind the masked region using Fourier
// convolutions. This is the industry-standard pattern for "make this region
// look like what's around it" — what users mean when they say "remove this".

export interface RemovalInput {
  imageUrl: string;
  /** Binary mask PNG URL — white pixels are removed, black preserved. */
  maskUrl: string;
  /**
   * Pixel dimensions image + mask were normalized to upstream (when
   * known). Purely a diagnostic passthrough — the provider does not
   * feed this into the LaMa call. Logged on an `empty_response` so a
   * future regression is diagnosable from logs alone without having to
   * re-download the S3 artifacts.
   */
  normalizedDims?: { width: number; height: number };
}

export interface RemovalOutput {
  imageUrl: string;
  provider: ProviderId;
  durationMs: number;
}

// ─── Background removal (BiRefNet family) ─────────────────────────────────
//
// Background-removal models accept an image and return a PNG cutout with
// transparent background. Used by the Replace & Add Object v5.0 pipeline
// (crop-composite-refine) to isolate the inspiration object before pasting
// it into the masked region of the room.

export interface BgRemoveInput {
  /** Public URL of the source image to cut out. */
  imageUrl: string;
}

export interface BgRemoveOutput {
  /** Public URL of the cutout PNG (transparent background). */
  imageUrl: string;
  provider: ProviderId;
  durationMs: number;
}

// ─── Inpainting with prompt (Flux Fill family) ─────────────────────────────
//
// Flux Fill (and peers like SDXL Inpainting) accept image + mask + prompt,
// generating NEW content inside the masked region guided by the prompt. This
// is the "replace the thing with a different thing" pipeline — distinct from
// LaMa's "remove the thing and extend surroundings" (no prompt).
//
// Mask convention: white pixels = region to replace, black = preserve. Matches
// the convention used across the codebase for Remove Objects and SAM outputs.

export interface InpaintInput {
  imageUrl: string;
  /** Binary mask PNG URL — white = replace, black = preserve. */
  maskUrl: string;
  /** Natural-language description of what to place in the masked region. */
  prompt: string;
  /**
   * Optional guidance scale forwarded only to models that expose it
   * (`capabilities.supportsGuidanceScale`). Flux Fill's "guidance" parameter
   * is on a different scale than classic CFG — see model card for ranges.
   */
  guidanceScale?: number;
  /**
   * Pixel dimensions image + mask were normalized to upstream (when
   * known). Purely a diagnostic passthrough — logged on an
   * `empty_response` so a future regression is diagnosable from logs
   * alone without re-downloading the S3 artifacts. Mirrors
   * `RemovalInput.normalizedDims`.
   */
  normalizedDims?: { width: number; height: number };
}

export interface InpaintOutput {
  imageUrl: string;
  provider: ProviderId;
  durationMs: number;
}
