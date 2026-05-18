import sharp from "sharp";
import { logger } from "../logger.js";
import {
  downloadSafe,
  persistGenerationBuffer,
  StorageUploadError,
} from "../storage/s3-upload.js";

/**
 * Composite-masked-result helper for the Nano Banana multi-image edit
 * pipeline.
 *
 * **Why we need this and why we can't trust the model.**
 *
 * `google/nano-banana` (Gemini 2.5 Flash Image) is an instruction-
 * following multi-image edit model. It does not have a native mask
 * input slot — we pass the binary mask as a third reference image
 * (image 3) and the instructional prompt asks Gemini to "keep every
 * pixel outside the white region of image 3 unchanged". That clause
 * is a best-effort signal, not a contract. In practice Gemini may
 * subtly re-render the entire image: slight color drift, mild
 * denoise, JPEG re-encoding, marginal sharpness shifts. None of
 * these are visible on a single edit, but they compound across
 * iterative edits — a user who replaces a sofa, then a lamp, then a
 * rug ends up with a perceptibly different room than they started
 * with. This is the "cumulative drift" failure mode the
 * brainstorm/plan identified as the load-bearing reason for this
 * post-process step.
 *
 * Cleanup.pictures, Adobe Firefly Generative Fill, and similar
 * commercial tools that lean on instruction-following models for
 * inpaint-style UX all run the same post-process pattern: the model
 * generates the edited image, the backend composites the model's
 * output INSIDE the mask region with the ORIGINAL pixels OUTSIDE the
 * mask, blended through a feathered alpha derived from the mask.
 * Outside-mask pixels become byte-identical to the input (modulo
 * JPEG re-encode, which is lossy by definition — see the Encoding
 * note below). Iterative drift goes to zero.
 *
 * **The sharp pipeline.**
 *
 *   1. Download original room image, Nano Banana output, brush mask
 *      in parallel.
 *   2. Decode the original to its native dimensions; resize the
 *      Nano Banana output to match (defensive — usually a no-op
 *      because `aspect_ratio: "auto"` keeps the output dims aligned).
 *   3. Convert the mask to single-channel greyscale and apply a
 *      Gaussian blur with sigma ≈ feather radius / 2. This produces
 *      a smooth alpha gradient at the mask boundary instead of a
 *      pixel-sharp seam — the "feathered" composite that hides
 *      Gemini's edit boundary.
 *   4. Stack the edited image with the feathered alpha as a single
 *      RGBA buffer and composite it `over` the original using sharp's
 *      built-in alpha blending.
 *   5. Encode as JPEG quality 92 and upload to S3 under the
 *      `composite/` prefix.
 *
 * **Encoding note.** JPEG encoding is lossy, so "byte-identical
 * outside the mask" is technically "perceptually identical at q=92".
 * For our use case (downstream consumers are iOS photo viewers and
 * S3 → CloudFront delivery), this is the right trade-off: q=92 keeps
 * file sizes under ~1 MB for a 2048-long-side photo and produces no
 * visible artifacts on natural images. If a future requirement
 * surfaces for true byte-identical outside-mask preservation
 * (forensic-level edits, e.g.), switch encoding to PNG and accept the
 * ~3-5× file-size hit. The math inside this helper is already lossless
 * — the JPEG step is the only stage that introduces compression.
 *
 * **Feathering tuning.** `featherSigma = 10` is a starting value
 * matching Adobe Firefly's default and the brainstorm research. Drop
 * to 4-6 for hard-edged objects (lighting fixtures, picture frames),
 * raise to 15-20 for soft-edged objects (plants, fabric drapes).
 * Tuning is a future operability concern, not a v4.0-launch blocker.
 *
 * **No early-exit fast path.** Even when the mask is all-white (entire
 * image edited) or all-black (no region selected), the helper runs the
 * full pipeline. The math collapses correctly in both cases —
 * all-white feathers to all-white, composite returns Nano Banana
 * output unchanged; all-black feathers to all-black, composite
 * returns original unchanged. Adding fast-path branches would
 * complicate the code for no measurable wall-clock win (sharp's
 * pipelines run in ~200ms at our typical resolutions either way).
 */

/** Default Gaussian feather radius. See "Feathering tuning" note above. */
const DEFAULT_FEATHER_SIGMA = 10;

