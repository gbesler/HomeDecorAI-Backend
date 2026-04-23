import { fal } from "@fal-ai/client";
import { env } from "../env.js";
import { aspectRatioToKleinImageSize } from "../generation/probe-aspect-ratio.js";
import { logger } from "../logger.js";
import { getCapabilities } from "./capabilities.js";
import type { GenerationInput, GenerationOutput } from "./types.js";

fal.config({ credentials: env.FAL_AI_API_KEY });

const TIMEOUT_MS = 60_000;

export async function callFalAI(
  model: string,
  input: GenerationInput,
): Promise<GenerationOutput> {
  const start = Date.now();

  // Use the helper so version-pinned slugs (`owner/name:version`) resolve
  // back to the base entry, matching replicate.ts behaviour.
  const capabilities = getCapabilities(model);

  // Append the reference image as a second element of `image_urls` when the
  // model advertises multi-reference support. Both Klein 9B Edit and
  // Kontext Max Multi use the same `image_urls: string[]` schema — Kontext
  // is natively multi-reference (trained for it), Klein accepts the array
  // but multi-reference behavior is not formally documented there.
  const hasReference =
    capabilities?.supportsReferenceImage === true &&
    typeof input.referenceImageUrl === "string" &&
    input.referenceImageUrl.length > 0;

  const imageUrls = hasReference
    ? [input.imageUrl, input.referenceImageUrl as string]
    : [input.imageUrl];

  if (hasReference) {
    // Log every multi-image call so a silent "model ignored image_urls[1]"
    // quality failure shows up as a log/quality discrepancy in production
    // rather than only as user reports.
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

  // Map the canonical GenerationInput.aspectRatio onto whichever field
  // this model's schema accepts. Kontext Multi uses `aspect_ratio` with
  // a ratio-string enum; Klein uses `image_size` with named presets
  // (square_hd / landscape_4_3 / portrait_16_9 / ...). `null` capability
  // means the model has no AR knob and we skip the field entirely.
  const aspectRatioPayload: Record<string, string> = {};
  if (input.aspectRatio && capabilities?.aspectRatioField === "aspect_ratio") {
    aspectRatioPayload.aspect_ratio = input.aspectRatio;
  } else if (
    input.aspectRatio &&
    capabilities?.aspectRatioField === "image_size"
  ) {
    const imageSize = aspectRatioToKleinImageSize(input.aspectRatio);
    if (imageSize) {
      aspectRatioPayload.image_size = imageSize;
    }
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
      ...aspectRatioPayload,
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
