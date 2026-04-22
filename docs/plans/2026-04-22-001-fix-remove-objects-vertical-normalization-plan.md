---
title: "fix: Remove Objects Backend Defensive Normalization (Phase B)"
type: fix
status: completed
date: 2026-04-22
origin: docs/brainstorms/2026-04-22-001-remove-objects-vertical-failure-requirements.md
---

# fix: Remove Objects Backend Defensive Normalization (Phase B)

## Overview

Add a backend normalization step in front of the LaMa call that guarantees
`image` and `mask` passed to Replicate have identical pixel dimensions and stay
within LaMa's practical size envelope. This unblocks vertical-photo Remove
Objects jobs from shipped iOS clients without waiting for the Phase A client
fix, and keeps the design circuit breaker from opening on a failure mode that
is actually a payload shape bug (see origin).

## Problem Frame

Remove Objects fails on portrait iPhone photos. The failing job
`5d8ffbf8-cc82-4f6f-be33-94f01e1f39d9` had `image=4608×6144` (28.3 MP,
full-res) and `mask=3024×4032` (12.2 MP, downscaled UIImage) — same aspect
ratio (3:4) but different pixel dimensions. LaMa
(`allenhooo/lama` on Replicate) requires image and mask to share pixel
dimensions; when they don't, the community model returns `null` instead of a
typed error. Our router then records a breaker failure and, on repeat, opens
the design circuit breaker — degrading unrelated tools (see origin: `docs/brainstorms/2026-04-22-001-remove-objects-vertical-failure-requirements.md`).

Today the pipeline forwards URLs straight through
(`src/lib/ai-providers/replicate.ts:256-259`) with no preprocessing.

## Requirements Trace

- **R1** — Remove Objects succeeds on vertical photos from the current shipped
  client (origin Goal 1).
- **R2** — LaMa's null-response failure mode no longer opens the design
  circuit breaker for shape mismatches (origin Goal 2).
- **R3** — Payload-shape mismatches are visible in logs before users report
  them (origin Goal 3).

## Scope Boundaries

- **In scope:** normalization helper, integration into the removal router,
  `sharp` dependency, log enrichment.
- **Out of scope (Phase A):** iOS client changes to unify image/mask pixel
  buffers — handled by a separate plan.
- **Out of scope (non-goals from origin):** replacing LaMa, adding a second
  removal provider, changing the mask brush UX, altering landscape behavior.
- **Out of scope here:** introducing a unit-test framework. The backend has
  no test runner today (see Open Questions / Risks); adding one is its own
  concern and would disproportionately balloon this fix.

## Context & Research

### Relevant Code and Patterns

- `src/lib/ai-providers/replicate.ts:237-284` — `callRemovalReplicate` (LaMa
  call site).
- `src/lib/ai-providers/router.ts:151-175` — `callRemoval` (retry + breaker
  envelope). Single retry (`maxRetries: 1`), explicit "no fal.ai fallback"
  comment.
- `src/lib/storage/s3-upload.ts:96-215` — `persistGenerationImage()` already
  implements: native `fetch`, SSRF guard via `isHostAllowed()`, 10 MB
  download cap, timeout, `PutObjectCommand`, dual-URL return (native S3 +
  CloudFront). Accepts a `keyPrefix` option — the `"masks"` prefix is the
  existing convention for intermediate/short-TTL artifacts
  (`src/lib/generation/segment-remove.ts:89`).
- `src/lib/circuit-breaker.ts:41-184` + `src/lib/ai-providers/router.ts:28` —
  breaker opens at >30% error rate; probe-based recovery (30 s cooldown).
- `src/lib/logger.ts` — pino v9, structured-first (`logger.warn({event, …},
  "msg")`).
- `src/lib/generation/segment-remove.ts:113-133` — `runRemoval` wraps
  `callRemoval`. Good integration seam if we don't want to push fetch/resize
  into the lowest-level `callRemovalReplicate` (see Key Technical Decisions).

### Institutional Learnings

