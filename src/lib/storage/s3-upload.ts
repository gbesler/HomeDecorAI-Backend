import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getAwsCredentials } from "./cognito-credentials.js";

/**
 * S3 upload helper for AI-generated interior design images.
 *
 * AI provider output URLs (Replicate/fal.ai) expire within hours — if we
 * persist them directly to Firestore, historical generations turn into broken
 * images. This module downloads the temp URL and writes it to S3 under
 * `generations/{firebaseUid}/...` so the URL we expose to clients is permanent.
 *
 * Auth model: shared unauthenticated Cognito credentials (see
 * `./cognito-credentials.ts`). The backend holds zero static AWS credentials.
 * The unauthenticated Cognito role's IAM policy allows writes to
 * `generations/*` in the target bucket.
 *
 * Defences:
 * - SSRF: only hosts in ALLOWED_AI_DOWNLOAD_HOSTS may be fetched.
 * - Response size: Content-Length is rejected above MAX_DOWNLOAD_BYTES.
 * - Timeout: fetch is bounded by DOWNLOAD_TIMEOUT_MS.
 * - Content type: we detect from Content-Type header, fall back to .jpg.
 */

const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const DOWNLOAD_TIMEOUT_MS = 60_000;

export class StorageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUploadError";
  }
}

function isHostAllowed(host: string): boolean {
  const normalized = host.toLowerCase();
  return env.ALLOWED_AI_DOWNLOAD_HOSTS.includes(normalized);
}

function extensionForContentType(contentType: string | null): {
  ext: string;
  mime: string;
} {
  if (!contentType) return { ext: "jpg", mime: "image/jpeg" };
  const lower = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (lower === "image/png") return { ext: "png", mime: "image/png" };
  if (lower === "image/webp") return { ext: "webp", mime: "image/webp" };
  if (lower === "image/jpeg" || lower === "image/jpg") {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  // Unknown — default to jpg with a warning so the caller can see it in logs.
  logger.warn(
    { event: "storage.unknown_content_type", contentType },
    "Unknown AI download content-type, defaulting to image/jpeg",
  );
  return { ext: "jpg", mime: "image/jpeg" };
}

export interface PersistGenerationImageInput {
  /** Firebase UID — written into the S3 key path. */
  userId: string;
  generationId: string;
  sourceUrl: string;
  /**
   * S3 key prefix. Defaults to "generations" — the canonical AI output path.
   * Callers persisting intermediate artifacts (e.g. segmentation masks) pass
   * "masks" so the lifecycle rules can expire them on a shorter cadence
   * without touching the main outputs.
   */
  keyPrefix?: string;
}

export interface DownloadSafeResult {
  buffer: Buffer;
  mime: string;
  bytes: number;
}

/**
 * Fetch a remote image into memory with the same SSRF / size / timeout
 * defences `persistGenerationImage` uses. Extracted so callers that need
 * the raw bytes (e.g. the Remove Objects normalizer, which resizes
 * in-process before re-uploading) don't have to re-implement the guards.
 */
export async function downloadSafe(
  sourceUrl: string,
): Promise<DownloadSafeResult> {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new StorageUploadError(`Invalid source URL: ${sourceUrl}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new StorageUploadError(
      `Refused to download non-HTTP(S) URL: ${parsed.protocol}`,
    );
  }

  if (!isHostAllowed(parsed.hostname)) {
    throw new StorageUploadError(
      `Host not in AI download allowlist: ${parsed.hostname}`,
    );
  }

  const controller = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await fetch(sourceUrl, { signal: controller });

  if (!response.ok) {
    throw new StorageUploadError(
      `Download failed with ${response.status} ${response.statusText}`,
    );
  }

  const contentLengthRaw = response.headers.get("content-length");
  if (contentLengthRaw) {
    const declared = Number.parseInt(contentLengthRaw, 10);
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new StorageUploadError(
        `Declared content-length ${declared} exceeds limit ${MAX_DOWNLOAD_BYTES}`,
      );
    }
  }

  const { mime } = extensionForContentType(response.headers.get("content-type"));

  const arrayBuffer = await response.arrayBuffer();
  const bytes = arrayBuffer.byteLength;
  if (bytes > MAX_DOWNLOAD_BYTES) {
    throw new StorageUploadError(
      `Downloaded body ${bytes} exceeds limit ${MAX_DOWNLOAD_BYTES}`,
    );
  }

  return { buffer: Buffer.from(arrayBuffer), mime, bytes };
}

export interface PersistGenerationBufferInput {
  userId: string;
  generationId: string;
  buffer: Buffer;
  mime: string;
  /** Same semantics as `PersistGenerationImageInput.keyPrefix`. */
  keyPrefix?: string;
  /**
   * Disambiguation suffix appended to `generationId` in the key. Required
   * when a single generation persists more than one artifact under the
   * same prefix (e.g. normalized image + normalized mask) — otherwise the
   * two writes collide on the same key. Omit when there's only ever one
   * artifact per (generationId, prefix) pair.
   */
  suffix?: string;
}

/**
 * Write pre-fetched bytes (already in memory, no URL to download) to S3.
 * Complements `persistGenerationImage` for callers that have already
 * resolved the buffer upstream — notably the normalization pipeline,
 * which needs to resize before upload and shouldn't double-fetch the
 * source URL just to reuse `persistGenerationImage`.
 */
export async function persistGenerationBuffer(
  input: PersistGenerationBufferInput,
): Promise<PersistGenerationImageResult> {
  const {
    userId,
    generationId,
    buffer,
    mime,
    keyPrefix = "generations",
    suffix,
  } = input;

  if (!userId || !userId.trim()) {
    throw new StorageUploadError("userId is required to compute the S3 key");
  }
  if (buffer.byteLength === 0) {
    throw new StorageUploadError("refusing to persist an empty buffer");
  }
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new StorageUploadError(
      `Buffer ${buffer.byteLength} exceeds limit ${MAX_DOWNLOAD_BYTES}`,
    );
  }

  const ext = mimeToExtension(mime);
  const base = suffix ? `${generationId}-${suffix}` : generationId;
  const key = `${keyPrefix}/${userId}/${base}.${ext}`;

  const creds = await getAwsCredentials();
  const s3 = new S3Client({
    region: env.AWS_S3_REGION,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5_000,
      socketTimeout: 60_000,
    }),
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mime,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  const outputImageUrl = `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_S3_REGION}.amazonaws.com/${key}`;
  const outputImageCDNUrl = env.AWS_CLOUDFRONT_HOST
    ? `https://${env.AWS_CLOUDFRONT_HOST}/${key}`
    : null;

  logger.info(
    {
      event: "storage.upload.ok",
      generationId,
      userId,
      bytes: buffer.byteLength,
      mime,
      key,
      cdn: outputImageCDNUrl !== null,
      source: "buffer",
    },
    "Buffer persisted to S3",
  );

  return {
    outputImageUrl,
    outputImageCDNUrl,
    bytes: buffer.byteLength,
    mime,
  };
}

function mimeToExtension(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    default:
      return "bin";
  }
}

