import { fal } from "@fal-ai/client";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { PROVIDER_CAPABILITIES } from "./capabilities.js";
import type { GenerationInput, GenerationOutput } from "./types.js";

fal.config({ credentials: env.FAL_AI_API_KEY });

const TIMEOUT_MS = 60_000;

export async function callFalAI(
  model: string,
  input: GenerationInput,
): Promise<GenerationOutput> {
  const start = Date.now();

  const capabilities = PROVIDER_CAPABILITIES[model];

  // Append the reference image as a second element of `image_urls` when the
  // model advertises multi-reference support (e.g. fal-ai/flux-2/edit).
  // Klein 9B edit is single-image; leave it untouched.
  const hasReference =
    capabilities?.supportsReferenceImage === true &&
    typeof input.referenceImageUrl === "string" &&
    input.referenceImageUrl.length > 0;

  const imageUrls = hasReference
    ? [input.imageUrl, input.referenceImageUrl as string]
    : [input.imageUrl];

  if (hasReference) {
    // Klein 9B Edit's multi-reference behavior is not formally documented
    // (capabilities.ts notes this). Log every multi-image call so a silent
    // "model ignored image_urls[1]" failure mode shows up as a quality-vs-
    // log discrepancy in production rather than as user reports only.
    logger.info(
      {
        event: "provider.reference_image",
        provider: "falai",
        model,
        imagesCount: imageUrls.length,
      },
      "fal.ai call carries a reference image",
    );
  }

  const result = await fal.subscribe(model, {
    input: {
      prompt: input.prompt,
      image_urls: imageUrls,
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
