import Replicate from "replicate";
import { env } from "../env.js";
import type { GenerationInput, GenerationOutput } from "./types.js";

const replicate = new Replicate({ auth: env.REPLICATE_API_TOKEN });

const TIMEOUT_MS = 60_000;

export async function callReplicate(
  model: `${string}/${string}`,
  input: GenerationInput,
): Promise<GenerationOutput> {
  const start = Date.now();

  const replicateInput: Record<string, unknown> = {
    prompt: input.prompt,
    image: input.imageUrl,
    output_format: input.outputFormat ?? "jpg",
    go_fast: true,
  };

  if (input.guidanceScale !== undefined) {
    replicateInput.guidance_scale = input.guidanceScale;
  }

  const output = (await replicate.run(model, {
    input: replicateInput,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })) as unknown;

  const durationMs = Date.now() - start;

  let imageUrl: string;
  if (typeof output === "string") {
    imageUrl = output;
  } else if (Array.isArray(output) && output.length > 0) {
    imageUrl = typeof output[0] === "string" ? output[0] : String(output[0]);
  } else {
    throw new Error("Replicate returned no images");
  }

  return { imageUrl, provider: "replicate", durationMs };
}