export interface PersistGenerationImageResult {
  /** Native S3 URL (`https://<bucket>.s3.<region>.amazonaws.com/<key>`). Always set. */
  outputImageUrl: string;
  /**
   * CloudFront-fronted URL for the same key. Populated only when
   * `AWS_CLOUDFRONT_HOST` is configured; null otherwise. Clients that want
   * CDN-cached delivery should prefer this when non-null.
   */
  outputImageCDNUrl: string | null;
  bytes: number;
  mime: string;
}

/**
 * Download a temporary AI output URL and upload it to S3 under
 * `generations/{userId}/{generationId}.{ext}` using the shared Cognito
 * credentials. Returns both the native S3 URL (`outputImageUrl`) and, when
 * `AWS_CLOUDFRONT_HOST` is configured, the CloudFront-fronted URL
 * (`outputImageCDNUrl`). Callers persist both so historical reads can choose
 * between direct S3 and CDN delivery independently of runtime config.
 */
export async function persistGenerationImage(
  input: PersistGenerationImageInput,
): Promise<PersistGenerationImageResult> {
  const { userId, generationId, sourceUrl, keyPrefix = "generations" } = input;
  const { buffer, mime, bytes } = await downloadSafe(sourceUrl);
  return persistGenerationBuffer({
    userId,
    generationId,
    buffer,
    mime,
    keyPrefix,
  }).then((result) => {
    // Preserve the original caller's view of `bytes` (buffer byte length
    // equals `downloadSafe`'s reported bytes, but make it explicit).
    return { ...result, bytes };
  });
}
