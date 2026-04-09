export type Provider = "replicate" | "falai";

export interface GenerationInput {
  prompt: string;
  imageUrl: string;
  outputFormat?: string;
  guidanceScale?: number;
}

export interface GenerationOutput {
  imageUrl: string;
  provider: Provider;
  durationMs: number;
  requestId?: string;
}
