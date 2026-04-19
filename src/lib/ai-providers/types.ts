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
}

export interface RemovalOutput {
  imageUrl: string;
  provider: ProviderId;
  durationMs: number;
}
