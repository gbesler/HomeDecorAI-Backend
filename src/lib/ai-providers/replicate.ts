import Replicate from "replicate";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getCapabilities } from "./capabilities.js";
import {
  NoMaskDetectedError,
  type GenerationInput,
  type GenerationOutput,
  type InpaintInput,
  type InpaintOutput,
  type RemovalInput,
  type RemovalOutput,
  type SegmentationInput,
  type SegmentationOutput,
} from "./types.js";

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

  const capabilities = getCapabilities(model);

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

// ─── Segmentation (Grounded-SAM 2) ──────────────────────────────────────────

/**
 * Run text-grounded segmentation on Replicate. Returns the URL of a binary
 * mask PNG (white = matched regions, black = preserve).
 *
 * Throws `NoMaskDetectedError` when the model completes successfully but
 * returns no mask — i.e. the taxonomy matched zero regions. Callers turn this
 * into a user-facing "already clean" message rather than a generic failure.
 *
 * Model slug is passed in by the caller (sourced from env so ops can swap
 * community forks without a code deploy).
 */
export async function callSegmentationReplicate(
  model: `${string}/${string}`,
  input: SegmentationInput,
): Promise<SegmentationOutput> {
  const start = Date.now();

  const capabilities = getCapabilities(model);
  if (capabilities?.role !== "segment") {
    logger.warn(
      { event: "provider.replicate.role_mismatch", model, expectedRole: "segment", actualRole: capabilities?.role },
      "Segmentation model slug is not registered as role=segment",
    );
  }

  // SAM 3 input schema (mattsays/sam3-image, verified via openapi_schema):
  //   image:       URL of the room photo (required)
  //   prompt:      concept noun phrase, "." separator for multiple concepts.
  //                e.g. "clutter" or "trash . empty bottles . dirty dishes"
  //   mask_only:   MUST be true. Default false returns a green-tinted overlay
  //                on the original image — not a binary mask. We want
  //                black-and-white.
  //   return_zip:  MUST be false. Default true returns a ZIP archive URL
  //                containing per-concept masks. We want the single combined
  //                mask URL so extractMaskUrl + persistGenerationImage can
  //                consume it without unzipping.
  // Output: single URI string pointing to the binary mask PNG.
  const replicateInput = {
    image: input.imageUrl,
    prompt: input.textPrompt,
    mask_only: true,
    return_zip: false,
  };

  const output = (await replicate.run(model, {
    input: replicateInput,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })) as unknown;

  const durationMs = Date.now() - start;

  const maskUrl = extractMaskUrl(output, model);
  if (maskUrl === null) {
    const outputSnapshot = safeSnapshot(output);
    // `warn` (not `info`) because a spike here is operationally meaningful:
    // either taxonomy drift, an unexpected output shape from a model slug
    // swap (extractMaskUrl parser miss), or an upstream regression. Alerts
    // key off warn+ so this must stay above info.
    logger.warn(
      {
        event: "provider.replicate.empty_mask",
        model,
        textPrompt: input.textPrompt,
        outputShape: describeShape(output),
        outputSnapshot,
        durationMs,
      },
      "SAM 3 returned no mask — concept prompt matched zero regions",
    );
    throw new NoMaskDetectedError();
  }

  return { maskUrl, provider: "replicate", durationMs };
}

// ─── Removal (LaMa) ────────────────────────────────────────────────────────

/**
 * Run mask-guided object removal on Replicate using LaMa.
 *
 * LaMa accepts image + mask ONLY. Mask is a binary PNG URL with white pixels
 * marking the region to remove. LaMa extends the surrounding surface (via
 * Fourier convolutions) rather than generating new content — this is why
 * the model is preferred over diffusion inpainters for object-removal UX.
 */
export async function callRemovalReplicate(
  model: `${string}/${string}`,
  input: RemovalInput,
): Promise<RemovalOutput> {
  const start = Date.now();

  const capabilities = getCapabilities(model);
  if (capabilities?.role !== "remove") {
    logger.warn(
      { event: "provider.replicate.role_mismatch", model, expectedRole: "remove", actualRole: capabilities?.role },
      "Removal model slug is not registered as role=remove",
    );
  }

  // LaMa input schema (allenhooo/lama, verified via openapi_schema):
  //   image: URL of the source photo (required)
  //   mask:  URL of the binary mask (required; white = remove, black = preserve)
  // No prompt. No guidance scale. No negative prompt. Don't add any.
  // Output: single URI string pointing to the inpainted image.
  const replicateInput: Record<string, unknown> = {
    image: input.imageUrl,
    mask: input.maskUrl,
  };

  const output = (await replicate.run(model, {
    input: replicateInput,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })) as unknown;

  const durationMs = Date.now() - start;

  const imageUrl = extractImageUrl(output);
  if (imageUrl === null) {
    logger.warn(
      {
        event: "provider.replicate.empty_response",
        model,
        outputShape: describeShape(output),
        outputSnapshot: safeSnapshot(output),
        durationMs,
        // Upstream normalization pins image + mask to these dims before
        // LaMa sees them. Surfacing them on the failure log means a null
        // response is already self-diagnostic — we know whether the input
        // was within LaMa's envelope without needing to re-download.
        normalizedDims: input.normalizedDims ?? null,
      },
      "LaMa returned no image — empty response",
    );
    throw new Error("Replicate removal returned no image");
  }

  return { imageUrl, provider: "replicate", durationMs };
}

