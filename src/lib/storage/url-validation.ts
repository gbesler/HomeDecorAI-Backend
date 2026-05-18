/**
 * Shared URL validation utilities — SSRF + scheme guards that need to
 * run from both the controller's request-time validation loop and the
 * server-side substitution paths in `preEnqueueValidate` hooks.
 *
 * The private-host regex covers IPv4 RFC-1918 ranges (10/8, 172.16/12,
 * 192.168/16), loopback (127/8, 0.0.0.0, localhost, ::1), link-local
 * (169.254/16 — AWS IMDS lives there), and IPv6 unique-local + link-
 * local (fc00::/7, fe80::/10). The check fires BEFORE any URL is sent
 * to Replicate or fal.ai workers — they run in cloud datacenters where
 * these ranges typically reach internal metadata services.
 *
 * Kept in the storage namespace alongside `downloadSafe` because both
 * helpers exist to defend against the same threat model: untrusted URLs
 * reaching backend or provider-side fetches. Importing from
 * `controllers/design.controller.ts` would create a cycle with
 * `tool-types.ts` (the controller already depends on the registry).
 *
 * DNS-based rebinding attacks are out of scope here — the provider
 * performs its own fetch in its own network namespace.
 */

const PRIVATE_HOST_RE =
  /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|localhost$|::1$|fc[0-9a-f][0-9a-f]:|fe80:|172\.(?:1[6-9]|2[0-9]|3[01])\.)/i;

/**
 * True when `host` matches a private-IP / link-local / loopback range
 * that must never be sent to a provider worker. Case-insensitive; pass
 * the parsed `URL.hostname` (already lowercased by the URL parser).
 */
export function isPrivateHost(host: string): boolean {
  return PRIVATE_HOST_RE.test(host);
}

/**
 * Scheme + private-host check. Returns `{ ok: true }` on success or
 * `{ ok: false, message }` with a human-readable failure reason.
 * The controller uses this on client-supplied body fields; server
 * substitution paths (preEnqueueValidate) use it on Firestore-
 * resolved URLs before propagating them downstream.
 */
export function validatePublicImageUrl(
  imageUrl: unknown,
  fieldName: string,
): { ok: true } | { ok: false; message: string } {
  if (typeof imageUrl !== "string" || !/^https?:\/\//i.test(imageUrl)) {
    return {
      ok: false,
      message: `${fieldName} must use http or https scheme`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return { ok: false, message: `${fieldName} is not a valid URL` };
  }
  const host = parsed.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    return {
      ok: false,
      message: `${fieldName} resolves to a disallowed host range`,
    };
  }
  return { ok: true };
}
