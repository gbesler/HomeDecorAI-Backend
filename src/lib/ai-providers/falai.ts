import { fal } from "@fal-ai/client";
import { env } from "../env.js";
import { aspectRatioToKleinImageSize } from "../generation/probe-aspect-ratio.js";
import { logger } from "../logger.js";
import { getCapabilities } from "./capabilities.js";
import {
  NoMaskDetectedError,
  resolveExtraImageUrls,
  type BgRemoveInput,
  type BgRemoveOutput,
  type GenerationInput,
  type GenerationOutput,
  type InpaintInput,
  type InpaintOutput,
  type RemovalInput,
  type RemovalOutput,
  type SegmentationInput,
  type SegmentationOutput,
} from "./types.js";

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

  // `extraImageUrls` is appended after the reference slot. Used by the
  // Replace & Add Object multi-image-edit pipeline to send a brush mask
  // as image 3. Gated on `supportsReferenceImage` same as the primary
  // reference slot — a model without multi-image support has no way to
  // disambiguate the extras and would silently drop or schema-reject.
  const extras = resolveExtraImageUrls(capabilities, input);
  const imageUrls = hasReference
    ? [input.imageUrl, input.referenceImageUrl as string, ...extras]
    : [input.imageUrl, ...extras];

  // Degraded-fallback warning. fal-ai/flux-2/edit (the Replace & Add
  // Object tool's fal.ai fallback) is a Flux 2 reference-style edit
  // model, not an instruction-following multi-image edit model.
  // When this adapter receives an `extraImageUrls` payload — used
  // today only by the Replace & Add Object pipeline to send a brush
  // mask as image 3 — fal.ai's flux-2/edit treats the mask as a
  // third aesthetic reference rather than a semantic edit region.
  // The pipeline's composite post-process still applies the mask
  // afterward, so output is not garbage, but mask-precision is lost
  // and inside-mask content may diverge from the inspiration the
  // user picked. Loud structured warn here so operator dashboards
  // can alert on sustained fallback fires (which would signal a
  // Replicate-side Nano Banana outage AND a quality regression for
  // affected users in the same window).
  if (extras.length > 0) {
    logger.warn(
      {
        event: "provider.falai.degraded_fallback",
        model,
        imagesCount: imageUrls.length,
        extrasCount: extras.length,
      },
      "fal.ai fallback for multi-image-edit pipeline — model lacks semantic mask understanding; output quality is degraded but composite post-process still applies the mask region",
    );
  }

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

// ─── Segmentation (fal-ai/sam-3/image) ─────────────────────────────────────

/**
 * Text-grounded segmentation fallback using fal.ai SAM 3.
 *
 * fal-ai/sam-3/image schema:
 *   image_url:              source photo URL (required)
 *   prompt:                 concept noun phrase(s)
 *   apply_mask:             false returns a standalone binary mask PNG (what
 *                           we want); true returns the image with the mask
 *                           burned in.
 *   return_multiple_masks:  false collapses to a single combined mask URL.
 *   output_format:          "png" for a lossless binary mask.
 *
 * Output: `result.data.image.url` is the mask PNG when `apply_mask=false`.
 * Throws `NoMaskDetectedError` when the response contains no mask — mirrors
 * the Replicate SAM 3 adapter so downstream callers handle the "already
 * clean" case uniformly regardless of which provider served the mask.
 */
