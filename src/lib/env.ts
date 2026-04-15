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
  AWS_S3_BUCKET: z.string().min(1),
  AWS_S3_REGION: z.string().min(1),
  AWS_CLOUDFRONT_HOST: z.string().min(1).optional(),
  // Cognito Identity Pool shared with iOS. Backend federates the same
  // Firebase ID token (`securetoken.google.com/<projectId>`) that iOS uses,
  // so backend writes land on the same Cognito Identity ID as iOS uploads.
  // No developer provider, no per-backend role mapping. The token itself is
  // not minted on the backend — it arrives through the async-pipeline task
  // payload, produced by the iOS client at enqueue time.
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
  // TEMPORARY: These four variables are optional while the /sync tool
  // endpoints are used for manual testing. The async Cloud Tasks path will
  // throw at runtime if invoked without them set — see `enqueueGenerationTask`
  // and `verifyCloudTask`. Make them required again before re-enabling async.
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
