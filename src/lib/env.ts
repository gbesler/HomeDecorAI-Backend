import { z } from "zod/v4";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive(),
  REPLICATE_API_TOKEN: z.string().min(1),
  FAL_AI_API_KEY: z.string().min(1),
  FIREBASE_SERVICE_ACCOUNT_KEY: z
    .string()
    .min(1)
    .transform((val) => {
      let parsed: Record<string, unknown>;
      try {
        const decoded = Buffer.from(val, "base64").toString("utf-8");
        parsed = JSON.parse(decoded) as Record<string, unknown>;
      } catch {
        throw new Error(
          "FIREBASE_SERVICE_ACCOUNT_KEY must be a valid base64-encoded JSON string",
        );
      }
      const required = ["project_id", "private_key", "client_email"] as const;
      for (const field of required) {
        if (typeof parsed[field] !== "string" || parsed[field] === "") {
          throw new Error(
            `FIREBASE_SERVICE_ACCOUNT_KEY is missing required field: ${field}`,
          );
        }
      }
      return parsed;
    }),
  // GCP service account used for Cloud Tasks (enqueue auth + OIDC token
  // minting for the internal processor callback). Base64-encoded JSON, same
  // shape as the Firebase key. The embedded `project_id` is the single
  // source of truth for the Cloud Tasks queue project — no separate
  // GCP_PROJECT_ID env var required. Optional while the /sync endpoints are
  // the only code path in use; required before async is re-enabled.
  GOOGLE_APPLICATION_CREDENTIALS: z
    .string()
    .min(1)
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      let parsed: Record<string, unknown>;
      try {
        const decoded = Buffer.from(val, "base64").toString("utf-8");
        parsed = JSON.parse(decoded) as Record<string, unknown>;
      } catch {
        throw new Error(
          "GOOGLE_APPLICATION_CREDENTIALS must be a valid base64-encoded JSON string",
        );
      }
      const required = ["project_id", "private_key", "client_email"] as const;
      for (const field of required) {
        if (typeof parsed[field] !== "string" || parsed[field] === "") {
          throw new Error(
            `GOOGLE_APPLICATION_CREDENTIALS is missing required field: ${field}`,
          );
        }
      }
      return parsed;
    }),
  AWS_S3_BUCKET: z.string().min(1),
  AWS_S3_REGION: z.string().min(1),
  AWS_CLOUDFRONT_HOST: z.string().min(1).optional(),
  // Cognito Identity Pool used unauthenticated to mint shared temp AWS
  // credentials for backend S3 writes. The pool must allow unauthenticated
  // identities; the unauth role's IAM policy must allow s3:PutObject on
  // `generations/*` in AWS_S3_BUCKET.
  AWS_COGNITO_IDENTITY_POOL_ID: z.string().regex(/^[a-z0-9-]+:[0-9a-f-]+$/),
  SWAGGER_API_KEY: z.string().min(1).optional(),
  SLACK_WEBHOOK_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().optional().default("info"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .optional()
    .default("development"),
  // Production safety valves for the interior prompt rewrite (D17 F2).
  // Flip these at runtime to roll back without a code deploy.
  PROMPT_BUILDER_VERSION: z
    .enum(["legacy", "v1"])
    .optional()
    .default("v1"),
  DICTIONARY_STRICT_MODE: z
    .enum(["strict", "degraded"])
    .optional()
    .default("strict"),
  // ─── Async generation pipeline (Cloud Tasks + FCM) ───────────────────────
  // TEMPORARY: These variables are optional while the /sync tool endpoints
  // are used for manual testing. The async Cloud Tasks path throws at
  // runtime if invoked without them — see `enqueueGenerationTask` and
  // `verifyCloudTask`. Make them required again before re-enabling async.
  // GCP_PROJECT_ID must match GOOGLE_APPLICATION_CREDENTIALS.project_id —
  // enforced at the entry of requireAsyncEnv so a mismatch fails fast
  // instead of producing opaque Cloud Tasks auth errors.
  GCP_PROJECT_ID: z.string().min(1).optional(),
  GCP_LOCATION: z.string().min(1).optional().default("us-central1"),
  GCP_QUEUE_NAME: z.string().min(1).optional().default("design-generation"),
  GCP_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  // Public URL of this backend, used by Cloud Tasks as the HTTP target.
  // Example: https://homedecorai-backend-pv3k.onrender.com
  BACKEND_PUBLIC_URL: z.string().url().optional(),
  // OIDC audience the internal endpoint validates tokens against.
  // Typically equals BACKEND_PUBLIC_URL + "/internal/process-generation".
  INTERNAL_TASK_AUDIENCE: z.string().url().optional(),
  // Hard kill-switch for FCM. Useful during staging/dev.
  FCM_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("true")
    .transform((v) => v === "true"),
  // Comma-separated host allowlist for AI provider output URLs that the
  // backend will fetch and upload to S3. SSRF guard — any host outside
  // this list is rejected before any network call is made.
  // ─── Segmentation + removal pipeline models ─────────────────────────────
  // Overridable at runtime so ops can swap community forks without a deploy.
  // Defaults are authoritative for this codebase; changes require re-verifying
  // that the slug's input/output schema matches our replicate.ts adapter.
  //
  // Segmentation: SAM 3 (Meta, Nov 2025) — concept-prompt segmentation.
  // Removal: LaMa (WACV 2022) — industry-standard object-removal inpainter.
  // Pipeline: Clean & Organize runs SAM 3 -> LaMa; Remove Objects runs
  // client-brush mask -> LaMa.
  REPLICATE_SEGMENTATION_MODEL: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, "must be in 'owner/name' form")
    .optional()
    .default("mattsays/sam3-image")
    .transform((v) => v as `${string}/${string}`),
  // `allenhooo/lama` is alive on Replicate; we were hitting the wrong
  // endpoint. Replicate's Aug 2025 changelog restricted the legacy
  // `POST /v1/models/{owner}/{name}/predictions` path to **official**
  // models only — community models (including allenhooo/lama) now
  // require the `{owner}/{name}:{version}` pinned form, which the
  // npm client routes to `POST /v1/predictions` instead. Without a
  // version suffix we were 404-ing on a live model. Pinning also
  // freezes output behaviour against silent upstream updates — a
  // helpful property for a generator we call on every Remove Objects
  // + Clean & Organize submission.
  //
  // Latest version hash as of 2026-04-20, verified via
  // https://replicate.com/allenhooo/lama/versions.
  //
  // Regex widened to accept the pinned `owner/name:version_hash`
  // form in addition to the bare `owner/name` (still legal for
  // Replicate's official models if we ever swap to one).
  REPLICATE_REMOVAL_MODEL: z
    .string()
    .regex(/^[^/]+\/[^/]+(?::[a-f0-9]{40,64})?$/, "must be in 'owner/name' or 'owner/name:version' form")
    .optional()
    .default("allenhooo/lama:cdac78a1bec5b23c07fd29692fb70baa513ea403a39e643c48ec5edadb15fe72")
    .transform((v) => v as `${string}/${string}`),
  // Prompt-driven inpainting: Flux Fill (BFL). Image + mask + prompt → image.
  // Used by Replace & Add Object. Flip between `flux-fill-dev` (cheap) and
  // `flux-fill-pro` (higher quality, ~5× cost) without a deploy.
  REPLICATE_INPAINT_MODEL: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, "must be in 'owner/name' form")
    .optional()
    .default("black-forest-labs/flux-fill-dev")
    .transform((v) => v as `${string}/${string}`),
  ALLOWED_AI_DOWNLOAD_HOSTS: z
    .string()
    .min(1)
    .optional()
    .default("replicate.delivery,pbxt.replicate.delivery,fal.media,v3.fal.media,v3b.fal.media,storage.googleapis.com")
    .transform((raw) =>
      raw
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0),
    ),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

