# Segmentation + Removal Pipeline (SAM 3 + LaMa)

Operational guide for Clean & Organize and Remove Objects — both run on the SAM 3 + LaMa unified pipeline.

## Topology

Two provider helpers in `src/lib/ai-providers/router.ts`:

- `callSegmentation` → Replicate SAM 3 (concept-prompt segmentation)
- `callRemoval`      → Replicate LaMa (mask-guided object removal)

Pipelines:

- **cleanOrganize** (`mode: "segment-remove"`)
  1. SAM 3 with a concept prompt (`"clutter"` or `"trash . empty bottles . dirty dishes"`) → mask PNG (Replicate delivery URL, short-lived).
  2. `persistGenerationImage` with `keyPrefix: "masks"` → permanent S3 URL.
  3. `segmentationMaskUrl` Firestore checkpoint written **before** the LaMa call (load-bearing for retry idempotency).
  4. LaMa with `image + mask` → final output.

- **removeObjects** (`mode: "remove-only"`)
  1. iOS renders brush strokes → binary PNG mask.
  2. Client uploads mask to S3 via Cognito direct upload.
  3. Controller validates `maskUrl` against `validateClientUploadHost` (S3 + CloudFront allowlist).
  4. LaMa with `image + mask` → final output.

Mask-persist is the idempotency boundary for cleanOrganize: a Cloud Tasks retry that finds `doc.segmentationMaskUrl` set skips SAM 3 and jumps straight to LaMa. `recordAiResult` remains the final AI-stage checkpoint.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `REPLICATE_SEGMENTATION_MODEL` | `mattsays/sam3-image` | SAM 3. Input `image + prompt + mask_only + return_zip`, output single mask URI. **Do not omit `mask_only: true` or `return_zip: false`** — defaults return an overlay PNG and a ZIP archive respectively, both incompatible with our LaMa stage. |
| `REPLICATE_REMOVAL_MODEL` | `allenhooo/lama` | LaMa. Input `image + mask` (both required), output single image URI. No prompt. |

Boot-time role verification (`src/lib/env.ts`) exits on role mismatch. Unknown slugs warn-only and allow boot.

**Removed:** `REPLICATE_INPAINT_MODEL` (FLUX Fill) no longer exists — FLUX Fill was retired in plan 003. If the env var is set, it is silently ignored.

## Observability

Structured log events:

- `segment.mask_detected` — SAM 3 returned a mask. Fields: `generationId`, `textPrompt`, `durationMs`.
- `provider.replicate.empty_mask` — SAM 3 returned 0 regions. Fields: `model`, `textPrompt`, `outputShape`. Translated into a terminal `VALIDATION_FAILED` generation with message "Segmentation returned no clutter matches for this image".
- `segment_remove.mask_reused` — retry path reused a persisted mask; SAM skipped.
- `remove.completed` — LaMa succeeded. Fields: `durationMs`.
- `processor.ai.no_mask_detected` — wrapping of the empty-mask case into a terminal generation state.
- `processor.ai.ok` — canonical AI-stage success with `mode` field (`segment-remove` / `remove-only` / `edit`).
- `provider.replicate.role_mismatch` — env slug registered with wrong role in PROVIDER_CAPABILITIES. Proceeds but warns; fix config.

Alerts (staging first):

1. **`segment.empty_rate`** — fraction of cleanOrganize generations terminating with `processor.ai.no_mask_detected`. Target < 5%; > 10% indicates concept prompt drift or a SAM 3 output-shape change that extractMaskUrl missed.
2. **pipeline p95 latency** — `processor.ai.ok` `durationMs` for `mode=segment-remove`. Expect 4-12s on LaMa + SAM 3. > 20s p95 is breaker-worthy.
3. **removal error bursts** — cluster on `provider.replicate.empty_response` with `model=allenhooo/lama`. Typically Replicate deployment issue or fork schema drift.

Legacy alerts to remove (plan 003 dashboard migration):

- `inpaint.completed` — replaced by `remove.completed`.

## S3 lifecycle

Masks at `s3://$AWS_S3_BUCKET/masks/{userId}/{generationId}.png`.

Recommended lifecycle rule (bucket-level):

- Prefix: `masks/`
- Transition: expire objects at 90 days

**IAM requirement:** the Cognito unauthenticated role's policy must allow `s3:PutObject` on `arn:aws:s3:::<bucket>/masks/*`. If previously scoped to `generations/*` only, extend the policy before rolling out — do NOT broaden to `*`.

## Staging validation protocol

Run before every production rollout that changes SAM 3 concept prompts, model slugs, or mask-related logic.

