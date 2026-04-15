import Replicate from "replicate";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { PROVIDER_CAPABILITIES } from "./capabilities.js";
import type { GenerationInput, GenerationOutput } from "./types.js";

const replicate = new Replicate({ auth: env.REPLICATE_API_TOKEN });

const TIMEOUT_MS = 60_000;

export async function callReplicate(
  model: `${string}/${string}`,
  input: GenerationInput,
): Promise<GenerationOutput> {
  const start = Date.now();

  const capabilities = PROVIDER_CAPABILITIES[model];

  // Reference-style tool passes a second image as the aesthetic reference.
  // Pruna p-image-edit exposes this via:
  //   - `images[]` accepts 1-5 items (index 1 = target)
  //   - `reference_image`: string index ("1","2",...) marking which array
  //     element is the style reference
  // Models that don't advertise multi-image support silently ignore the
  // second URL (capabilities.supportsReferenceImage=false).
  const hasReference =
    capabilities?.supportsReferenceImage === true &&
    typeof input.referenceImageUrl === "string" &&
    input.referenceImageUrl.length > 0;

  const images = hasReference
    ? [input.imageUrl, input.referenceImageUrl as string]
    : [input.imageUrl];

  const replicateInput: Record<string, unknown> = {
    prompt: input.prompt,
    images,
    output_format: input.outputFormat ?? "jpg",
    go_fast: true,
  };

  if (hasReference) {
    // Pruna uses 1-based string index pointing into `images[]`. With
    // images = [target, reference], the reference is element 2 in 1-based
    // notation. If Pruna ever changes to 0-based or rejects out-of-range,
    // the structured log below makes the regression visible in production
    // before a user reports a quality issue.
    replicateInput.reference_image = "2";
    logger.info(
      {
        event: "provider.reference_image",
        provider: "replicate",
        model,
        imagesCount: images.length,
        refIndex: "2",
      },
      "Replicate call carries a reference image",
    );
  }

  // Only forward guidance_scale to models that actually expose it. Pruna
  // p-image-edit is a distilled sub-second model with no CFG knob; sending
  // the field would be either silently dropped or schema-rejected.
  if (
    input.guidanceScale !== undefined &&
    capabilities?.supportsGuidanceScale
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