// ─── Inpaint with prompt (Flux Fill) ───────────────────────────────────────

/**
 * Run prompt-driven inpainting on Replicate using Flux Fill.
 *
 * Flux Fill input schema (black-forest-labs/flux-fill-{dev,pro}):
 *   image:                URL of the source photo (required)
 *   mask:                 URL of the binary mask PNG (required; white = fill,
 *                         black = preserve)
 *   prompt:               text describing what to place in the masked region
 *   guidance:             optional; different scale than classic CFG
 *                         (model card defaults: Dev ~60, Pro ~30)
 *   num_inference_steps:  optional; 28 is the common sweet spot (lower = faster,
 *                         higher = more detail). We omit to let Replicate use
 *                         the model-card default.
 * Output: single URI string pointing to the inpainted image.
 *
 * Mask convention (white = replace) matches Remove Objects + SAM outputs, so
 * the iOS client's `MaskRenderer` output flows through unchanged.
 */
export async function callInpaintReplicate(
  model: `${string}/${string}`,
  input: InpaintInput,
): Promise<InpaintOutput> {
  const start = Date.now();

  const capabilities = getCapabilities(model);
  if (capabilities?.role !== "inpaint") {
    logger.warn(
      { event: "provider.replicate.role_mismatch", model, expectedRole: "inpaint", actualRole: capabilities?.role },
      "Inpaint model slug is not registered as role=inpaint",
    );
  }

  const replicateInput: Record<string, unknown> = {
    image: input.imageUrl,
    mask: input.maskUrl,
    prompt: input.prompt,
  };

  if (
    input.guidanceScale !== undefined &&
    capabilities?.supportsGuidanceScale
  ) {
    replicateInput.guidance = input.guidanceScale;
  }

  const output = (await replicate.run(model, {
    input: replicateInput,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })) as unknown;

  const durationMs = Date.now() - start;

  const imageUrl = extractImageUrl(output);
  if (imageUrl === null) {
    logger.warn(
      {
        event: "provider.replicate.empty_response",
        model,
        outputShape: describeShape(output),
        outputSnapshot: safeSnapshot(output),
        durationMs,
        // Upstream normalization pins image + mask to these dims before
        // Flux Fill sees them. Surfacing them on the failure log makes
        // a null response self-diagnostic — mirrors the LaMa path.
        normalizedDims: input.normalizedDims ?? null,
      },
      "Flux Fill returned no image — empty response",
    );
    throw new Error("Replicate inpaint returned no image");
  }

  return { imageUrl, provider: "replicate", durationMs };
}

// ─── Output shape helpers ───────────────────────────────────────────────────

function extractImageUrl(output: unknown): string | null {
  if (typeof output === "string" && output.length > 0) return output;
  if (Array.isArray(output) && output.length > 0) {
    const first = output[0];
    if (typeof first === "string" && first.length > 0) return first;
  }
  return null;
}

// SAM variants return either a single mask URL, an array where the mask
// is the last element (after an overlay preview), or an object with a
// `mask` / `masks` field. Probe all common shapes; log the shape when we
// cannot extract so regressions surface before users hit them.
//
// IMPORTANT: the array branch assumes "[overlay_preview, mask]" ordering.
// A community fork that returns `[mask, overlay]` would silently feed the
// overlay RGB frame into LaMa as a "mask". We log at warn level whenever
// the array heuristic fires so a slug swap leaves an operator trail BEFORE
// users report broken output.
function extractMaskUrl(output: unknown, model: string): string | null {
  if (typeof output === "string" && output.length > 0) return output;
  if (Array.isArray(output)) {
    for (let i = output.length - 1; i >= 0; i -= 1) {
      const item = output[i];
      if (typeof item === "string" && item.length > 0) {
        if (output.length > 1) {
          // Positional heuristic — verify on slug swap.
          logger.warn(
            {
              event: "provider.replicate.mask_array_shape",
              model,
              arrayLength: output.length,
              chosenIndex: i,
            },
            "Grounded-SAM returned an array output; using positional last-string heuristic. Verify mask ordering if slug was changed.",
          );
        }
        return item;
      }
    }
    return null;
  }
  if (output !== null && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    const candidates = ["mask", "combined_mask", "mask_url"];
    for (const key of candidates) {
      const val = obj[key];
      if (typeof val === "string" && val.length > 0) return val;
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === "string") {
        return val[0] as string;
      }
    }
    const masks = obj.masks;
    if (Array.isArray(masks) && masks.length > 0 && typeof masks[0] === "string") {
      return masks[0] as string;
    }
  }
  return null;
}

function describeShape(output: unknown): string {
  if (output === null) return "null";
  if (Array.isArray(output)) return `array(length=${output.length})`;
  return typeof output;
}

function safeSnapshot(output: unknown): string {
  try {
    return JSON.stringify(output).slice(0, 200);
  } catch {
    return "[unserializable]";
  }
}
