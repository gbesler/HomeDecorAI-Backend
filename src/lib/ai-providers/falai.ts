import { fal } from "@fal-ai/client";
import { env } from "../env.js";
import type { GenerationInput, GenerationOutput } from "./types.js";

fal.config({ credentials: env.FAL_AI_API_KEY });

const TIMEOUT_MS = 60_000;

export async function callFalAI(
  model: string,
  input: GenerationInput,
): Promise<GenerationOutput> {
  const start = Date.now();

  const result = await fal.subscribe(model, {
    input: {
      prompt: input.prompt,
      image_urls: [input.imageUrl],
      num_images: 1,
      output_format: input.outputFormat ?? "jpeg",
      ...(input.guidanceScale !== undefined && {
        guidance_scale: input.guidanceScale,
      }),
    },
    logs: true,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    pollInterval: 1000,
  });

  const durationMs = Date.now() - start;

  const images = result.data?.images;
  if (!images || images.length === 0) {
    throw new Error("fal.ai returned no images");
  }

  return {
    imageUrl: images[0].url,
    provider: "falai",
    durationMs,
    requestId: result.requestId,
  };
}
