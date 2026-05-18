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
  it("defaults to flux-fill-pro when the env var is absent", () => {
    // Guards against an accidental revert of the env default flip
    // (commit 9071fbc). REPLICATE_INPAINT_MODEL must default to Pro
    // because `FLUX_FILL_GUIDANCE` in
    // src/lib/prompts/tools/replace-add-object.ts is calibrated for
    // Pro's BFL guidance scale (~30). A silent revert to Dev would
    // send Pro-scale guidance into Dev's native scale (~60),
    // under-anchoring the prompt and re-introducing the v1.3
    // silhouette-preservation failure.
    const result = envSchema.parse(minimalEnv());
    assert.equal(result.REPLICATE_INPAINT_MODEL, "black-forest-labs/flux-fill-pro");
  });

  it("respects an explicit override to flux-fill-dev", () => {
    // Confirms the override path used by the documented revert
    // recipe (raise guidance constants in replace-add-object.ts AND
    // set this env var to flux-fill-dev). If override resolution
    // ever silently drops the override, this test fails.
    const result = envSchema.parse({
      ...minimalEnv(),
      REPLICATE_INPAINT_MODEL: "black-forest-labs/flux-fill-dev",
    });
    assert.equal(result.REPLICATE_INPAINT_MODEL, "black-forest-labs/flux-fill-dev");
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