- `docs/plans/2026-04-19-003-refactor-sam3-lama-unified-pipeline-plan.md` —
  prior unification work; no existing normalization handling.
- None of the solutions in `docs/solutions/` directly cover image/mask
  dimension normalization (searched; no hit).

### External References

- LaMa model card on Replicate (`allenhooo/lama`) — image + mask inputs,
  binary mask (white=remove). No documented max dimensions, but community
  reports and inpainting-model norms cluster around **2048 long-side** for
  stable runs on consumer-tier GPUs; above that, OOM / silent-null is a known
  failure mode.
- LaMa paper (`advimman/lama`) — pads internally to multiples of 8. We
  don't need to replicate that; Replicate's wrapper handles it — we only
  need matched shape between image and mask.

## Key Technical Decisions

- **Integration point: `runRemoval` (not `callRemovalReplicate`).** Normalize
  in `src/lib/generation/segment-remove.ts` before calling `callRemoval`.
  Keeps provider-level code unaware of normalization policy; keeps
  `callRemovalReplicate` as a thin schema-adapter that matches the style of
  the other provider functions in that file.
- **Resize always; don't reject.** Origin open-question #3 resolved: resizing
  is simpler, covers both the Phase B defensive case and truly-mismatched
  uploads, and the FailedGenerationDetail retry UX still handles genuinely
  corrupt inputs. Rejecting on shape-only signal would surface confusing
  errors for cases we can fix server-side for free.
- **Long-side cap: 2048 px.** Origin open-question #1 resolved. Safe for
  LaMa on Replicate based on community norms, well within our existing 10 MB
  download cap (`MAX_DOWNLOAD_BYTES`), and preserves enough detail for
  furniture/room-scale removal. Callers downstream consume the URL only; no
  code depends on native-res output today.
- **Mask resize uses nearest-neighbor.** Binary mask must stay binary
  (white=remove, black=preserve). Bilinear/bicubic would smear edges and
  produce intermediate grays that LaMa mis-interprets. `sharp`'s `kernel:
  nearest` is the explicit option.
- **Normalized artifacts go under a new `"normalized"` keyPrefix.** Mirrors
  the existing `"masks"` convention for short-TTL intermediates. Keeps
  canonical `generations/` and user `uploads/` prefixes untouched. S3
  lifecycle config (outside this repo) gains a new prefix to expire — called
  out in Documentation / Operational Notes.
- **Only renormalize when needed.** If image and mask already match AND
  image long-side ≤ 2048, pass the original URLs through unchanged. Avoids
  a pointless fetch+reupload round-trip for jobs that are already healthy
  (notably: all landscape jobs today).
- **Keep `maxRetries: 1` on `callRemoval`.** Origin open-question #4
  resolved. Once normalized, the retry only fires for transient Replicate
  flakes (connection drops, 5xx). Removing retry to save latency isn't
  worth losing that headroom.
- **Add `sharp` to dependencies.** No equivalent tool exists in the repo.
  Widely used, native-addon-based, battle-tested. Install with
  `sharp@0.33.x` (current major).

## Open Questions

### Resolved During Planning

- Long-side cap → **2048 px**.
- Normalized storage location → **new `"normalized"` keyPrefix** via existing
  `persistGenerationImage()`.
- Reject vs. always resize → **always resize**.
- Retry envelope → **keep `maxRetries: 1`**.
- Integration point → **`runRemoval` wrapper, not provider function**.

### Deferred to Implementation

- Exact `sharp().resize()` option tuning for the image downscale (fit,
  withoutEnlargement, kernel) — needs a quick side-by-side at implementation
  time to confirm no unexpected chroma shift or color-profile drop (note:
  source image in the failing sample was Display P3).
- Whether to preserve input ContentType (JPEG→JPEG) or always re-encode
  normalized image as PNG. JPEG preserves size but recompresses; PNG avoids
  recompression artifacts at the cost of larger upload. Decide while
  implementing — resolve via a visual inspection on 3-5 real jobs.
- S3 lifecycle rule for the new `"normalized"` prefix (TTL value) — owned by
  infra config outside this repo; surface the requirement to infra during
  rollout.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for
> review, not implementation specification. The implementing agent should
> treat it as context, not code to reproduce.*

```
runRemoval(imageUrl, maskUrl)
  │
  ├─► normalizeRemovalInputs(imageUrl, maskUrl, generationId, userId)
  │     │
  │     ├─ fetch image + mask bytes (parallel, reuse fetch guard from s3-upload)
  │     ├─ read dimensions via sharp().metadata()
  │     ├─ decide:
  │     │    (a) image.long > 2048 → downscale image
  │     │    (b) mask.size ≠ final image.size → nearest-neighbor resize mask
  │     │    (c) neither → short-circuit, return originals
  │     ├─ if any normalization ran:
  │     │    ├─ upload normalized image (keyPrefix="normalized")
  │     │    └─ upload normalized mask  (keyPrefix="normalized")
  │     └─ return { imageUrl, maskUrl, normalized: bool, before/after dims }
  │
  ├─► logger.info  "remove.normalize.done"  (always — includes dims + action)
  ├─► logger.warn  "remove.normalize.mismatch"  (when a resize was required)
  │
  └─► callRemoval({ imageUrl: normalized, maskUrl: normalized })
        │
        └─ on empty_response: log now includes post-normalization dims
          (see Unit 4)