/** JPEG quality for the composite output. q=92 lands files under
 *  ~1 MB for 2048-long-side photos with no visible compression
 *  artifacts on natural images. Matches the existing
 *  `persistGenerationBuffer` convention used elsewhere in the
 *  pipeline. */
const COMPOSITE_JPEG_QUALITY = 92;

/** S3 key prefix for composite outputs. Distinct from `normalized/`
 *  (pre-processing artifacts) and `generations/` (final user-facing
 *  outputs). The processor's downstream persist step may re-write
 *  the composite to `generations/` for the user-output path. */
const COMPOSITE_KEY_PREFIX = "composite";

export interface CompositeMaskedResultInput {
  /** URL of the original room image — provides the outside-mask pixels. */
  originalUrl: string;
  /** URL of the Nano Banana raw output — provides the inside-mask pixels. */
  editedUrl: string;
  /** URL of the binary brush mask — drives the alpha channel. */
  maskUrl: string;
  /** Gaussian feather sigma in pixels. Defaults to 10. */
  featherSigma?: number;
  /** Required for the S3 persist step (same shape as other pipeline
   *  helpers — userId is the S3 key prefix). */
  userId: string;
  /** Required for the S3 persist step — the generation record id is
   *  the key disambiguator. */
  generationId: string;
}

export interface CompositeMaskedResultOutput {
  /** Public URL of the final composited image (CloudFront when
   *  available, S3 direct otherwise). */
  outputImageUrl: string;
  /** Wall-clock of this step alone. Surfaced so the orchestrating
   *  pipeline can attribute total latency between Nano Banana and
   *  the composite step. */
  durationMs: number;
  /** Dimensions of the final composite (matches the original image's
   *  dimensions). Useful for log/observability assertions. */
  width: number;
  height: number;
}

/**
 * Composite the Nano Banana edit back over the original room image,
 * using the brush mask as a feathered alpha channel. Returns the
 * S3-persisted URL of the final image.
 *
 * Throws `StorageUploadError` for unreachable URLs and propagates
 * sharp's native errors verbatim for malformed buffers. The
 * orchestrating pipeline (`runMultiImageEdit`) maps both to the
 * generation processor's outer `AI_PROVIDER_FAILED` envelope so
 * user-facing remediation is consistent with other model failures.
 */
