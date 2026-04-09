import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { env } from "./env.js";

const s3 = new S3Client({
  region: env.AWS_S3_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = env.AWS_S3_BUCKET;

/**
 * Upload a buffer to S3 and return the public URL.
 */
export async function uploadToS3(
  buffer: Buffer,
  options: {
    folder: string;
    contentType: string;
    extension: string;
    userId: string;
  },
): Promise<string> {
  const key = `${options.folder}/${options.userId}/${randomUUID()}.${options.extension}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: options.contentType,
    }),
  );

  return `https://${BUCKET}.s3.${env.AWS_S3_REGION}.amazonaws.com/${key}`;
}

/**
 * Generate a presigned URL for reading a private S3 object.
 */
export async function getPresignedUrl(
  key: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });

  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}

/**
 * Check if a URL points to our own S3 bucket's uploads prefix.
 */
export function isOwnS3Url(url: string): boolean {
  try {
    const parsed = new URL(url);
    const expectedHost = `${BUCKET}.s3.${env.AWS_S3_REGION}.amazonaws.com`;
    return parsed.hostname === expectedHost && parsed.pathname.startsWith("/uploads/");
  } catch {
    return false;
  }
}

/**
 * Download an image from a URL and upload it to S3.
 * Used to persist AI-generated images from provider CDNs.
 */
export async function downloadAndUploadToS3(
  sourceUrl: string,
  options: {
    folder: string;
    userId: string;
  },
): Promise<string> {
  const response = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  const extension = contentType.includes("png") ? "png" : "jpg";

  return uploadToS3(buffer, {
    folder: options.folder,
    contentType,
    extension,
    userId: options.userId,
  });
}
