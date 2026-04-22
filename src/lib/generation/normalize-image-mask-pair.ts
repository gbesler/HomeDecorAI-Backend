import sharp from "sharp";
import { logger } from "../logger.js";
import { downloadSafe, persistGenerationBuffer } from "../storage/s3-upload.js";

/**
 * Raised when the image or mask cannot be normalized because of a
 * client-payload-shape issue (sharp failed to decode, metadata missing
 * width/height, pixel count exceeds our per-image ceiling). Distinct from
 * `StorageUploadError` (fetch/S3 transport problems) and generic errors
 * (upstream provider outage) — the processor maps this to
 * `VALIDATION_FAILED` so operator dashboards and the iOS retry UX don't
 * mistake a malformed upload for an AI provider outage.
 */
export class NormalizeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizeInputError";
  }
}

/** Hard ceiling on decoded pixel count. Above this sharp's RGBA raster
 *  (~4 bytes/pixel × 2 buffers for resize) risks OOM on a 512 MB Render
 *  instance under concurrent load. 50 MP covers every iPhone capture
 *  format we ship today (48 MP Pro + generous headroom) while keeping
 *  the worst-case sharp raster under ~200 MB. */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Guarantee that a paired `image` + `mask` handed to an inpainting /
 * removal model have identical pixel dimensions and that the image
 * long-side stays within the model's practical envelope.
 *
 * Motivating bug: both LaMa (Remove Objects) and Flux Fill (Replace &
 * Add Object) silently return `null` when image and mask pixel shapes
 * disagree. Pre-iOS-PR-#13 clients ship an image at native camera
 * resolution with a mask rendered against the UIImage's display-scaled
 * copy, which desyncs shapes on portrait photos. This helper is the
 * backend-side defense-in-depth for both paths.
 *
 * See `docs/plans/2026-04-22-001-fix-remove-objects-vertical-normalization-plan.md`
 * for the full rationale (originally scoped to the removal path;
 * broadened to inpaint in a follow-up).
 */

/** Image long-side cap. Values above this put Replicate's consumer
 *  GPU tier (the deployment target for both LaMa and Flux Fill) into
 *  OOM territory. Matches the iOS PR #13 client cap so post-PR-#13
 *  uploads take the passthrough path. */
const MAX_LONG_SIDE = 2048;

export interface NormalizeImageMaskPairInput {
  imageUrl: string;
  maskUrl: string;
  userId: string;
  generationId: string;
}