export async function compositeMaskedResult(
  input: CompositeMaskedResultInput,
): Promise<CompositeMaskedResultOutput> {
  const start = Date.now();
  const featherSigma = input.featherSigma ?? DEFAULT_FEATHER_SIGMA;

  logger.info(
    {
      event: "inpaint.composite.started",
      generationId: input.generationId,
      featherSigma,
    },
    "composite: starting feathered blend",
  );

  // Parallel download — all three URLs typically live on the same
  // CloudFront/S3 origin (original, normalized mask) or Replicate's
  // CDN (Nano Banana output). Network latency dominates the per-URL
  // fixed cost, so parallel is unambiguously faster.
  const [originalDl, editedDl, maskDl] = await Promise.all([
    downloadSafe(input.originalUrl),
    downloadSafe(input.editedUrl),
    downloadSafe(input.maskUrl),
  ]);

  // Decode the original into a normalized RGB buffer at native
  // dimensions. `.rotate()` bakes any EXIF orientation so the
  // downstream composite operates in the same coordinate system the
  // mask was authored against — same rationale as
  // `normalize-image-mask-pair.ts`'s post-rotation pass. No
  // `.withMetadata()`: we don't want sharp re-applying orientation on
  // re-decode of the final output.
  //
  // `toBuffer({ resolveWithObject: true })` returns the POST-rotation
  // dimensions in `info`. A prior implementation read dimensions from
  // `sharp(originalDl.buffer).metadata()` first — those are the raw
  // pre-rotation dims (e.g. 4032×3024 for a portrait iPhone shot with
  // EXIF orientation=6) and using them as resize targets transposed
  // the editedRgb against the post-rotation originalRgb, producing
  // geometrically broken composites for the majority of iOS portrait
  // captures.
  const { data: originalRgb, info: originalInfo } = await sharp(
    originalDl.buffer,
  )
    .rotate()
    .removeAlpha()
    .toColorspace("srgb")
    .png()
    .toBuffer({ resolveWithObject: true });

  if (originalInfo.width === 0 || originalInfo.height === 0) {
    throw new StorageUploadError(
      `composite: original image has no width/height (format=${originalInfo.format})`,
    );
  }
  const { width, height } = originalInfo;

  // Resize the edited image to match the original's dims. `fit: "fill"`
  // (not "cover" or "contain") because Nano Banana usually already
  // outputs at the requested AR — we just need pixel-exact alignment
  // for the composite. The resize is a no-op when dims already match.
  const editedRgb = await sharp(editedDl.buffer)
    .rotate()
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .toColorspace("srgb")
    .toFormat("png")
    .toBuffer();

  // Convert the mask to a single-channel feathered alpha. Steps:
  //   1. removeAlpha + greyscale: collapse any RGB-or-RGBA mask to a
  //      single luminance channel. iOS UIGraphicsImageRenderer
  //      defaults to RGBA, and sharp's `.greyscale()` alone does NOT
  //      drop the alpha channel (it converts the color channels to
  //      luminance but retains existing alpha). Forcing single-channel
  //      here means `joinChannel` below appends EXACTLY one channel,
  //      not two — preventing a 5-channel buffer that silently
  //      ignores the feathered alpha.
  //   2. Resize to match original dims (mask may have a different
  //      shape from normalize-image-mask-pair output if anything
  //      drifted upstream).
  //   3. Gaussian blur with `featherSigma`. This is the load-bearing
  //      step: it produces the smooth alpha gradient that hides
  //      Gemini's edit boundary in the final composite. Larger sigma
  //      = softer boundary, smaller sigma = sharper boundary.
  //   4. PNG-encode as a single-channel image — sharp's `joinChannel`
  //      below accepts this shape directly.
  //
  // No `.threshold()` here. The v3.0 mask normalization pipeline
  // re-binarizes the mask after dilation; that's the right call for
  // Flux Fill which wants a hard mask. The composite step wants the
  // OPPOSITE — a soft feathered alpha. Re-thresholding would
  // re-introduce the hard edge we're trying to remove.
  const featheredAlpha = await sharp(maskDl.buffer)
    .removeAlpha()
    .greyscale()
    .resize(width, height, { fit: "fill" })
    .blur(featherSigma)
    .toFormat("png")
    .toBuffer();

  // Join the feathered alpha into the edited image as its alpha
  // channel, producing an RGBA buffer that's transparent where the
  // mask is black (preserve original) and opaque where the mask is
  // white (use Gemini's edit). Then composite that RGBA over the
  // original RGB with `blend: "over"` — sharp's standard
  // alpha-over-RGB operation.
  //
  // DO NOT call `.ensureAlpha()` before `.joinChannel()`. sharp's
  // `joinChannel` APPENDS a channel rather than replacing. ensureAlpha
  // would first add a fully-opaque alpha channel (255 everywhere),
  // then joinChannel would append the feathered mask as a FIFTH
  // channel. When sharp encodes back to PNG it drops to RGBA — keeping
  // ensureAlpha's all-255 alpha and DISCARDING the feathered mask.
  // The composite step would then run alpha=255 over the original
  // everywhere, completely overwriting outside-mask pixels and
  // defeating the only reason this file exists. joinChannel on a
  // 3-channel RGB base (editedRgb came through .removeAlpha() above)
  // appends a 4th channel which becomes alpha at PNG encode time.
  const editedWithAlpha = await sharp(editedRgb)
    .joinChannel(featheredAlpha)
    .toFormat("png")
    .toBuffer();

  const compositeBuffer = await sharp(originalRgb)
    .composite([{ input: editedWithAlpha, blend: "over" }])
    .jpeg({ quality: COMPOSITE_JPEG_QUALITY })
    .toBuffer();

  // Persist under the dedicated `composite/` prefix. Single artifact
  // per generation, so no suffix needed (the MULTI_ARTIFACT_PREFIXES
  // guard in persistGenerationBuffer permits this).
  const persisted = await persistGenerationBuffer({
    userId: input.userId,
    generationId: input.generationId,
    buffer: compositeBuffer,
    mime: "image/jpeg",
    keyPrefix: COMPOSITE_KEY_PREFIX,
  });

  const durationMs = Date.now() - start;
  const outputImageUrl =
    persisted.outputImageCDNUrl ?? persisted.outputImageUrl;

  logger.info(
    {
      event: "inpaint.composite.completed",
      generationId: input.generationId,
      featherSigma,
      width,
      height,
      durationMs,
      outputBytes: compositeBuffer.byteLength,
    },
    "composite: feathered blend completed",
  );

  return {
    outputImageUrl,
    durationMs,
    width,
    height,
  };
}
