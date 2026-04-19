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

  // Guard against an empty or whitespace userId — without per-user IAM
  // scoping, a blank value would silently produce orphan keys at
  // `generations//{generationId}.ext` shared across every caller hitting
  // the same path.
  if (!userId || !userId.trim()) {
    throw new StorageUploadError("userId is required to compute the S3 key");
  }

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

  // Download phase does not need AWS creds — this is a public URL fetch.
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

  const { ext, mime } = extensionForContentType(
    response.headers.get("content-type"),
  );

  // Buffer the full body. 10 MB cap above keeps this bounded; for AI outputs
  // (typically 1-3 MB) the memory footprint is negligible. Re-check the actual
  // length after buffering in case Content-Length was absent.
  const arrayBuffer = await response.arrayBuffer();
  const bytes = arrayBuffer.byteLength;
  if (bytes > MAX_DOWNLOAD_BYTES) {
    throw new StorageUploadError(
      `Downloaded body ${bytes} exceeds limit ${MAX_DOWNLOAD_BYTES}`,
    );
  }

  const creds = await getAwsCredentials();

  const key = `${keyPrefix}/${userId}/${generationId}.${ext}`;

  // Build a fresh S3 client for this request. The client is cheap to
  // construct and lives only for the duration of the PutObject, keeping the
  // credential scope exactly as wide as this one write.
  const s3 = new S3Client({
    region: env.AWS_S3_REGION,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
    // Bound PutObject so a slow S3 endpoint cannot stall the worker until
    // the Cloud Tasks dispatch deadline (600s). Same posture as the download
    // phase, which uses a 60s AbortSignal.
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5_000,
      socketTimeout: 60_000,
    }),
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
      Body: Buffer.from(arrayBuffer),
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
      bytes,
      mime,
      key,
      cdn: outputImageCDNUrl !== null,
    },
    "AI output persisted to S3",
  );

  return { outputImageUrl, outputImageCDNUrl, bytes, mime };
}
