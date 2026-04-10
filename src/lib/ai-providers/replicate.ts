import Replicate from "replicate";
import { env } from "../env.js";
import { PROVIDER_CAPABILITIES } from "./capabilities.js";
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
    images: [input.imageUrl],
    output_format: input.outputFormat ?? "jpg",
    go_fast: true,
  };

  // Only forward guidance_scale to models that actually expose it. Pruna
  // p-image-edit is a distilled sub-second model with no CFG knob; sending
  // the field would be either silently dropped or schema-rejected. The
  // capabilities module is keyed by model id, so a future second Replicate
  // model with different capabilities can coexist without touching this file.
  const capabilities = PROVIDER_CAPABILITIES[model];
  if (
    input.guidanceScale !== undefined &&
    capabilities?.supportsGuidanceScale === true
  ) {
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
