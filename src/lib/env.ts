import { z } from "zod/v4";

// Exported so test files can call `envSchema.parse(...)` against
// minimal fixtures without invoking the module-level singleton parse
// at the bottom of this file. The runtime `env` constant remains the
// only consumer of the parsed result in production code.
export const envSchema = z.object({
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
  // Production safety valves for the interior prompt rewrite.
  // - "legacy": original single-template prompt builder (D17 F2 escape hatch)
  // - "v1":    current 7-layer composition with action-mode branches (default)
  // - "v2":    head-layer-inlined preservation, descriptive preservationHint,
  //            input-anchored photography-quality, changeBudget-driven verbs
  // Flip at runtime to roll forward to v2 (after staging burn-in) or back to
  // v1/legacy without a code deploy.
  PROMPT_BUILDER_VERSION: z
    .enum(["legacy", "v1", "v2"])
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
  // SAM 3 is a community model, so Replicate's Aug 2025 endpoint split forces
  // the pinned `owner/name:version` form on `/v1/predictions` — the bare slug
  // 404s on the legacy `/v1/models/{owner}/{name}/predictions` path that the
  // npm client routes unpinned community calls through. Same fix we applied
  // to LaMa on 2026-04-20.
  //
  // Latest version hash as of 2026-04-23, verified via
  // https://replicate.com/mattsays/sam3-image/versions.
  REPLICATE_SEGMENTATION_MODEL: z
    .string()
    .regex(/^[^/]+\/[^/]+(?::[a-f0-9]{40,64})?$/, "must be in 'owner/name' or 'owner/name:version' form")
    .optional()
    .default("mattsays/sam3-image:d73db077226443ba4fafd34e233b3626b552eac2a433f90c7c32a9ac89bd9e72")
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
  //
  // ORPHANED AS OF v4.0 — the Replace & Add Object tool no longer
  // routes through the `inpaint` role / `callInpaint` pipeline. v4.0
  // rebuilt the tool on `google/nano-banana` (Gemini 2.5 Flash Image)
  // multi-image edit via the `edit` role; the registry entry's
  // `models.replicate` field is now the source of truth for that tool.
  // This env var + the FALAI_INPAINT_MODEL pair + their boot-log
  // entries below + the `callInpaint` exports in router.ts + the
  // `flux-fill-*` and `fal-ai/flux-pro/v1/fill` entries in
  // capabilities.ts are all scheduled for a single cleanup pass once
  // the v4.0 path observes a clean 7-day window in production. The
  // env var is left in place during that window for two reasons:
  // (1) a quick env-driven rollback to a Flux Fill-shaped path would
  // require this knob if Unit 6's deletion of prompt-inpaint.ts is
  // also reverted; (2) keeping the env validation prevents accidental
  // staging configs that still set the variable from being rejected
  // at boot.
  REPLICATE_INPAINT_MODEL: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, "must be in 'owner/name' form")
    .optional()
    .default("black-forest-labs/flux-fill-pro")
    .transform((v) => v as `${string}/${string}`),
  // fal.ai fallback model slugs for the segment/remove/inpaint pipelines.
  // Hot-swappable without a deploy for parity with the REPLICATE_* entries
  // above. Defaults are the slugs documented in capabilities.ts.
  FALAI_SEGMENTATION_MODEL: z
    .string()
    .min(1)
    .optional()
    .default("fal-ai/sam-3/image"),
  FALAI_REMOVAL_MODEL: z
    .string()
    .min(1)
    .optional()
    .default("fal-ai/object-removal"),
  FALAI_INPAINT_MODEL: z
    .string()
    .min(1)
    .optional()
    .default("fal-ai/flux-pro/v1/fill"),
  // ─── Replace & Add Object v5.0 (crop-composite-refine) ─────────────────
  // BG removal: fal.ai birefnet primary, replicate fallback. Used by the
  // Replace & Add Object tool's v5 pipeline to isolate the inspiration
  // object before pixel-level pasting into the masked region.
  FALAI_BG_REMOVE_MODEL: z
    .string()
    .min(1)
    .optional()
    .default("fal-ai/birefnet/v2"),
  REPLICATE_BG_REMOVE_MODEL: z
    .string()
    .regex(/^[^/]+\/[^/]+(?::[a-f0-9]{40,64})?$/, "must be in 'owner/name' or 'owner/name:version' form")
    .optional()
    .default("851-labs/background-remover")
    .transform((v) => v as `${string}/${string}`),
  // Refine inpaint: fal.ai SDXL inpaint primary (compute-second billed,
  // typically ~$0.005-0.01 per 1024² at 20 steps), replicate lucataco
  // sdxl-inpainting fallback. Low-strength denoise pass around mask
  // edges to blend lighting/shadows on the pixel-composite result.
  // Refine endpoints — orphaned in v6.0 (kept for env-validation
  // backward compat). v6.0 replaced the v5.x birefnet+composite+refine
  // pipeline with a single call to fal-ai/flux-kontext-lora/inpaint
  // which natively accepts image_url + mask_url + reference_image_url.
  // These env vars no longer drive any code path.
  FALAI_INPAINT_REFINE_MODEL: z
    .string()
    .min(1)
    .optional()
    .default("fal-ai/flux-pro/v1/fill"),
  REPLICATE_INPAINT_REFINE_MODEL: z
    .string()
    .regex(/^[^/]+\/[^/]+(?::[a-f0-9]{40,64})?$/, "must be in 'owner/name' or 'owner/name:version' form")
    .optional()
    .default("black-forest-labs/flux-fill-pro")
    .transform((v) => v as `${string}/${string}`),
  // ─── Replace & Add Object v6.0 (Flux Kontext LoRA Inpaint) ──────────────
  // Reference-aware inpaint endpoint. Native schema: image_url + mask_url
  // + reference_image_url + prompt. ACE++ architecture lineage (in-context
  // token concatenation), purpose-built for "place this specific reference
  // object into this masked region with identity preservation". ~$0.035
  // per 1024² inference at default 30 inference steps.
  //
  // No Replicate fallback — researched and confirmed no Replicate
  // endpoint hosts a verified reference-aware inpaint model in May 2026.
  // If Kontext fails, the pipeline fails the generation (the user sees
  // the standard AI_PROVIDER_FAILED error and a retry). This is
  // acceptable because Kontext is a verified-live production endpoint
  // with proper status reporting — failures will be transient.
  FALAI_KONTEXT_INPAINT_MODEL: z
    .string()
    .min(1)
    .optional()
    .default("fal-ai/flux-kontext-lora/inpaint"),
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
  // Cover both REPLICATE_* and FALAI_* pipeline slugs. An operator who
  // misconfigures FALAI_SEGMENTATION_MODEL to a removal slug would otherwise
  // silently hand segmentation-shaped input to an inpainter during the rare
  // fallback path — producing either a schema reject or, worse, a false
  // "already clean" short-circuit that users interpret as a working feature.
  const checks: Array<
    [
      string,
      string,
      "segment" | "remove" | "inpaint" | "bg-remove" | "inpaint-refine",
    ]
  > = [
    [
      "REPLICATE_SEGMENTATION_MODEL",
      env.REPLICATE_SEGMENTATION_MODEL,
      "segment",
    ],
    ["REPLICATE_REMOVAL_MODEL", env.REPLICATE_REMOVAL_MODEL, "remove"],
    ["REPLICATE_INPAINT_MODEL", env.REPLICATE_INPAINT_MODEL, "inpaint"],
    ["FALAI_SEGMENTATION_MODEL", env.FALAI_SEGMENTATION_MODEL, "segment"],
    ["FALAI_REMOVAL_MODEL", env.FALAI_REMOVAL_MODEL, "remove"],
    ["FALAI_INPAINT_MODEL", env.FALAI_INPAINT_MODEL, "inpaint"],
    [
      "FALAI_BG_REMOVE_MODEL",
      env.FALAI_BG_REMOVE_MODEL,
      "bg-remove",
    ],
    [
      "REPLICATE_BG_REMOVE_MODEL",
      env.REPLICATE_BG_REMOVE_MODEL,
      "bg-remove",
    ],
    // Refine endpoints currently default to Flux Fill models which are
    // registered with role="inpaint" in capabilities.ts (they're shared
    // with the prompt-inpaint path used by other tools). Skip the role
    // check for these two — the pipeline driver knows what shape these
    // models accept and calls them through the SDXL-inpaint-shaped
    // wrapper (which gracefully degrades when the underlying schema
    // rejects an unknown field).
    //
    // [REPLICATE_INPAINT_REFINE_MODEL, env.REPLICATE_INPAINT_REFINE_MODEL, "inpaint-refine"],
    // [FALAI_INPAINT_REFINE_MODEL,    env.FALAI_INPAINT_REFINE_MODEL,    "inpaint-refine"],
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
