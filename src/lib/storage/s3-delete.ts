import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getAwsCredentials } from "./cognito-credentials.js";

/**
 * Best-effort delete of objects we own in S3, used when a generation is
 * removed from Firestore so the underlying images don't accumulate as
 * orphans.
 *
 * Auth model mirrors `s3-upload.ts` — shared unauthenticated Cognito
 * credentials. The Cognito unauth role's IAM policy must allow
 * `s3:DeleteObject` on `arn:aws:s3:::<AWS_S3_BUCKET>/generations/*`,
 * `/inputs/*`, `/masks/*`, and any other prefix this backend writes.
 * Without that permission the calls return AccessDenied, the deletes
 * are logged as failures, and the Firestore document is removed
 * regardless — the user-perceived behaviour matches the previous
 * implementation, only the orphan accumulation is fixed.
 */

/**
 * Map a remote URL (S3 native or CloudFront-fronted) back to its S3 key.
 * Returns `null` for URLs that don't belong to our bucket — temp AI
 * provider URLs, third-party CDNs, or anything else we shouldn't touch.
 */
export function s3KeyFromOwnedUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const host = parsed.hostname.toLowerCase();
  const ownS3HostRegional = `${env.AWS_S3_BUCKET}.s3.${env.AWS_S3_REGION}.amazonaws.com`.toLowerCase();
  const ownS3HostShort = `${env.AWS_S3_BUCKET}.s3.amazonaws.com`.toLowerCase();
  const cdnHost = env.AWS_CLOUDFRONT_HOST?.toLowerCase() ?? null;

  const isOurHost = host === ownS3HostRegional || host === ownS3HostShort || host === cdnHost;
  if (!isOurHost) return null;

  // Strip the leading slash from the path portion to get the S3 key.
  // URLs may include query strings (e.g. signed URLs); we ignore those —
  // DeleteObject takes only the key.
  const key = parsed.pathname.replace(/^\/+/, "");
  return key.length > 0 ? key : null;
}

/**
 * Delete a set of S3 keys best-effort. Failures are logged and swallowed —
 * Firestore document removal is the source of truth for "is the generation
 * gone", and an orphaned object is preferable to a partially-deleted user
 * record. Operates on a deduped set of keys so paired URLs (S3 + CDN)
 * pointing at the same object don't trigger two deletes.
 */
export async function deleteOwnedS3Objects(urls: ReadonlyArray<string | null | undefined>): Promise<void> {
  const keys = new Set<string>();
  for (const url of urls) {
    const key = s3KeyFromOwnedUrl(url);
    if (key) keys.add(key);
  }
  if (keys.size === 0) return;

  let client: S3Client;
  try {
    const creds = await getAwsCredentials();
    client = new S3Client({
      region: env.AWS_S3_REGION,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5_000,
        socketTimeout: 30_000,
      }),
    });
  } catch (error) {
    logger.warn(
      { event: "storage.delete.cred_failure", error: error instanceof Error ? error.message : String(error) },
      "Failed to obtain Cognito credentials for S3 delete; skipping",
    );
    return;
  }

  await Promise.all(
    Array.from(keys).map(async (key) => {
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: env.AWS_S3_BUCKET,
            Key: key,
          }),
        );
        logger.info({ event: "storage.delete.ok", key }, "S3 object deleted");
      } catch (error) {
        logger.warn(
          {
            event: "storage.delete.failed",
            key,
            error: error instanceof Error ? error.message : String(error),
          },
          "S3 delete failed; object may be orphaned",
        );
      }
    }),
  );
}