export async function callSegmentationFalAI(
  model: string,
  input: SegmentationInput,
): Promise<SegmentationOutput> {
  const start = Date.now();

  const result = (await fal.subscribe(model, {
    input: {
      image_url: input.imageUrl,
      prompt: input.textPrompt,
      apply_mask: false,
      return_multiple_masks: false,
      output_format: "png",
    },
    logs: true,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    pollInterval: 1000,
  })) as {
    data?: {
      image?: { url?: string };
      images?: Array<{ url?: string }>;
    };
    requestId?: string;
  };

  const durationMs = Date.now() - start;

  // Schema drift guard: if `result.data` is entirely missing, OR it is
  // present but exposes neither an `image` nor `images` key (e.g. the
  // endpoint returned an error envelope like `{ data: { error: {...} } }`),
  // the endpoint did not actually run segmentation. That's a provider
  // health issue, not a "no mask" signal — throw a generic Error so the
  // fallback envelope records breaker failure + retries, instead of
  // short-circuiting as NoMaskDetectedError and showing the user a false
  // "already clean" result.
  if (
    result.data === undefined ||
    result.data === null ||
    (result.data.image === undefined && result.data.images === undefined)
  ) {
    logger.warn(
      {
        event: "provider.falai.malformed_response",
        model,
        textPrompt: input.textPrompt,
        durationMs,
      },
      "fal.ai SAM 3 returned a response without an image/images field",
    );
    throw new Error("fal.ai SAM 3 returned a malformed response");
  }

  // Defensive parse: the fal.ai SAM 3 schema is not version-pinned and
  // apply_mask=false is documented to return `image.url`, but sibling fal
  // endpoints (object-removal, flux-pro/v1/fill) return `images[0].url`.
  // Accept either shape. `||` (not `??`) is deliberate so an empty-string
  // `image.url` falls through to `images[0].url` rather than short-
  // circuiting the dual-shape parse.
  const maskUrl =
    result.data.image?.url || result.data.images?.[0]?.url;
  if (typeof maskUrl !== "string" || maskUrl.length === 0) {
    logger.warn(
      {
        event: "provider.falai.empty_mask",
        model,
        textPrompt: input.textPrompt,
        durationMs,
      },
      "fal.ai SAM 3 returned no mask — concept prompt matched zero regions",
    );
    throw new NoMaskDetectedError();
  }

  return { maskUrl, provider: "falai", durationMs };
}

// ─── Removal (fal-ai/object-removal) ───────────────────────────────────────

/**
 * Mask-guided object removal fallback using fal.ai's object-removal endpoint.
 *
 * fal-ai/object-removal schema:
 *   image_url: source photo URL (required)
 *   mask_url:  binary mask PNG URL (white = remove)
 *   model:     "best_quality" (default) or "medium_quality". We pin to
 *              best_quality because this path only fires when the Replicate
 *              primary is already unhealthy; cost savings aren't worth
 *              degrading the fallback UX when it's already the rarer path.
 *
 * Output: `result.data.images[0].url` — single inpainted image.
 */
export async function callRemovalFalAI(
  model: string,
  input: RemovalInput,
): Promise<RemovalOutput> {
  const start = Date.now();

  const result = (await fal.subscribe(model, {
    input: {
      image_url: input.imageUrl,
      mask_url: input.maskUrl,
      model: "best_quality",
    },
    logs: true,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    pollInterval: 1000,
  })) as { data?: { images?: Array<{ url?: string }> }; requestId?: string };

  const durationMs = Date.now() - start;

  const imageUrl = result.data?.images?.[0]?.url;
  if (typeof imageUrl !== "string" || imageUrl.length === 0) {
    logger.warn(
      {
        event: "provider.falai.empty_response",
        model,
        durationMs,
      },
      "fal.ai object-removal returned no image",
    );
    throw new Error("fal.ai removal returned no image");
  }

  return { imageUrl, provider: "falai", durationMs };
}

// ─── Inpaint with prompt (fal-ai/flux-pro/v1/fill) ─────────────────────────

/**
 * Prompt-driven inpainting fallback using fal.ai Flux Pro Fill.
 *
 * fal-ai/flux-pro/v1/fill schema:
 *   image_url:     source photo URL (required)
 *   mask_url:      binary mask PNG URL (white = fill)
 *   prompt:        text describing what to synthesize inside the mask
 *   output_format: "png" for parity with the Replicate Flux Fill Dev output
 *
 * Output: `result.data.images[0].url`.
 *
 * Note: fal's Flux Pro Fill does not expose a guidance_scale knob — Replicate
 * Flux Fill Dev does. Subtle quality differences between primary and fallback
 * are acceptable since the fallback only fires on primary failure.
 */
export async function callInpaintFalAI(
  model: string,
  input: InpaintInput,
): Promise<InpaintOutput> {
  const start = Date.now();

  // Surface the silent guidance drop. The Replace & Add Object
  // mode-aware builder sends per-mode guidance (30 replace, 28 add)
  // but fal.ai's flux-pro/v1/fill does not take a `guidance_scale`
  // knob, so those overrides vanish here without a trace. Logged at
  // WARN (not INFO) so a sustained fallback condition surfaces in
  // warn-keyed alerting — during a Replicate outage every Replace &
  // Add Object request lands here with mode tuning silently inert,
  // which is a quality regression operators need to see.
  if (input.guidanceScale !== undefined && input.guidanceScale > 0) {
    logger.warn(
      {
        event: "provider.falai.inpaint.guidance_dropped",
        model,
        callerGuidance: input.guidanceScale,
      },
      "Caller-supplied guidance ignored: fal.ai flux-pro/v1/fill does not accept a guidance_scale parameter. Mode-aware tuning is inert on this provider.",
    );
  }

  const result = (await fal.subscribe(model, {
    input: {
      image_url: input.imageUrl,
      mask_url: input.maskUrl,
      prompt: input.prompt,
      output_format: "png",
    },
    logs: true,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    pollInterval: 1000,
  })) as { data?: { images?: Array<{ url?: string }> }; requestId?: string };

  const durationMs = Date.now() - start;

  const imageUrl = result.data?.images?.[0]?.url;
  if (typeof imageUrl !== "string" || imageUrl.length === 0) {
    logger.warn(
      {
        event: "provider.falai.empty_response",
        model,
        durationMs,
      },
      "fal.ai flux-pro fill returned no image",
    );
    throw new Error("fal.ai inpaint returned no image");
  }

  return { imageUrl, provider: "falai", durationMs };
}

