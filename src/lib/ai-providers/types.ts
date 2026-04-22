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
  outputFormat?: string;
  guidanceScale?: number;
}

export interface GenerationOutput {
  imageUrl: string;
  provider: ProviderId;
  durationMs: number;
  requestId?: string;
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
