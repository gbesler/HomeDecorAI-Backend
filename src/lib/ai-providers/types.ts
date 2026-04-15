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