// ─── Background removal (fal-ai/birefnet/v2) ───────────────────────────────

/**
 * BiRefNet v2 background removal — single image in, cutout PNG out
 * (transparent background). Used by Replace & Add Object v5.0 pipeline
 * to isolate the inspiration object before pixel-level pasting.
 *
 * Schema:
 *   image_url:     source photo URL (required)
 *   output_format: "png" — transparent background requires PNG
 *
 * Output: `result.data.image.url` is the cutout PNG. fal.ai birefnet's
 * documented shape returns a single `image` object. Falls through to
 * `images[0]` defensively for parity with sibling endpoints.
 */
export async function callBgRemoveFalAI(
  model: string,
  input: BgRemoveInput,
): Promise<BgRemoveOutput> {
  const start = Date.now();

  const result = (await fal.subscribe(model, {
    input: {
      image_url: input.imageUrl,
      output_format: "png",
    },
    logs: true,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    pollInterval: 1000,
  })) as {
    data?: {
      image?: { url?: string };
      images?: Array<{ url?: string }>;
    };
    requestId?: string;
  };

  const durationMs = Date.now() - start;

  const cutoutUrl = result.data?.image?.url || result.data?.images?.[0]?.url;
  if (typeof cutoutUrl !== "string" || cutoutUrl.length === 0) {
    logger.warn(
      { event: "provider.falai.empty_response", model, durationMs },
      "fal.ai birefnet returned no cutout image",
    );
    throw new Error("fal.ai bg-remove returned no image");
  }

  return { imageUrl: cutoutUrl, provider: "falai", durationMs };
}

// ─── Inpaint-refine (fal-ai/inpaint — SDXL inpaint, compute-second) ────────

/**
 * SDXL inpainting refine pass. Used as Stage 4 of Replace & Add Object
 * v5.0 (crop-composite-refine): the pixel-composited cutout already
 * lives in the room photo at the user-painted region, and this call
 * runs a LOW-strength denoise pass around a SLIGHTLY-DILATED mask to
 * blend lighting, shadows, and edges so the result doesn't look pasted.
 *
 * Schema notes:
 *   - image_url:           pre-composited room with cutout pasted in (required)
 *   - mask_url:            dilated brush mask PNG (white = refine zone)
 *   - prompt:              scene-level description for blending guidance
 *   - strength:            0..1 denoise — pinned LOW (0.35) to preserve
 *                          the composited cutout identity rather than
 *                          re-imagining the object. This is the
 *                          load-bearing knob for the refine pass.
 *   - num_inference_steps: 20 — sub-2s on fal optimized SDXL → ~$0.005-0.008.
 */
export async function callInpaintRefineFalAI(
  model: string,
  input: InpaintInput,
): Promise<InpaintOutput> {
  const start = Date.now();

  const result = (await fal.subscribe(model, {
    input: {
      image_url: input.imageUrl,
      mask_url: input.maskUrl,
      prompt: input.prompt,
      strength: 0.35,
      num_inference_steps: 20,
      output_format: "jpeg",
    },
    logs: true,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    pollInterval: 1000,
  })) as { data?: { images?: Array<{ url?: string }> }; requestId?: string };

  const durationMs = Date.now() - start;

  const imageUrl = result.data?.images?.[0]?.url;
  if (typeof imageUrl !== "string" || imageUrl.length === 0) {
    logger.warn(
      { event: "provider.falai.empty_response", model, durationMs },
      "fal.ai inpaint-refine returned no image",
    );
    throw new Error("fal.ai inpaint-refine returned no image");
  }

  return { imageUrl, provider: "falai", durationMs };
}
