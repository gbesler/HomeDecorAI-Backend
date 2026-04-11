import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getUserAwsCredentials } from "./cognito-credentials.js";

/**
 * S3 upload helper for AI-generated interior design images.
 *
 * AI provider output URLs (Replicate/fal.ai) expire within hours — if we
 * persist them directly to Firestore, historical generations turn into broken
 * images. This module downloads the temp URL and writes it to S3 under a
 * Cognito-scoped key so the URL we expose to clients is permanent.
 *
 * Auth model: per-user temporary credentials minted via Cognito Identity
 * Pool with Firebase OIDC federation (see `./cognito-credentials.ts`). The
 * backend holds **zero static AWS credentials** — the only bootstrap secret
 * is the Firebase service account key, already required for Firestore.
 * IAM policy on the Cognito auth role restricts writes to
 * `generations/${cognito-identity.amazonaws.com:sub}/*`, so even if this
 * process were compromised mid-call the blast radius is a single user's
 * prefix — not the whole bucket.
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
  /** Firebase UID. Used as the per-user cache key for minted credentials. */
  userId: string;
  generationId: string;
  sourceUrl: string;
  /**
   * Raw Firebase ID token from the user's original request, passed through
   * the Cloud Tasks payload. Used directly with Cognito federation — iOS
   * and backend end up on the same Cognito Identity ID. Never logged.
   */
  firebaseIdToken: string;
}

export interface PersistGenerationImageResult {
  outputImageUrl: string;
  /** Cognito Identity ID that performed the upload — persisted in Firestore. */
  cognitoIdentityId: string;
  bytes: number;
  mime: string;
}

/**
 * Download a temporary AI output URL and upload it to S3 under
 * `generations/{cognitoIdentityId}/{generationId}.{ext}` using per-user Cognito
 * credentials. Returns the canonical public URL (CloudFront-fronted when
 * configured, native S3 URL otherwise).
 */
export async function persistGenerationImage(
  input: PersistGenerationImageInput,
): Promise<PersistGenerationImageResult> {
  const { userId, generationId, sourceUrl, firebaseIdToken } = input;

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

  // Mint per-user Cognito credentials. Cached if still fresh, otherwise a
  // ~200ms round trip to Cognito using the provided Firebase ID token. The
  // returned identityId goes into the S3 key so the IAM policy variable
  // `${cognito-identity.amazonaws.com:sub}` resolves correctly and
  // authorizes the write.
  const creds = await getUserAwsCredentials(userId, firebaseIdToken);
  const cognitoIdentityId = creds.identityId;

  const key = `generations/${cognitoIdentityId}/${generationId}.${ext}`;

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

  const outputImageUrl = env.AWS_CLOUDFRONT_HOST
    ? `https://${env.AWS_CLOUDFRONT_HOST}/${key}`
    : `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_S3_REGION}.amazonaws.com/${key}`;

  logger.info(
    {
      event: "storage.upload.ok",
      generationId,
      cognitoIdentityId,
      bytes,
      mime,
      key,
    },
    "AI output persisted to S3 via Cognito-scoped credentials",
  );

  return { outputImageUrl, cognitoIdentityId, bytes, mime };
}