```

## Implementation Units

- [x] **Unit 1: Add `sharp` dependency**

**Goal:** Make image dimension introspection and resizing available to the
backend.

**Requirements:** R1, R2.

**Dependencies:** None.

**Files:**
- Modify: `package.json`, `package-lock.json`
- (No test file — see Scope Boundaries.)

**Approach:**
- Install `sharp` at the current stable major (`^0.33`).
- Verify the build (`npm run typecheck`, `node -e "require('sharp')"`) runs
  on the deploy target (Render/Linux x64). `sharp` ships prebuilt binaries;
  no additional build step expected.

**Patterns to follow:**
- Match the existing dependency style in `package.json` (exact vs. caret is
  already inconsistent; follow whatever `@aws-sdk/client-s3` uses for
  consistency).

**Test scenarios:**
- Test expectation: none — dependency addition with no behavioral code.
  Verified by typecheck + a one-liner require smoke test.

**Verification:**
- `npm run typecheck` passes.
- Deploy-target compatibility confirmed (prebuilt binary loads on Render
  runtime — Linux x64 glibc).

---

- [x] **Unit 2: `normalizeRemovalInputs` helper**

**Goal:** Produce a pure-ish helper that takes image+mask URLs, returns
URLs whose pixel dimensions match and whose image long-side ≤ 2048, uploading
normalized variants to S3 only when needed.

**Requirements:** R1, R2.

**Dependencies:** Unit 1.

**Files:**
- Create: `src/lib/generation/normalize-removal-inputs.ts`
- (No test file — see Scope Boundaries.)

**Approach:**
- Accept `{ imageUrl, maskUrl, userId, generationId }`. Return `{ imageUrl,
  maskUrl, action: "passthrough" | "normalized", before: {...}, after:
  {...} }`.
- Fetch both URLs in parallel, reusing the hostname / size-cap / timeout
  discipline from `src/lib/storage/s3-upload.ts:96-215` (SSRF guard,
  `MAX_DOWNLOAD_BYTES`, `DOWNLOAD_TIMEOUT_MS`). Consider extracting the
  download primitive into a shared helper if the duplication is thin, or
  just import the private logic via a small refactor inside `s3-upload.ts`
  — decide at implementation time, noted as deferred.
- Read dimensions with `sharp(buffer).metadata()`.
- Decide action:
  1. Compute target image size: scale image down so long-side = 2048, only
     if it currently exceeds 2048; else keep native.
  2. If target image size ≠ mask size, mask must be resized to target image
     size with `kernel: "nearest"`.
  3. If neither a downscale nor a mask-resize is needed, return
     `action: "passthrough"` with original URLs — **no upload**.
- On normalization: upload the resulting buffers via
  `persistGenerationImage` (or a cousin helper that accepts a buffer
  directly — see Deferred below) with `keyPrefix: "normalized"`. Reuse the
  `userId` / `generationId` so keys collocate with the job.
- Return the normalized (CDN) URLs plus a before/after dimensions object
  for logging.

**Deferred to implementation:**
- `persistGenerationImage()` currently fetches from a sourceUrl. For Unit 2
  we already have the bytes in memory. Either (a) extend
  `persistGenerationImage` to accept an optional pre-fetched buffer, or
  (b) add a sibling `persistGenerationBuffer()` that reuses the same S3
  write path. Choose the minimal refactor at implementation time.
- JPEG-preserve vs. PNG re-encode for the normalized image (see Open
  Questions).
- `sharp().resize()` option tuning for the image branch.

**Patterns to follow:**
- `src/lib/storage/s3-upload.ts` for fetch safety, logging style, and S3
  write.
- `src/lib/generation/segment-remove.ts` for generation-seam helper
  structure and logger event naming (`<stage>.<action>`).

**Test scenarios (operational validation in Unit 5 covers these end-to-end
since there is no test runner):**
- Happy path: image 4608×6144 + mask 3024×4032 → normalized image 1536×2048,
  normalized mask 1536×2048, `action: "normalized"`, both `persistGenerationImage`
  calls succeed.
- Passthrough: image 4032×3024 + mask 4032×3024 → `action: "passthrough"`,
  no S3 writes, original URLs returned unchanged.
- Mask-only resize: image 2048×1536 (already in cap) + mask 3024×4032 →
  mask resized to 2048×1536, image passed through, one S3 write.
- Image-only downscale: image 4608×6144 + mask 4608×6144 (rare but possible
  post-Phase-A) → both downscaled to 1536×2048.
- Edge case: image and mask already match at exactly 2048 long-side →
  passthrough.
- Edge case: tiny inputs (256×256) → passthrough.
- Error path: fetch fails (timeout, 404, SSRF-guard rejection) → error
  propagates with a structured log event; `runRemoval` sees the failure
  and reports it via the existing error mapper, breaker records a failure.
- Error path: mask is not a valid image (corrupt bytes) → sharp throws →
  structured log → propagates.
- Error path: S3 PUT fails → same propagation.

**Verification:**
- Helper is pure w.r.t. logging (no side effects beyond the two potential
  S3 writes and structured logs).
- Passthrough path does zero S3 IO.
- Dimensions in the returned `after` object match what is actually at the
  returned URLs (smoke-validated in Unit 5).

---

- [x] **Unit 3: Wire `normalizeRemovalInputs` into `runRemoval`**

**Goal:** Actually use the helper. Until this unit, the helper is dead code.

**Requirements:** R1, R2.

**Dependencies:** Unit 2.

**Files:**
- Modify: `src/lib/generation/segment-remove.ts` (specifically `runRemoval`,
  lines 113-133)
- (No test file — see Scope Boundaries.)

**Approach:**
- Call `normalizeRemovalInputs` immediately before `callRemoval` inside
  `runRemoval`.
- Pass `userId` and `generationId` through. `runRemoval`'s current input
  `RunRemovalInput` doesn't carry those — extend it, and update the two
  call sites in `src/services/generation-processor.ts:373` and `:393` to
  pass them (`generationId` + `userId` are already in scope at both call
  sites per the processor.ai.start log).
- Forward normalized URLs to `callRemoval`.
- Include normalization duration in the returned `durationMs` envelope or
  surface it as a separate field; keep backward-compat with the existing
  `RunRemovalOutput` shape — add, don't rename.

**Patterns to follow:**
- Logger event naming: `remove.normalize.done` (info, every call) + include
  `action`, `before`, `after`. `remove.normalize.mismatch` (warn) only when
  a resize was required — matches the origin-doc tracking requirement (R3).

**Test scenarios:**
- Integration: vertical-failure job replayed with real URLs returns a
  successful LaMa output (see Unit 5 operational validation — this is the
  "did we fix the bug" check).
- Integration: landscape-already-good job still succeeds and takes the
  passthrough path (no regression, zero extra S3 writes).

**Verification:**
- `runRemoval` callers compile and pass through `userId` + `generationId`
  cleanly.
- `processor.ai.start` → `remove.normalize.done` → `remove.completed` log
  chain appears for a normalized job; `remove.normalize.mismatch` appears
  when shape differed.

---

- [x] **Unit 4: Enrich LaMa empty-response log with post-normalization dims**

**Goal:** If LaMa still returns null after normalization, the log tells us
the new failure mode isn't a shape mismatch — and includes the dims to
prove it.

**Requirements:** R3.

**Dependencies:** Unit 3 (so the dims are actually equal when we log them).

**Files:**
- Modify: `src/lib/ai-providers/replicate.ts` (specifically the warn log at
  lines 270-279 inside `callRemovalReplicate`)
- (No test file — see Scope Boundaries.)

**Approach:**
- Accept optional `normalizedDims: { width, height }` in `RemovalInput` so
  the router/segment-remove layer can pass them down. The provider logs them
  alongside `outputShape` / `outputSnapshot` / `durationMs` in the existing
  `empty_response` warn structure.
- Keep the field optional so `callInpaintReplicate` and the rest of the
  provider code is unaffected.

**Patterns to follow:**
- Existing structured-log shape in the same file.

**Test scenarios:**
- Happy path: successful LaMa call — no change in behavior, no log noise
  added.
- Error path: simulate a LaMa null response (point the removal model env
  to a deliberately-broken slug in a dev env) and confirm the warn log now
  includes `normalizedDims`. Verified via Unit 5 operational validation.

**Verification:**
- Next `provider.replicate.empty_response` event carries the exact pixel
  dimensions LaMa saw, making future regressions diagnosable from logs
  alone.

---

- [x] **Unit 5: Operational validation checklist**

**Goal:** In lieu of a unit-test runner (absent codebase-wide), define the
manual end-to-end checks required before marking Phase B shipped.

**Requirements:** R1, R2, R3.

**Dependencies:** Units 1-4.

**Files:**
- Modify: `docs/runbooks/` — add
  `2026-04-22-remove-objects-normalization-validation.md`.
- (No test file — intentional.)

**Approach:**
- Document the exact validation steps for rollout:
  1. **Replay-the-bug check** — trigger a Remove Objects job on a vertical
     iPhone photo (4608×6144 source). Expected: `action: "normalized"` in
     log, LaMa returns image, job lands `completed`.
  2. **Landscape-regression check** — trigger on a 4032×3024 matched-mask
     job. Expected: `action: "passthrough"`, zero extra S3 writes,
     `completed`.
  3. **Near-cap boundary** — 2048×2048 matched. Expected: passthrough.
  4. **Breaker-probe check** — during rollout, watch
     `CircuitBreaker:design` transitions over 24 h. Expected: no
     `CLOSED → OPEN` transitions tied to `removeObjects` failures.
  5. **Log-diagnosability check** — force a null LaMa response in a staging
     env; confirm `provider.replicate.empty_response` carries
     `normalizedDims`.

**Test scenarios:**
- Test expectation: none — this unit is a validation runbook, not code.

**Verification:**
- Runbook is linked from the PR description; each step has a check-off
  in the Post-Deploy Monitoring & Validation section of the PR.

## System-Wide Impact

- **Interaction graph:** Only the Remove Objects path
  (`generation-processor.ts` → `runRemoval` → `callRemoval` → LaMa) is
  touched. Segmentation path (`runSegmentation`) is not modified. Inpaint
  path (`callInpaint`) is not modified.
- **Error propagation:** Normalization fetch/resize/upload errors propagate
  as regular `Error` up through `runRemoval` → `processor.ai` → existing
  `AI_PROVIDER_FAILED` mapping. No new error codes needed.
- **State lifecycle risks:** Normalized artifacts land under a new
  `"normalized"` keyPrefix — the infra S3 lifecycle policy must add a TTL
  rule for that prefix, otherwise scratch uploads accumulate. Flagged in
  Documentation / Operational Notes.
- **API surface parity:** `runRemoval`'s input shape grows by `userId` +
  `generationId`. Only two internal callers — updated in Unit 3. No
  public-facing API changes, no tool-types schema changes.
- **Integration coverage:** End-to-end verified via Unit 5 (no test runner
  in repo).
- **Unchanged invariants:** `/api/design/remove-objects` request/response
  contract, tool-types body schema, iOS client API expectations, mask
  convention (white=remove), retry envelope (`maxRetries: 1`), circuit
  breaker thresholds, fal.ai fallback policy (still "no fallback for
  removal").

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `sharp` prebuilt binary incompatible with Render runtime | Verify in Unit 1 with a require smoke test before deploying; `sharp` ships Linux x64 glibc binaries which is the current deploy target. |
| Normalization adds latency (fetch + resize + upload) to every removal job | Passthrough short-circuit avoids the round-trip for already-matched inputs; full normalization expected < 2 s on a 28 MP input. Acceptable against the alternative (the job failing). |
| Re-encoding the image alters color (P3 → sRGB drift) | Preserve input color profile via `sharp().withMetadata()`, or re-encode as PNG to sidestep JPEG recompression. Decision deferred to implementation-time side-by-side. |
| No test runner → regressions escape to production | Operational validation runbook (Unit 5) + enriched failure logs (Unit 4) provide the diagnosability a test suite would. Introducing vitest is out-of-scope but noted as a follow-up candidate. |
| S3 lifecycle for `"normalized"` prefix not configured → storage growth | Surface the TTL requirement to infra during rollout; blocker for long-term scale but not for Phase B shipping. |
| Post-normalization LaMa still returns null (different root cause) | Unit 4's log enrichment will surface the new failure mode with dimensions included; we can then decide on a follow-up (Phase C — fal.ai removal fallback, or a different community model slug). |

## Documentation / Operational Notes

- Add `docs/runbooks/2026-04-22-remove-objects-normalization-validation.md`
  (Unit 5).
- **Infra follow-up (outside this repo):** add an S3 lifecycle rule
  expiring the new `"normalized"` prefix on a short cadence, matching the
  existing `"masks"` policy.
- **Rollout:** single-step deploy is fine; feature flag not required
  because the new path activates only when normalization is actually
  needed (passthrough otherwise) and the failure mode is currently broken
  anyway (nothing to regress for the users currently hitting this bug).
- **Monitoring signals post-deploy:**
  - `remove.normalize.done` rate > 0 (confirms deployment is live).
  - `remove.normalize.mismatch` rate > 0 until Phase A ships, trending to
    zero after.
  - `provider.replicate.empty_response` rate for `allenhooo/lama` trends
    toward zero.
  - `CircuitBreaker:design CLOSED → OPEN` transitions on removeObjects
    failures drop to near-zero.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-04-22-001-remove-objects-vertical-failure-requirements.md`
- Related code:
  - `src/lib/ai-providers/replicate.ts` (LaMa call site)
  - `src/lib/ai-providers/router.ts` (retry + breaker envelope)
  - `src/lib/generation/segment-remove.ts` (`runRemoval` wrapper)
  - `src/lib/storage/s3-upload.ts` (fetch + S3 upload pattern to mirror)
  - `src/lib/circuit-breaker.ts` (breaker semantics)
- Related prior plans:
  - `docs/plans/2026-04-19-003-refactor-sam3-lama-unified-pipeline-plan.md`
  - `docs/plans/2026-04-19-002-refactor-lama-remove-taxonomy-tighten-plan.md`
- External: `allenhooo/lama` on Replicate; LaMa paper (`advimman/lama`).
