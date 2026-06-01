import { env } from "../env.js";

/**
 * Trusted base host for inspiration images. Prefer the CloudFront
 * distribution; fall back to the virtual-hosted S3 host. Kept in lockstep
 * with `allowedInspirationHosts()` in `lib/inspiration/schemas.ts` so a URL
 * composed here is always on an allow-listed host — the composed URL still
 * passes `validatePublicImageUrl` before it reaches an image provider.
 */
function inspirationBaseHost(): string {
  if (env.AWS_CLOUDFRONT_HOST) return env.AWS_CLOUDFRONT_HOST;
  return `${env.AWS_S3_BUCKET}.s3.${env.AWS_S3_REGION}.amazonaws.com`;
}

/**
 * Compose a full `https://` URL from a stored bucket-relative `path`
 * (e.g. `in_app_images/01_Sectional_Sofa.jpeg`). The read-time inverse of
 * what the seed pipeline stores: docs hold the infra-agnostic `path`, and
 * every consumer that needs a fetchable URL composes it from the env base.
 *
 * The `path` was validated by `PathSchema` at seed time (no scheme/host/
 * leading-slash/traversal); the leading-slash strip here is defense in depth
 * against a hand-edited doc, so the join can never produce `https://host//…`.
 */
export function inspirationImageUrlFromPath(path: string): string {
  const host = inspirationBaseHost();
  const cleaned = path.replace(/^\/+/, "");
  return `https://${host}/${cleaned}`;
}
