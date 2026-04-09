import type { Provider } from "../circuit-breaker.js";

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
