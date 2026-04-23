import sharp from "sharp";
import { logger } from "../logger.js";
import { downloadSafe } from "../storage/s3-upload.js";

/**
 * Provider-facing enum of aspect ratios the edit models accept. Kontext
 * Max Multi and Nano Banana both advertise this set (plus the "auto"
 * default on Nano Banana — we never send "auto" because the whole point
 * of this helper is to be explicit). Pruna p-image-edit accepts the
 * classic `aspect_ratio` string without a formally documented enum; it
 * tolerates any of these values in practice.
 *
 * Snap targets are ordered so the nearest-ratio walk below can pick
 * "16:9" over "21:9" when the input is mildly landscape, etc.
 */
const SUPPORTED_RATIOS: ReadonlyArray<{ label: string; value: number }> = [
  { label: "9:21", value: 9 / 21 },
  { label: "9:16", value: 9 / 16 },
  { label: "3:4", value: 3 / 4 },
  { label: "2:3", value: 2 / 3 },
  { label: "1:1", value: 1 / 1 },
  { label: "3:2", value: 3 / 2 },
  { label: "4:3", value: 4 / 3 },
  { label: "16:9", value: 16 / 9 },
  { label: "21:9", value: 21 / 9 },
];

/**
 * Fetch the input image's bytes, decode its stored dimensions with sharp,
 * and snap the measured ratio to the nearest entry in `SUPPORTED_RATIOS`.
 * Returns `null` on any failure — probe is best-effort; a provider falling
 * back to its own default is better than failing the whole generation.
 *
 * The download goes through `downloadSafe` so the same SSRF allowlist and
 * byte caps that protect the rest of the pipeline also protect this probe.
 * Sharp only needs enough bytes to read the header, but Node's fetch does
 * not expose a range-request shortcut here; a full-image download is the
 * same pattern `normalize-image-mask-pair` already uses for LaMa/Flux Fill.
 */
export async function probeImageAspectRatio(
  url: string,
): Promise<string | null> {
  try {
    const { buffer } = await downloadSafe(url);
    // `.rotate()` bakes EXIF orientation into the post-rotation dimensions
    // so a portrait photo shot landscape on the sensor reports its visually
    // correct shape, matching how iOS displays it.
    const meta = await sharp(buffer).rotate().metadata();
    const width = meta.width;
    const height = meta.height;
    if (!width || !height || width <= 0 || height <= 0) {
      logger.warn(
        { event: "aspect_probe.no_dims", url, meta: { width, height } },
        "probeImageAspectRatio: sharp returned no width/height",
      );
      return null;
    }
    return snapToSupportedRatio(width / height);
  } catch (err) {
    logger.warn(
      {
        event: "aspect_probe.error",
        url,
        error: err instanceof Error ? err.message : String(err),
      },
      "probeImageAspectRatio: probe failed, falling back to provider default",
    );
    return null;
  }
}

function snapToSupportedRatio(measured: number): string {
  let best = SUPPORTED_RATIOS[0];
  let bestDelta = Math.abs(Math.log(measured / best.value));
  for (const candidate of SUPPORTED_RATIOS) {
    const delta = Math.abs(Math.log(measured / candidate.value));
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best.label;
}

/**
 * Translate a canonical "W:H" ratio label into the named preset Klein 9B
 * Edit's `image_size` field expects. Klein does not accept raw "4:3"
 * strings — only these labelled presets or a `{width, height}` object.
 * We round-trip through the same SUPPORTED_RATIOS labels so the mapping
 * stays in one place.
 *
 * Schema reference: https://fal.ai/models/fal-ai/flux-2/klein/9b/edit
 */
export function aspectRatioToKleinImageSize(
  ratio: string,
): string | undefined {
  switch (ratio) {
    case "1:1":
      return "square_hd";
    case "4:3":
      return "landscape_4_3";
    case "3:2":
    case "16:9":
    case "21:9":
      return "landscape_16_9";
    case "3:4":
      return "portrait_4_3";
    case "2:3":
    case "9:16":
    case "9:21":
      return "portrait_16_9";
    default:
      return undefined;
  }
}
