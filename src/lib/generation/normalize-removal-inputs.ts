import sharp from "sharp";
import { logger } from "../logger.js";
import { downloadSafe, persistGenerationBuffer } from "../storage/s3-upload.js";

/**
 * Guarantee that the `image` and `mask` URLs handed to LaMa have identical
 * pixel dimensions and that the image long-side stays within the model's
 * practical envelope. See
 * `docs/plans/2026-04-22-001-fix-remove-objects-vertical-normalization-plan.md`
 * for the full rationale.
 *
 * Short version: LaMa (`allenhooo/lama` on Replicate) silently returns
 * `null` when image and mask pixel shapes disagree. Pre-iOS-Phase-A clients
 * ship an image at native camera resolution and a mask rendered against
 * the UIImage's display-scaled copy, which desyncs shapes on portrait
 * photos. This helper is that defense-in-depth step.
 */

/** Image long-side cap. Values above this put LaMa inside OOM territory on
 *  Replicate's consumer GPU tier. Matches the iOS Phase A client cap so
 *  post-Phase-A uploads take the passthrough path. */
const MAX_LONG_SIDE = 2048;

/** Disambiguates the two artifacts when they land in S3 under the same
 *  `normalized/{userId}/{generationId}-…` prefix. */
const IMAGE_SUFFIX = "image";
const MASK_SUFFIX = "mask";

export interface NormalizeRemovalInputsInput {
  imageUrl: string;
  maskUrl: string;
  userId: string;
  generationId: string;
}

export interface NormalizeRemovalInputsResult {
  imageUrl: string;
  maskUrl: string;
  action: "passthrough" | "normalized";
  before: { image: Dimensions; mask: Dimensions };
  after: { image: Dimensions; mask: Dimensions };
  durationMs: number;
}

export interface Dimensions {
  width: number;
  height: number;
}

export async function normalizeRemovalInputs(
  input: NormalizeRemovalInputsInput,
): Promise<NormalizeRemovalInputsResult> {
  const start = Date.now();

  // Parallel fetch — both URLs are on the same CDN so network latency
  // dominates over any per-request fixed cost. No point serializing.
  const [imageDl, maskDl] = await Promise.all([
    downloadSafe(input.imageUrl),
    downloadSafe(input.maskUrl),
  ]);

  const [imageMeta, maskMeta] = await Promise.all([
    sharp(imageDl.buffer).metadata(),
    sharp(maskDl.buffer).metadata(),
  ]);

  const originalImage = readDimensions(imageMeta, "image");
  const originalMask = readDimensions(maskMeta, "mask");

  const targetImage = clampLongSide(originalImage, MAX_LONG_SIDE);

  const imageNeedsResize =
    targetImage.width !== originalImage.width ||
    targetImage.height !== originalImage.height;

  const maskNeedsResize =
    originalMask.width !== targetImage.width ||
    originalMask.height !== targetImage.height;

  if (!imageNeedsResize && !maskNeedsResize) {
    // Passthrough short-circuit — no S3 writes, no sharp re-encode.
    // Expected to be the common case once iOS Phase A lands.
    return {
      imageUrl: input.imageUrl,
      maskUrl: input.maskUrl,
      action: "passthrough",
      before: { image: originalImage, mask: originalMask },
      after: { image: originalImage, mask: originalMask },
      durationMs: Date.now() - start,
    };
  }

  // Image: resize with a high-quality kernel (sharp default is lanczos3).
  // Preserve ICC profile so P3 captures don't silently flatten to sRGB.
  // JPEG out at quality 90 — high enough to be visually indistinguishable
  // from the source at this scale, low enough to keep file sizes inside
  // the 10 MB download cap for the next leg of the pipeline.
  const imageBuffer = imageNeedsResize
    ? await sharp(imageDl.buffer)
        .resize(targetImage.width, targetImage.height, { fit: "fill" })
        .jpeg({ quality: 90 })
        .withMetadata()
        .toBuffer()
    : imageDl.buffer;

  // Mask: nearest-neighbor is the only correct kernel for a binary mask.
  // Bilinear / bicubic produce intermediate grays at edges that LaMa
  // interprets as "neither remove nor preserve", softening object
  // boundaries and leaving halos in the output.
  const maskBuffer = maskNeedsResize
    ? await sharp(maskDl.buffer)
        .resize(targetImage.width, targetImage.height, {
          fit: "fill",
          kernel: "nearest",
        })
        .png()
        .toBuffer()
    : maskDl.buffer;

  // Upload both under a dedicated `normalized/` prefix so infra can
  // expire them on a short lifecycle rule independent of user uploads or
  // generation outputs.
  const [uploadedImage, uploadedMask] = await Promise.all([
    persistGenerationBuffer({
      userId: input.userId,
      generationId: input.generationId,
      buffer: imageBuffer,
      mime: "image/jpeg",
      keyPrefix: "normalized",
      suffix: IMAGE_SUFFIX,
    }),
    persistGenerationBuffer({
      userId: input.userId,
      generationId: input.generationId,
      buffer: maskBuffer,
      mime: "image/png",
      keyPrefix: "normalized",
      suffix: MASK_SUFFIX,
    }),
  ]);

  return {
    imageUrl: uploadedImage.outputImageCDNUrl ?? uploadedImage.outputImageUrl,
    maskUrl: uploadedMask.outputImageCDNUrl ?? uploadedMask.outputImageUrl,
    action: "normalized",
    before: { image: originalImage, mask: originalMask },
    after: { image: targetImage, mask: targetImage },
    durationMs: Date.now() - start,
  };
}

function readDimensions(
  meta: sharp.Metadata,
  role: "image" | "mask",
): Dimensions {
  if (!meta.width || !meta.height) {
    throw new Error(
      `normalize: ${role} has no width/height in sharp metadata`,
    );
  }
  return { width: meta.width, height: meta.height };
}

function clampLongSide(size: Dimensions, cap: number): Dimensions {
  const longSide = Math.max(size.width, size.height);
  if (longSide <= cap) return size;
  const scale = cap / longSide;
  // Round to integers — sharp would do this anyway, but rounding here
  // keeps the `before/after` dims we log pixel-accurate.
  return {
    width: Math.round(size.width * scale),
    height: Math.round(size.height * scale),
  };
}

/**
 * Convenience logger for the normalize stage. Separate from
 * `normalizeRemovalInputs` so callers in the generation pipeline keep
 * their own log-event taxonomy (`remove.normalize.*`) rather than the
 * helper dictating it.
 */
export function logNormalizeResult(
  generationId: string,
  result: NormalizeRemovalInputsResult,
): void {
  logger.info(
    {
      event: "remove.normalize.done",
      generationId,
      action: result.action,
      before: result.before,
      after: result.after,
      durationMs: result.durationMs,
    },
    `Remove normalize: ${result.action}`,
  );
  const shapeChanged =
    result.before.image.width !== result.before.mask.width ||
    result.before.image.height !== result.before.mask.height;
  if (shapeChanged) {
    logger.warn(
      {
        event: "remove.normalize.mismatch",
        generationId,
        before: result.before,
        after: result.after,
      },
      "Remove normalize: image/mask shapes differed pre-normalization",
    );
  }
}
