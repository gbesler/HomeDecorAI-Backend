# Remove Objects — Backend Normalization Validation (Phase B)

Companion to plan
`docs/plans/2026-04-22-001-fix-remove-objects-vertical-normalization-plan.md`.
Run these checks after deploying Phase B — they verify the normalizer
is live, the passthrough short-circuit works, and the circuit breaker
no longer opens on shape-mismatch failures.

## Prerequisites

- Access to the Render logs dashboard for
  `srv-d7bohp75r7bs73dsb1a0-hibernate` (`homedecor-ai-backend`).
- An iOS build that predates Phase A (so it still uploads mismatched
  dims), OR a manually-crafted request with a mismatched image/mask pair.
- `curl` / `aws s3` for S3 spot checks.

## Scenario 1 — Replay the bug (vertical photo, pre-Phase-A client)

Establishes that the normalizer actually fixes the production failure.

1. On a shipped-build iPhone, trigger a Remove Objects job on a portrait
   48 MP photo (the exact failure signature — image 4608×6144, mask
   3024×4032).
2. Watch logs filtered by the generationId:
   - `event=remove.normalize.done`, `action=normalized`, `before.image`
     ≠ `before.mask`, `after.image == after.mask`, `after.image.width <=
     2048` (same for height).
   - `event=remove.normalize.mismatch` present (warn) — this is the
     signal to Phase A ops that there are still pre-Phase-A clients in
     the wild.
   - `event=remove.completed` (not `provider.replicate.empty_response`).
3. S3 spot check under the `normalized/` prefix:
   ```
   aws s3 ls s3://<bucket>/normalized/<userId>/<generationId>-image.jpg
   aws s3 ls s3://<bucket>/normalized/<userId>/<generationId>-mask.png
   ```
   Both should exist, both should have matching dims. Verify via any
   image-metadata tool — `sips -g pixelWidth -g pixelHeight` (macOS),
   `identify -format '%wx%h'` (ImageMagick, portable), or
   `python -c 'from PIL import Image, sys; print(Image.open(sys.argv[1]).size)'`.

## Scenario 2 — Passthrough short-circuit

Verifies Phase A uploads (or any already-well-formed pair) skip the
fetch+resize+upload round-trip.

1. Trigger a Remove Objects job from a Phase A iOS build (image and mask
   both 2048-capped, matched dims).
2. Logs:
   - `event=remove.normalize.done`, `action=passthrough`.
   - No `remove.normalize.mismatch` warn.
   - No S3 writes under `normalized/` for that generationId.
3. Timing: `remove.normalize.done.durationMs` should be ≤ ~1500 ms
   (two parallel fetches + two sharp metadata reads, no PUTs).

## Scenario 3 — Near-cap boundary

1. Upload an image exactly 2048×1536 with a matched mask.
2. Expected: `action=passthrough`. Triggering a resize at the boundary
   would be a bug (unnecessary S3 write).

## Scenario 4 — Breaker health during rollout

Watch over 24 h post-deploy:

1. Search logs for `CircuitBreaker:design` transitions.
2. Expected: no `CLOSED -> OPEN` transitions traceable to `removeObjects`
   failures.
3. If one does occur, check the cooccurring `provider.replicate.empty_response`
   — with Unit 4's log enrichment, `normalizedDims` tells you whether the
   failure was a shape mismatch (should never happen now) or something
   else (new failure mode — investigate).

## Scenario 5 — Log diagnosability (synthetic empty response)

In staging only:

1. Point `REPLICATE_REMOVAL_MODEL` env var to a deliberately-broken slug
   (e.g. a non-existent model).
2. Trigger a Remove Objects job.
3. Confirm the resulting `provider.replicate.empty_response` warn log
   carries `normalizedDims: { width, height }` (or `null` if the normalize
   step itself failed upstream of the call).
4. Revert the env var.

## Failure triage

| Symptom | First check |
|---|---|
| Every job hits `action=normalized`, none `passthrough` | iOS Phase A isn't live yet. Expected during the pre-Phase-A rollout window. Watch `remove.normalize.mismatch` trend to zero as Phase A adoption rises. |
| `persistGenerationBuffer` errors spike | S3 credentials / IAM scope for the new `normalized/` prefix. Infra must grant the Cognito role `s3:PutObject` on `normalized/*` (mirrors the `generations/*` + `masks/*` policies). |
| `normalize.done.durationMs` consistently > 5 s | Check image sizes upstream. Likely a pre-Phase-A client is uploading a 10+ MB HEIC that's hitting the `MAX_DOWNLOAD_BYTES` edge. |
| Sharp crash on install / load | Render runtime glibc mismatch. `sharp@0.33` ships Linux x64 glibc prebuilds; verify the deploy image uses glibc (not musl/Alpine). |

## Infra follow-up (outside this repo)

- Add an S3 lifecycle rule expiring the `normalized/` prefix on a short
  cadence (suggest 7 days — matches the retention posture for the
  existing `masks/` prefix). Without this, normalized scratch artifacts
  accumulate indefinitely.

## Sign-off

Check off in the PR body before declaring Phase B fully shipped:

- [ ] Scenario 1 — replay the bug
- [ ] Scenario 2 — passthrough short-circuit
- [ ] Scenario 3 — near-cap boundary
- [ ] Scenario 4 — breaker health (24 h window)
- [ ] Scenario 5 — log diagnosability
- [ ] Infra follow-up filed (S3 lifecycle for `normalized/` prefix)