### Clean & Organize validation

1. Collect 20-30 "dağınık oda" photos (living / bedroom / kitchen mix; varied lighting).
2. For each photo, submit via staging `/api/design/clean-organize` with `declutterLevel: full` and `light`.
3. For each result, record:
   - Did the mask include any furniture or decor? (target: false-positive < 5%)
   - Did the mask miss visible clutter? (target: recall > 70%)
   - Was the mask empty (`NoMaskDetectedError`)? (target: < 10% of submissions)
4. If targets missed, adjust concept prompt in `src/lib/prompts/tools/clean-organize.ts` and re-run a subset.
5. Record validation outcome in this runbook under the following heading with the commit SHA:

```
### Taxonomy validated YYYY-MM-DD (commit <sha>)
- Level full: recall X%, furniture FP Y%, empty-mask Z% across N photos
- Level light: recall X%, furniture FP Y%, empty-mask Z% across N photos
- Concept prompts tested: ...
```

### Remove Objects validation

1. Collect 10 photos with clearly removable objects (lamp, pillow, poster, small furniture).
2. For each, brush the object tightly on iOS staging build.
3. For each result, record:
   - Is the object fully removed?
   - Are there residual shadows, halos, or color contamination at the mask edge?
   - Did LaMa extend the surrounding surface plausibly (floor texture continues, wall color matches)?
4. If quality fails, try the alternative LaMa fork via env swap (`REPLICATE_REMOVAL_MODEL=twn39/lama`).

## Rollback

This pipeline was introduced by plan 003 as a wholesale replacement of plan 001's Grounded-SAM 2 + FLUX Fill pipeline. Rollback is a code revert of the plan 003 PR:

1. Revert the plan 003 PR. The registry returns to `mode: "segment-inpaint"` / `"inpaint-only"`, the Grounded-SAM 2 and FLUX Fill capability entries come back, and `REPLICATE_INPAINT_MODEL` reappears.
2. Set `REPLICATE_SEGMENTATION_MODEL=adityaarun1/grounded-sam-2` and `REPLICATE_INPAINT_MODEL=black-forest-labs/flux-fill-pro` in the deployment env if they were not pinned.
3. Redeploy. iOS is unaffected — the request/response contract is unchanged.

No feature flag exists. Staging is the gate.

## Known failure modes

- **SAM 3 concept prompt returns no mask on an obviously-cluttered room.** Try a broader prompt (replace `"clutter"` with `"clutter . mess . loose items"`). SAM 3 is concept-driven; the noun phrase matters. Rerun validation protocol before shipping.
- **LaMa output shows residual silhouette.** Likely a mask that didn't cover the object's shadow; widen the brush or dilate the mask (server-side dilation is Level 3 scope — not in this version).
- **Replicate fork schema mismatch.** SAM 3 or LaMa community fork changes input field names. First staging 400 reveals it; adjust `callSegmentationReplicate` / `callRemovalReplicate` in `src/lib/ai-providers/replicate.ts`.
- **Mask dimension mismatch (Remove Objects).** iOS renders mask at `image.size * scale`; if the server-side resize of the image happens elsewhere, LaMa may silently produce shifted output. Dimension validation is Level 2 scope.

## Links

- Plan: `docs/plans/2026-04-19-003-refactor-sam3-lama-unified-pipeline-plan.md`
- Superseded plans:
  - `docs/plans/2026-04-19-001-feat-segmentation-inpainting-pipeline-plan.md`
  - `docs/plans/2026-04-19-002-refactor-lama-remove-taxonomy-tighten-plan.md`
- Brainstorm origin: `docs/brainstorms/2026-04-19-001-clutter-removal-best-practices-requirements.md`
- Provider adapter: `src/lib/ai-providers/replicate.ts`
- Pipeline helper: `src/lib/generation/segment-remove.ts`
- Clean & Organize builder: `src/lib/prompts/tools/clean-organize.ts`
- Remove Objects builder: `src/lib/prompts/tools/remove-objects.ts`
- External:
  - [SAM 3 (Meta, Nov 2025)](https://ai.meta.com/research/sam3/)
  - [SAM 3 paper](https://arxiv.org/abs/2511.16719)
  - [Replicate mattsays/sam3-image](https://replicate.com/mattsays/sam3-image)
  - [LaMa (WACV 2022)](https://github.com/advimman/lama)
  - [Replicate allenhooo/lama](https://www.aimodels.fyi/models/replicate/lama-allenhooo)
  - [Sanster/IOPaint](https://github.com/Sanster/IOPaint)