export interface NormalizeImageMaskPairResult {
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

export async function normalizeImageMaskPair(
  input: NormalizeImageMaskPairInput,
): Promise<NormalizeImageMaskPairResult> {
  const start = Date.now();

  // Parallel fetch — both URLs are on the same CDN so network latency
  // dominates over any per-request fixed cost. Downloads stay parallel;
  // only the sharp CPU+memory pipelines below get serialized to halve
  // peak RSS under concurrent load.
  const [imageDl, maskDl] = await Promise.all([
    downloadSafe(input.imageUrl),
    downloadSafe(input.maskUrl),
  ]);

  // Sharp's `.metadata()` reports raw stored dims and a separate
  // `orientation` field for EXIF. The previous implementation used those
  // raw dims for passthrough comparison, but then the normalize branch
  // preserved EXIF via `.withMetadata()` — which meant LaMa's decoder
  // could re-apply orientation and produce a payload whose pixel shape
  // doesn't match the mask. We normalize *post-rotation* dims here
  // (i.e. `.rotate()` baked into a fresh pipeline before metadata) so
  // the shape comparison and the eventual resize operate on the same
  // coordinate system the mask was authored against.
  const [imageMeta, maskMeta] = await Promise.all([
    readMetadata(imageDl.buffer, "image"),
    readMetadata(maskDl.buffer, "mask"),
  ]);

  const originalImage = readDimensions(imageMeta, "image");
  const originalMask = readDimensions(maskMeta, "mask");

  // Pixel-count guard. Protects the Render instance from an OOM when a
  // pathological upload would decode to a 200+ MB RGBA raster. Runs
  // after metadata (which is O(header bytes)) but before any decode, so
  // the defensive cost is ~nothing.
  assertPixelCount(originalImage, "image");
  assertPixelCount(originalMask, "mask");

  const targetImage = clampLongSide(originalImage, MAX_LONG_SIDE);

  const imageNeedsResize =
    targetImage.width !== originalImage.width ||
    targetImage.height !== originalImage.height;

  const maskNeedsResize =
    originalMask.width !== targetImage.width ||
    originalMask.height !== targetImage.height;

  // Passthrough is narrow on purpose: dims already match AND the image
  // has no non-identity EXIF orientation. If it did, forwarding the raw
  // JPEG bytes to LaMa would let the decoder apply orientation and
  // desync from the unrotated mask. Anything outside these invariants
  // goes through the re-encode branch where we bake rotation and strip
  // orientation metadata.
  const imageNeedsReencode =
    imageNeedsResize || !isIdentityOrientation(imageMeta.orientation);

  if (!imageNeedsReencode && !maskNeedsResize) {
    return {
      imageUrl: input.imageUrl,
      maskUrl: input.maskUrl,
      action: "passthrough",
      before: { image: originalImage, mask: originalMask },
      after: { image: originalImage, mask: originalMask },
      durationMs: Date.now() - start,
    };
  }

  // Sharp pipelines run sequentially (not Promise.all) — CPU is
  // single-threaded anyway at this buffer size, and keeping at most one
  // RGBA raster resident halves peak heap vs. running both pipelines in
  // parallel. Network I/O remains parallel above.
  //
  // Image: `.rotate()` with no arg auto-orients from EXIF and strips
  // the tag. `.resize(..., { fit: "fill" })` preserves the proportional
  // target computed in `clampLongSide`. JPEG q=90 at 2048-long-side
  // typically lands under 2 MB; far below `MAX_DOWNLOAD_BYTES` (10 MB).
  // No `.withMetadata()` — that's what created the EXIF re-application
  // bug in the previous implementation.
  const imageBuffer = await sharpRun(
    () =>
      sharp(imageDl.buffer)
        .rotate()
        .resize(targetImage.width, targetImage.height, { fit: "fill" })
        .jpeg({ quality: 90 })
        .toBuffer(),
    "image",
  );

  // Mask: nearest-neighbor is the only correct kernel for a binary
  // mask. Bilinear / bicubic produce intermediate grays at edges that
  // LaMa interprets as "neither remove nor preserve", softening object
  // boundaries. Always re-encode as PNG even if dims already match —
  // guarantees the uploaded `-mask.png` body is actually PNG regardless
  // of what Content-Type the client originally sent.
  const maskBuffer = await sharpRun(
    () =>
      sharp(maskDl.buffer)
        .resize(targetImage.width, targetImage.height, {
          fit: "fill",
          kernel: "nearest",
        })
        .png()
        .toBuffer(),
    "mask",
  );

  // Uploads stay parallel — two small PUTs, no CPU or memory cost on
  // our side, and the deterministic key scheme (`-image` / `-mask`
  // suffixes) makes retries idempotent. If one leg fails, the other
  // leaves an orphan artifact that the `normalized/` lifecycle rule
  // reaps — acceptable since the lifecycle is the whole point of the
  // separate prefix.
  const [uploadedImage, uploadedMask] = await Promise.all([
    persistGenerationBuffer({
      userId: input.userId,
      generationId: input.generationId,
      buffer: imageBuffer,
      mime: "image/jpeg",
      keyPrefix: "normalized",
      suffix: "image",
    }),
    persistGenerationBuffer({
      userId: input.userId,
      generationId: input.generationId,
      buffer: maskBuffer,
      mime: "image/png",
      keyPrefix: "normalized",
      suffix: "mask",
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

async function readMetadata(
  buffer: Buffer,
  role: "image" | "mask",
): Promise<sharp.Metadata> {
  try {
    return await sharp(buffer).metadata();
  } catch (err) {
    throw new NormalizeInputError(
      `normalize: ${role} could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function sharpRun(
  fn: () => Promise<Buffer>,
  role: "image" | "mask",
): Promise<Buffer> {
  try {
    return await fn();
  } catch (err) {
    // Sharp throws plain Errors; map them to our typed class so the
    // processor's catch block routes a corrupt upload to
    // VALIDATION_FAILED instead of AI_PROVIDER_FAILED.
    throw new NormalizeInputError(
      `normalize: sharp failed on ${role}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function readDimensions(
  meta: sharp.Metadata,
  role: "image" | "mask",
): Dimensions {
  if (meta.width == null || meta.height == null) {
    throw new NormalizeInputError(
      `normalize: ${role} has no width/height (format=${meta.format ?? "unknown"})`,
    );
  }
  return { width: meta.width, height: meta.height };
}

function assertPixelCount(size: Dimensions, role: "image" | "mask"): void {
  const pixels = size.width * size.height;
  if (pixels > MAX_INPUT_PIXELS) {
    throw new NormalizeInputError(
      `normalize: ${role} has ${pixels} pixels, exceeds limit ${MAX_INPUT_PIXELS} (${size.width}x${size.height})`,
    );
  }
}

/** Sharp reports EXIF `orientation` as 1-8 (or undefined when absent).
 *  Values 1 and undefined mean "no rotation" — safe to passthrough.
 *  Anything 2-8 means the raw pixel buffer is rotated/mirrored relative
 *  to the display orientation the mask was authored against. */
function isIdentityOrientation(orientation: number | undefined): boolean {
  return orientation === undefined || orientation === 1;
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
 * Convenience logger for the normalize stage. The `eventPrefix` keeps
 * the per-pipeline log taxonomy stable so operator dashboards keyed off
 * `remove.normalize.*` stay intact while the inpaint path emits its own
 * parallel `inpaint.normalize.*` events. Valid values today are
 * `"remove"` (LaMa / Remove Objects) and `"inpaint"` (Flux Fill /
 * Replace & Add Object). Typed as a union so adding a third pipeline
 * requires widening the type — prevents silent drift into arbitrary
 * strings.
 */
export function logNormalizeResult(
  generationId: string,
  result: NormalizeImageMaskPairResult,
  eventPrefix: "remove" | "inpaint",
): void {
  logger.info(
    {
      event: `${eventPrefix}.normalize.done`,
      generationId,
      action: result.action,
      before: result.before,
      after: result.after,
      durationMs: result.durationMs,
    },
    `${eventPrefix} normalize: ${result.action}`,
  );
  const shapeChanged =
    result.before.image.width !== result.before.mask.width ||
    result.before.image.height !== result.before.mask.height;
  if (shapeChanged) {
    logger.warn(
      {
        event: `${eventPrefix}.normalize.mismatch`,
        generationId,
        before: result.before,
        after: result.after,
      },
      `${eventPrefix} normalize: image/mask shapes differed pre-normalization`,
    );
  }
}
