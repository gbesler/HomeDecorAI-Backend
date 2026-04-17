import Replicate from "replicate";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { PROVIDER_CAPABILITIES } from "./capabilities.js";
import type { GenerationInput, GenerationOutput } from "./types.js";

// useFileOutput: false restores pre-v1 behavior. Replicate client v1+ wraps
// file outputs in FileOutput stream objects by default — those JSON.stringify
// to "{}" and fail our `typeof === "string"` / `Array.isArray` checks, which
// surfaced as "Replicate returned no images" even on successful predictions.
// We consume the URL directly and hand it to the S3 upload step, so the
// stream wrapper buys us nothing.
const replicate = new Replicate({
  auth: env.REPLICATE_API_TOKEN,
  useFileOutput: false,
});

const TIMEOUT_MS = 60_000;

export async function callReplicate(
  model: `${string}/${string}`,
  input: GenerationInput,
): Promise<GenerationOutput> {
  const start = Date.now();

  const capabilities = PROVIDER_CAPABILITIES[model];

  // Reference-style tool passes a second image as the aesthetic reference.
  // Pruna p-image-edit exposes multi-image editing via:
  //   - `images[]` accepts 1-5 items
  //   - `reference_image`: 1-based string index ("1","2",...) that marks
  //     which array element is the PRIMARY image being edited — NOT the
  //     style reference. The other array elements are referenced from the
  //     prompt ("image 2", "image 3", ...) as auxiliary inputs (style refs,
  //     backgrounds, subjects to combine).
  //     Docs: https://docs.pruna.ai/en/stable/docs_pruna_endpoints/performance_models/p-image-edit.html
  // Models that don't advertise multi-image support silently ignore the
  // second URL (capabilities.supportsReferenceImage=false).
  const hasReference =
    capabilities?.supportsReferenceImage === true &&
    typeof input.referenceImageUrl === "string" &&
    input.referenceImageUrl.length > 0;

  // Order matters: images[0] is the target being edited, images[1] is the
  // style reference. `reference_image="1"` tells Pruna to treat images[0]
  // as the primary; the prompt then invokes images[1] as "image 2".
  const images = hasReference
    ? [input.imageUrl, input.referenceImageUrl as string]
    : [input.imageUrl];

  // Pruna p-image-edit schema (docs.pruna.ai) accepts only:
  //   images, prompt, reference_image, aspect_ratio, width, height, seed,
  //   disable_safety_checker.
  // `output_format` and `go_fast` are not in the schema. They are silently
  // dropped today but passing unrecognized params has been observed to
  // contribute to empty responses. Keep the payload tight.
  const replicateInput: Record<string, unknown> = {
    prompt: input.prompt,
    images,
  };

  if (hasReference) {
    // Pruna's `reference_image` is the 1-based index of the PRIMARY image
    // being edited, not the style reference. With images = [target, styleRef],
    // the target (room) lives at 1-based index "1". The prompt then invokes
    // images[1] as "image 2" to convey the style reference.
    // Regression canary: if Pruna ever flips the semantics (e.g. "2" becomes
    // required to point at the style ref), the structured log below surfaces
    // it in production before it manifests as a quality complaint.
    replicateInput.reference_image = "1";
    logger.info(
      {
        event: "provider.reference_image",
        provider: "replicate",
        model,
        imagesCount: images.length,
        primaryIndex: "1",
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
    // Empty response from Replicate is usually one of:
    //   - Pruna safety filter hit on input or output
    //   - Billing/quota exhausted on the account
    //   - Transient deployment issue (cold start, worker death)
    // Log the raw response shape so future regressions can be diagnosed
    // without re-instrumenting. Token/PII-free: we log the JS type + a
    // truncated stringified snapshot, never the user's image URL.
    const outputType = output === null ? "null" : typeof output;
    const outputShape = Array.isArray(output)
      ? `array(length=${(output as unknown[]).length})`
      : outputType;
    const outputSnapshot = (() => {
      try {
        return JSON.stringify(output).slice(0, 200);
      } catch {
        return "[unserializable]";
      }
    })();
    logger.warn(
      {
        event: "provider.replicate.empty_response",
        model,
        outputShape,
        outputSnapshot,
        durationMs,
      },
      "Replicate returned no images — empty response",
    );
    throw new Error("Replicate returned no images");
  }

  return { imageUrl, provider: "replicate", durationMs };
}
