---
title: "feat: Replace & Add Object — prompt-driven inpainting pipeline"
type: feat
status: proposed
date: 2026-04-19
origin: iOS Replace & Add Object wizard (existing client; backend endpoint missing)
related:
  - docs/plans/2026-04-19-003-refactor-sam3-lama-unified-pipeline-plan.md
  - docs/runbooks/segment-remove-pipeline.md
---

# Replace & Add Object — Prompt-Driven Inpainting Pipeline

## Context

iOS ships a 3-step wizard (photo → brush mask → inspiration pick from a 40×20
category/item library). The client already uploads `imageUrl` and `maskUrl`
to S3 via `ImageUploadService` and calls
`POST /api/design/replace-add-object` with
`{ imageUrl, maskUrl, prompt, categoryId, inspirationId, language }`.
Backend endpoint does not exist. This plan adds it.

LaMa (the inpainter used by Clean & Organize and Remove Objects) fills
surfaces; it ignores prompts and cannot synthesize *new* content in a
masked region. Replace & Add Object needs prompt-driven inpainting
(image + mask + prompt → new content), which is a different model family.
Default: **Flux Fill (Dev tier)** on Replicate, env-configurable.

Plan 003 retired the old `REPLICATE_INPAINT_MODEL` env var when FLUX Fill
was removed from the Clean & Organize path. We are re-introducing the
same env name for a different tool with clear single-caller semantics;
see Risks for the conflict-avoidance note.

## Goal

Ship `/api/design/replace-add-object` so the existing iOS wizard works
end-to-end. New pipeline mode `inpaint-with-prompt` sits alongside
`edit`, `segment-remove`, `remove-only`. No changes to those three.

## Non-goals

- SAM2/SAM3 refinement of the client mask. The user paints the mask
  themselves; good enough for v1.
