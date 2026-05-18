import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { envSchema } from "./env.js";

// Minimal fixture that satisfies the required env vars in
// `envSchema`. Tests below extend this and assert on optional /
// defaulted fields. Keep this in sync with new required vars added
// to env.ts — the test runner will fail loud with a Zod error if a
// required field is missing.
function minimalEnv(): Record<string, string> {
  return {
    PORT: "3000",
    REPLICATE_API_TOKEN: "test",
    FAL_AI_API_KEY: "test",
    FIREBASE_SERVICE_ACCOUNT_KEY: Buffer.from(
      JSON.stringify({
        project_id: "t",
        private_key: "k",
        client_email: "e",
      }),
    ).toString("base64"),
    AWS_S3_BUCKET: "bucket",
    AWS_S3_REGION: "us-east-1",
    AWS_COGNITO_IDENTITY_POOL_ID: "us-east-1:00000000-0000-0000-0000-000000000000",
    AWS_CLOUDFRONT_HOST: "cdn.test.local",
  };
}

describe("envSchema — REPLICATE_INPAINT_MODEL default", () => {
  it("defaults to flux-fill-dev when the env var is absent", () => {
    // v7.0 default — flux-fill-dev with REPLACE_GUIDANCE=75 /
    // ADD_GUIDANCE=70 in replace-add-object.ts. The v2.0 mode-aware
    // builder ships per-mode guidance overrides above Dev's native
    // ~60 default. If the default ever silently flips to Pro again,
    // those Dev-scale guidance values would send ~2.5x the recommended
    // value into Pro's native ~30 scale, over-saturating the prompt
    // anchor.
    const result = envSchema.parse(minimalEnv());
    assert.equal(result.REPLICATE_INPAINT_MODEL, "black-forest-labs/flux-fill-dev");
  });

  it("respects an explicit override to flux-fill-pro", () => {
    // Confirms the override path used by the operator-documented
    // rollback recipe (lower guidance constants in replace-add-object.ts
    // AND set this env var to flux-fill-pro).
    const result = envSchema.parse({
      ...minimalEnv(),
      REPLICATE_INPAINT_MODEL: "black-forest-labs/flux-fill-pro",
    });
    assert.equal(result.REPLICATE_INPAINT_MODEL, "black-forest-labs/flux-fill-pro");
  });

  it("rejects malformed model slugs", () => {
    // The regex requires owner/name shape. A typo or missing slash
    // should fail-fast at boot rather than producing a cryptic
    // 404 from Replicate at the first request.
    const result = envSchema.safeParse({
      ...minimalEnv(),
      REPLICATE_INPAINT_MODEL: "not-a-valid-slug",
    });
    assert.equal(result.success, false);
  });
});
