import { z } from "zod";

/**
 * Relative storage path for an inspiration image — the AWS-side folder +
 * filename, with NO scheme and NO host
 * (e.g. `in_app_images/01_Sectional_Sofa.jpeg`).
 *
 * We store the path, not a fully-qualified URL, so a content row stays
 * infrastructure-agnostic: the bucket/region/CloudFront host can change
 * without rewriting every document. The full URL is composed at read time
 * from a trusted base — `AWSService.cloudFrontHost` on iOS, the env base on
 * the backend AI pipeline.
 *
 * **Security.** The stored value is later joined to a trusted base and, on
 * the backend, handed to an image provider that will fetch it. The path is
 * the only attacker-influenceable segment, so reject anything that could
 * smuggle a host, climb out of the bucket prefix, or inject a scheme:
 *   - a URL scheme (`https://…`, or a bare `scheme:` prefix)
 *   - a leading `/` (would compose to `//host/…` or escape the base path)
 *   - a `..` path segment (traversal), literal or percent-encoded
 *   - a backslash, whitespace, `@` (userinfo smuggling), or control char
 *   - a percent-encoded slash (`%2f`) or backslash (`%5c`)
 */
export function isSafeInspirationPath(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const v = raw.trim();
  if (v.length === 0 || v.length > 1024) return false;
  if (v.startsWith("/")) return false;
  if (v.includes("://")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false; // bare `scheme:` prefix
  if (v.includes("\\")) return false;
  if (/\s/.test(v)) return false;
  if (v.includes("@")) return false;
  if (v.split("/").some((seg) => seg === "..")) return false; // literal traversal
  if (/%2e%2e/i.test(v) || /%2f/i.test(v) || /%5c/i.test(v)) return false; // encoded traversal/slash
  // control chars (NUL–US, DEL) — checked by codepoint to avoid embedding raw bytes
  if (Array.from(v).some((ch) => { const c = ch.charCodeAt(0); return c < 0x20 || c === 0x7f; })) return false;
  return true;
}

/**
 * Zod field for a bucket-relative inspiration image path. Shared by the
 * object-inspiration and explorer schemas (both flows store the same shape).
 */
export const PathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(isSafeInspirationPath, {
    message:
      "path must be a bucket-relative storage path (e.g. 'in_app_images/foo.jpeg') — no scheme, host, leading slash, or '..' segment.",
  });