- fal.ai fallback for the inpainter. Replicate-only, matching `callRemoval`.
- Multi-reference image input (e.g. "use this sofa photo as a visual
  reference"). Single prompt string only.
- Prompt engineering beyond pass-through. The iOS library's per-item
  prompt string is authored content; builder forwards verbatim.
- iOS changes. Contract is fixed and already shipped.

## Design

### Pipeline shape

```
iOS: image + mask + inspiration.prompt
             │
             ▼
    POST /api/design/replace-add-object
             │  (validate body, allowlist imageUrl+maskUrl hosts,
             │   write GenerationDoc, enqueue Cloud Tasks)
             ▼
   generation-processor (mode = "inpaint-with-prompt")
             │
             ▼
      runPromptInpaint(imageUrl, maskUrl, prompt)
             │
             ▼
      callInpaint → callReplicateInpaint (Flux Fill)
             │
             ▼
      persistGenerationImage → S3
             │
             ▼
      recordStorageResult + FCM (identical to every other tool)
```

Same four stages as every other tool (`claimProcessing` → AI → S3 → FCM).
Only the AI stage is new: a single Replicate call with
`image + mask + prompt`. No segmentation. No checkpoint-before-LaMa
dance (there is nothing cheap-to-reuse between stages).

### Mode union addition

`ToolTypeConfig.mode` grows a fourth variant:

```ts
mode?: "edit" | "segment-remove" | "remove-only" | "inpaint-with-prompt";
```

Processor gets a fourth branch. `segment-remove` and `remove-only`
branches are untouched.

### Model choice: Flux Fill (Dev)

- Replicate: `black-forest-labs/flux-fill-dev`. Takes `image`, `mask`,
  `prompt`, `guidance` (default 30 per model card), plus `num_inference_steps`.
  Mask convention matches ours (white = fill region).
- Pro variant (`black-forest-labs/flux-fill-pro`) is a drop-in schema
  swap — same fields. Higher quality, ~5× cost. Env-configurable.
- No fal.ai fallback. If Replicate is down, the tool fails. Parallels
  `callRemoval`/`callSegmentation`, which are also Replicate-only.

### Security posture

Both `imageUrl` and `maskUrl` are in `clientUploadFields` — same
host-allowlist SSRF guard as Remove Objects. Raw `prompt` is NOT forwarded
to Replicate verbatim without length cap (500 chars, matching the
inspiration library's longer phrases). `categoryId` and `inspirationId`
are validated as short alphanumeric-dash slugs; they never reach the
provider, they only live in `toolParams` for analytics.

## File changes

### New files

- **`src/lib/prompts/tools/replace-add-object.ts`**
  Trivial builder. Inputs `{ imageUrl, maskUrl, prompt, categoryId,
  inspirationId, language? }`. Returns a `PromptResult` with
  `prompt = params.prompt` (verbatim; no enrichment — see "Prompt
  builder contract" below for rationale), `positiveAvoidance: ""`,
  `guidanceScale: <see open questions>`, `actionMode: "transform"`,
  `guidanceBand: "faithful"`, `promptVersion: "replaceAddObject/v1.0-fluxfill"`.

- **`src/lib/generation/prompt-inpaint.ts`**
  Stage helper paralleling `src/lib/generation/segment-remove.ts`.
  Exports `runPromptInpaint({ imageUrl, maskUrl, prompt })` →
  `{ outputImageUrl, provider, durationMs }`. Wraps `callInpaint`,
  logs `inpaint.started` / `inpaint.completed` / `inpaint.failed`.
  No S3 persist inside this file — the processor does S3 persist at
  step 3, identical to `edit` mode. (Contrast: segment-remove persists
  the mask mid-flow for idempotency; there is nothing analogous here.)

- **`docs/runbooks/replace-add-object-pipeline.md`**
  Ops runbook paralleling `segment-remove-pipeline.md`. Topology, env
  vars, observability, alerts, rollback. See "Rollback" below.

### Modified files

- **`src/lib/ai-providers/types.ts`**
  Add `InpaintInput { imageUrl; maskUrl; prompt; guidanceScale? }`
  and `InpaintOutput { imageUrl; provider; durationMs }`. Do not
  reuse `GenerationInput`: mask is first-class and prompt is never
  absent, so a dedicated type keeps the adapter honest.

- **`src/lib/ai-providers/replicate.ts`**
  Add `callReplicateInpaint(model, input: InpaintInput): Promise<InpaintOutput>`.
  Schema for Flux Fill Dev: `{ image, mask, prompt, guidance, num_inference_steps }`.
  Extract URL with the existing `extractImageUrl` helper. Role-mismatch
  warn matches the segmentation/removal pattern (capability = `"inpaint"`).

- **`src/lib/ai-providers/capabilities.ts`**
  Add `"inpaint"` back to the `ModelRole` union (plan 003 removed it;
  we need it again). Register `black-forest-labs/flux-fill-dev` (and
  `flux-fill-pro`) with `role: "inpaint"`, `supportsGuidanceScale: true`,
  `maxPromptTokens: 512`.

- **`src/lib/ai-providers/router.ts`**
  Add `callInpaint(input: InpaintInput): Promise<InpaintOutput>`.
  Replicate-only (matches `callRemoval`). Reads slug from
  `env.REPLICATE_INPAINT_MODEL`. `withRetry({ maxRetries: 1 })`.
  `designCircuitBreaker.record` on success/failure. No fal.ai fallback.

- **`src/lib/ai-providers/index.ts`**
  Export `callInpaint`, `InpaintInput`, `InpaintOutput`.

- **`src/lib/env.ts`**
  Re-introduce `REPLICATE_INPAINT_MODEL` (zod optional with default
  `"black-forest-labs/flux-fill-dev"`). Startup role verification
  adds a third entry: `["REPLICATE_INPAINT_MODEL", env.REPLICATE_INPAINT_MODEL, "inpaint"]`.
  Runbook note: plan 003 removed this name. Re-adding does not conflict
  because (a) the old usage was for FLUX Fill in the now-retired
  Clean & Organize inpaint step; (b) new callers route exclusively
  through `callInpaint` for Replace & Add Object.

- **`src/schemas/generated/api.ts`**
  Add `CreateReplaceAddObjectBody` (hand-edited, NOT orval-produced;
  mirrors `CreateRemoveObjectsBody` style):
  ```ts
  export const CreateReplaceAddObjectBody = zod.object({
    imageUrl: zod.string().url().describe("Room photo URL"),
    maskUrl:  zod.string().url().describe("Binary mask PNG URL (white = replace)"),
    prompt:   zod.string().min(1).max(500)
              .describe("Inspiration prompt describing what to place in the masked region"),
    categoryId:    zod.string().min(1).max(64).regex(/^[a-z0-9-]+$/i),
    inspirationId: zod.string().min(1).max(64).regex(/^[a-z0-9-]+$/i),
    language: zod.enum(["tr", "en"]).optional(),
  });
  ```
  Prompt cap is 500 (not 200 like Remove Objects) because inspiration
  prompts are longer phrases ("A modern velvet sofa — Sofas.") and the
  library may grow. 500 is still comfortably under any model limit.

- **`src/lib/tool-types.ts`**
  Add `replaceAddObject` registry entry:
  ```ts
  replaceAddObject: {
    toolKey: "replaceAddObject",
    routePath: "/replace-add-object",
    rateLimitKey: "replaceAddObject",
    mode: "inpaint-with-prompt",
    models: { replicate: "prunaai/p-image-edit", falai: "fal-ai/flux-2/klein/9b/edit" }, // dead weight, kept for rollback symmetry
    bodySchema: CreateReplaceAddObjectBody,
    bodyJsonSchema: replaceAddObjectBodyJsonSchema,
    summary: "Enqueue a replace-&-add-object generation",
    description: "...",
    buildPrompt: buildReplaceAddObjectPrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreateReplaceAddObjectBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
    optionalImageUrlFields: ["maskUrl"] as const,
    clientUploadFields: ["imageUrl", "maskUrl"] as const,
  } satisfies ToolTypeConfig<z.infer<typeof CreateReplaceAddObjectBody>, PromptResult>,
  ```
  Also add `replaceAddObjectBodyJsonSchema` constant for Swagger
  (mirrors `removeObjectsBodyJsonSchema`, plus `prompt` required and
  `categoryId`/`inspirationId` required strings).
  Extend `ToolTypeConfig.mode` union with `"inpaint-with-prompt"`.

- **`src/services/generation-processor.ts`**
  Add a fourth branch in `runAiGeneration` after the `remove-only`
  branch. Pseudo-code:
  ```ts
  } else if (mode === "inpaint-with-prompt") {
    const maskUrl = params["maskUrl"];
    if (typeof maskUrl !== "string" || maskUrl.length === 0) {
      return { kind: "failed", code: "VALIDATION_FAILED",
        message: `Tool ${toolType} is mode=inpaint-with-prompt but toolParams.maskUrl is missing` };
    }
    if (!promptResult.prompt) {
      return { kind: "failed", code: "VALIDATION_FAILED",
        message: `Tool ${toolType} is mode=inpaint-with-prompt but buildPrompt returned empty prompt` };
    }
    const result = await runPromptInpaint({
      imageUrl: inputImageUrl,
      maskUrl,
      prompt: promptResult.prompt,
      guidanceScale: promptResult.guidanceScale,
    });
    tempOutputUrl = result.outputImageUrl;
    provider = result.provider;
    durationMs = result.durationMs;
  }
  ```
  The outer try/catch already maps `StorageUploadError` /
  `CognitoCredentialMintError` / generic Error to the right terminal
  states; no new error classes needed (Flux Fill success returns a URL;
  empty-response path reuses the `Replicate returned no images` pattern
  and falls into the generic `AI_PROVIDER_FAILED` branch).

- **`src/config/rate-limits.ts`**
  Add `replaceAddObject: { minuteLimit: 5, hourlyLimit: 30, dailyLimit: 100 }`.
  Same envelope as every other tool pending telemetry. Note: Flux Fill
  Dev ~$0.04/run, Pro ~$0.20/run — if Pro becomes default, tighten
  dailyLimit to 50.

- **`src/routes/design.ts`** (verified: routes are registered via
  `TOOL_TYPES` iteration in this file, so **no per-tool edit is needed**
  here; the new registry entry is picked up automatically. The controller
  factory also already handles `clientUploadFields` allowlisting.)

### Schema shape detail

`CreateReplaceAddObjectBody`:

| field | type | constraint | rationale |
|---|---|---|---|
| `imageUrl` | string (URL) | `zod.string().url()`; `validateClientUploadHost` | SSRF guard same as Remove Objects |
| `maskUrl` | string (URL) | `zod.string().url()`; `validateClientUploadHost` | binary PNG from iOS |
| `prompt` | string | `min(1).max(500)` | inspiration prompts are longer than Remove Objects captions |
| `categoryId` | string | `min(1).max(64)`, `/^[a-z0-9-]+$/i` | analytics key; never reaches provider |
| `inspirationId` | string | `min(1).max(64)`, `/^[a-z0-9-]+$/i` | analytics key |
| `language` | `"tr"\|"en"?` | enum | FCM locale, per existing convention |

## Prompt builder contract

**Recommendation: pass-through.** `buildReplaceAddObjectPrompt` returns
`promptResult.prompt = params.prompt` verbatim. Rationale:

1. Inspiration prompts are authored content curated by product.
   Appending quality modifiers ("high detail, photorealistic, 4k,
   studio lighting") is the model provider's job (Flux Fill's training
   already biases toward that output) and a second author's fingerprint
   in the chain degrades consistency across the 800-item library.
2. If product wants global modifiers later, add a single
   `REPLACE_ADD_OBJECT_PROMPT_SUFFIX` env var and append once in the
   builder. Cheap to add, expensive to un-add.
3. `promptVersion` lives in the `PromptResult`; bumping it when we
   change pass-through to enrichment preserves analytics continuity.

Escalation point: this is the default. Revisit after first 50 staging
generations if quality is visibly worse than a hand-prompted baseline.

## Firestore doc shape

Reuses `GenerationDoc` with `toolType = "replaceAddObject"`. The
`toolParams` blob holds the full body: `imageUrl`, `maskUrl`, `prompt`,
`categoryId`, `inspirationId`, `language?`. `categoryId` and
`inspirationId` live inside `toolParams` (not top-level columns) —
this matches the "top-level = shared across tools; toolParams = tool-specific"
convention that plan 003 finalized. Analytics queries project
`toolParams.categoryId` / `toolParams.inspirationId`.

`segmentationMaskUrl` is NOT written (no SAM stage). `inputImageUrl`
is `imageUrl` per `imageUrlFields: ["imageUrl"]`.

## Logging

Following the event-naming style of `segment.mask_detected` /
`remove.completed`:

- `inpaint.started` — fields: `generationId`, `promptPreview` (first
  40 chars), `categoryId`, `inspirationId`.
- `inpaint.completed` — fields: `generationId`, `durationMs`, `model`.
- `inpaint.failed` — fields: `generationId`, `error`, `durationMs`
  (only on thrown errors inside `runPromptInpaint`; provider-level
  retries log via `provider.retry` from the router).

`processor.ai.ok` gets a new `mode: "inpaint-with-prompt"` value
automatically (it already logs `mode`).

Alert candidate (staging): `inpaint.empty_rate` — fraction of
replaceAddObject generations terminating with the generic
`provider.replicate.empty_response` for the Flux Fill slug. Target < 5%.

## Sequencing

Strictly sequential across layers, parallel-safe within a layer:

1. **Types + env** (parallel):
   - `src/lib/ai-providers/types.ts` (add `InpaintInput/Output`)
   - `src/lib/ai-providers/capabilities.ts` (add role, register slugs)
   - `src/lib/env.ts` (re-add `REPLICATE_INPAINT_MODEL` + role verification)
2. **Schema**: `src/schemas/generated/api.ts` (add `CreateReplaceAddObjectBody`).
3. **Provider adapter + router** (sequential: router imports adapter):
   - `src/lib/ai-providers/replicate.ts` (add `callReplicateInpaint`)
   - `src/lib/ai-providers/router.ts` (add `callInpaint`)
   - `src/lib/ai-providers/index.ts` (export)
4. **Pipeline stage + prompt builder** (parallel):
   - `src/lib/generation/prompt-inpaint.ts`
   - `src/lib/prompts/tools/replace-add-object.ts`
5. **Registry wire-up**:
   - `src/lib/tool-types.ts` (mode union, registry entry, JSON schema)
   - `src/services/generation-processor.ts` (fourth branch)
   - `src/config/rate-limits.ts`
6. **Docs**: `docs/runbooks/replace-add-object-pipeline.md`.

Backend compiles after every step if done in order: the processor
branch references exports that all pre-exist at step 5.

## Testing

### Unit

- `buildReplaceAddObjectPrompt` pass-through:
  `buildReplaceAddObjectPrompt({ prompt: "A modern velvet sofa — Sofas.", ... })`
  → `result.prompt === "A modern velvet sofa — Sofas."`.
- `buildReplaceAddObjectPrompt` promptVersion stable.
- `CreateReplaceAddObjectBody.parse` rejects `prompt=""`, `prompt.length>500`,
  `categoryId` with spaces, `imageUrl` without scheme.
- `callInpaint` mocked Replicate happy path → `InpaintOutput.imageUrl`.
- `callInpaint` mocked 5xx → retry once → circuit-breaker record false.
- Processor `inpaint-with-prompt` branch with missing `maskUrl` →
  `VALIDATION_FAILED`.
- Processor branch with empty `promptResult.prompt` → `VALIDATION_FAILED`.

### Manual integration (staging)

1. iOS submit with valid image + mask + inspiration.prompt → 202 with
   `generationId`.
2. Firestore doc observed: `status: queued` → `processing` → `completed`.
3. Output image: masked region replaced with something matching the
   prompt; rest of the room pixel-identical.
4. SSRF guard: submit `maskUrl = "https://evil.example/foo.png"` →
   400 before enqueue.
5. Rate limit: 6th submission within a minute → 429 with `retryAfterMs`.
6. Retry idempotency: Cloud Tasks duplicate delivery → Flux Fill called
   at most once (AI checkpoint).
7. Flux Fill timeout → `AI_PROVIDER_FAILED` terminal state + FCM failure push.
8. Flip env var to `flux-fill-pro` → same flow, visibly higher quality
   output, no code change.

## Risks

| Risk | Mitigation |
|---|---|
| Flux Fill Dev quality below product bar | Env flip to `flux-fill-pro`. No code change. Staging QA before prod. |
| Replicate deprecates Flux Fill model slug | Pin slug version in env; community forks (`fofr/flux-fill`) as rollback target. |
| Prompt cap 500 too low for future library growth | Cap lives in one zod schema + one JSON schema. 2-line bump. |
| `REPLICATE_INPAINT_MODEL` name collision with plan 003's removed var | Plan 003 removed the var entirely; no live caller remains. Runbook notes the re-introduction so ops reading old deploy logs don't confuse contexts. |
| Mask convention mismatch (Flux Fill expects opposite colors) | Flux Fill model card: white = replace region, matches our convention. Staging smoke test validates. |
| SSRF via CDN-fronted S3 bucket with open redirects | `validateClientUploadHost` is the same guard Remove Objects uses; no new surface. |
| Cost: Flux Fill Pro is ~5× Dev | Rate limits capped per-user. If Pro becomes default, halve `dailyLimit` to 50. |

## Rollout

1. Ship to staging behind existing auth. No feature flag — the endpoint
   is net-new; not shipping means iOS keeps getting 404 (as today).
2. 5 manual test cases per category archetype (sofa, rug, art, lighting,
   plant — 5 of 40 categories) across 10 rooms.
3. If quality acceptable, ship to prod.
4. Monitor for 48 hours: `inpaint.completed` p95 latency, provider
   error rate, `inpaint.empty_rate`.

## Rollback

Three layers, in increasing severity:

1. **Quality tune**: flip `REPLICATE_INPAINT_MODEL` from Dev to Pro
   (or to a community fork like `fofr/flux-fill`). No deploy needed if
   env is runtime-managed.
2. **Disable tool**: remove the `replaceAddObject` entry from
   `TOOL_TYPES` and redeploy. The controller factory loop stops
   registering the route. iOS gets 404; product hides the feature in
   next release. No data loss for in-flight generations (they terminate
   via existing retry-exhaustion path).
3. **Full revert**: revert the PR. Env var, capability entry, and all
   new files come out in one commit.

## Open questions

- **Flux Fill Dev vs Pro as default.** Dev is cheaper and adequate per
  model card samples; Pro is visibly higher quality per public
  comparisons. User decision: start with Dev, promote to Pro if
  staging QA flags quality. (Current plan: Dev default.)
- **Guidance scale starting value.** Flux Fill model card default is
  30 on Pro, 60 on Dev (note: Flux Fill's "guidance" is on a different
  scale than standard CFG). Needs one staging sweep to lock.
- **Enrichment vs pass-through.** Default pass-through (see Prompt
  builder contract). Product sign-off before changing.
- **Quality modifier suffix env var.** Ship with or without
  `REPLACE_ADD_OBJECT_PROMPT_SUFFIX` scaffolding? Current plan: without.
  Adding is cheap.
- **`num_inference_steps` for Flux Fill.** Default 50 (model card) costs
  more; 28 is the common sweet spot. Tune in staging.

## Sources

- Related plan: `docs/plans/2026-04-19-003-refactor-sam3-lama-unified-pipeline-plan.md`
- Runbook target: `docs/runbooks/replace-add-object-pipeline.md` (new)
- Flux Fill: https://replicate.com/black-forest-labs/flux-fill-dev,
  https://replicate.com/black-forest-labs/flux-fill-pro
- Existing pattern references: `src/lib/generation/segment-remove.ts`,
  `src/services/generation-processor.ts`, `src/lib/tool-types.ts`.