// ─── Cross-field invariants ────────────────────────────────────────────────
// Fail fast at boot if the operator pointed a role-specific model env at a
// slug registered with the wrong role in PROVIDER_CAPABILITIES. Without this
// guard, a removal slug in REPLICATE_SEGMENTATION_MODEL would be called
// with segment-shaped input, return an image URL, and extractMaskUrl would
// happily feed that RGB frame into LaMa as if it were a binary mask.
//
// Unknown slugs (not in the capability matrix) are warned-only and allowed
// to boot; capability entries can lag behind community forks and blocking
// boot on a slug swap would be too strict.
//
// Dynamic import to avoid a load-order cycle (capabilities.ts imports from
// types.ts, which does not import env.ts — keep it that way).
void (async () => {
  const { getCapabilities } = await import(
    "./ai-providers/capabilities.js"
  );
  const checks: Array<[string, string, "segment" | "remove" | "inpaint"]> = [
    [
      "REPLICATE_SEGMENTATION_MODEL",
      env.REPLICATE_SEGMENTATION_MODEL,
      "segment",
    ],
    ["REPLICATE_REMOVAL_MODEL", env.REPLICATE_REMOVAL_MODEL, "remove"],
    ["REPLICATE_INPAINT_MODEL", env.REPLICATE_INPAINT_MODEL, "inpaint"],
  ];
  for (const [name, slug, expectedRole] of checks) {
    const capability = getCapabilities(slug);
    if (!capability) {
      console.warn(
        `[env] ${name}=${slug} is not registered in PROVIDER_CAPABILITIES; running without role verification. Add a capability entry before relying on this slug in production.`,
      );
      continue;
    }
    if (capability.role !== expectedRole) {
      console.error(
        `[env] ${name}=${slug} is registered with role="${capability.role}" but must be role="${expectedRole}". Segmentation and inpainting slugs are not interchangeable; pointing one at the other produces silent garbage output.`,
      );
      process.exit(1);
    }
  }
})().catch((err) => {
  console.error("[env] Capability role verification crashed:", err);
  process.exit(1);
});
