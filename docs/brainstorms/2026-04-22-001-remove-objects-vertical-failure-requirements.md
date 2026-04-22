---
title: Remove Objects — Vertical Photo Failure Fix
date: 2026-04-22
status: active
owner: kagan
---

# Remove Objects — Vertical Photo Failure Fix

## Problem

Remove Objects tool silently fails on vertical (portrait) photos. LaMa
(`allenhooo/lama` on Replicate) returns `null` output after ~10s, both retry
attempts fail, and the design circuit breaker opens — which also briefly
degrades every other tool routed through it.

Example failing generation (`5d8ffbf8-cc82-4f6f-be33-94f01e1f39d9`):

- `imageUrl` → 4608 × 6144 (28.3 MP, portrait)
- `maskUrl`  → 3024 × 4032 (12.2 MP, portrait)

Aspect ratios match (3:4) but **pixel dimensions don't**. LaMa requires image
and mask to be the same shape; a size mismatch makes the community model silently
drop the job rather than returning a typed error. Landscape photos tend not to
hit this because the common iPhone landscape path caps at 4032×3024 and the
mask is rendered at the same UIImage-reported size.

## Root Cause

Image and mask are produced from **different pixel buffers** on the iOS side:

- The original photo is uploaded to S3 at its native resolution (48 MP crops
  on newer iPhones land at 4608×6144).
- `MaskRenderer.renderPNG` (`HomeDecorAI/Features/Wizard/Views/Steps/BrushMaskCanvasView.swift:174-177`)
  renders the mask at `UIImage.size * UIImage.scale`, which for many load paths
  (ImageIO downsample, `PHImageManager` default delivery mode, HEIC decode
  defaults) returns the downscaled display copy at 3024×4032 rather than the
  full-res pixels.

Backend forwards both URLs straight to Replicate without validation
(`HomeDecorAI-Backend/src/lib/ai-providers/replicate.ts:256-259`). LaMa sees
mismatched shapes and returns `null`.

## Goals

1. Remove Objects succeeds on vertical photos from current clients (including
   shipped versions the user never updates).
2. LaMa's null-response failure mode stops opening the design circuit breaker,
   which currently degrades unrelated tools.
3. Future payload shape drift is visible in logs before users report it.

## Non-Goals

- Replacing LaMa with a different removal model.
- Adding a second removal provider as a true fallback (explicit non-goal per
  router comment; revisit if the circuit breaker keeps opening after this fix).
- Changing the mask brush UX.
- Landscape / square photos — already working, no regression plan needed beyond
  not breaking them.

## Approach (two landing points, shipped in order)

### Phase B — Backend defensive guard (ships first, unblocks all users)

Before calling `callRemovalReplicate`, add a normalization step that:

1. Fetches image and mask (HEAD for dimensions where possible, otherwise GET
   with `sharp().metadata()`).
2. If image long-side exceeds a safe threshold (see open question), downscales
   the image and uploads the normalized copy to S3 in a scratch prefix.
3. If mask dimensions ≠ image dimensions, resizes the mask to match the
   (possibly downscaled) image using **nearest-neighbor** interpolation so the
   binary mask stays binary.
4. Passes the normalized URLs to Replicate.
5. Logs the pre- and post-normalization dimensions at info level; logs
   `remove.normalize.mismatch` at warn when a resize was needed.

On retry / failure, the existing `empty_response` log should additionally
include the post-normalization image and mask dimensions so the next regression
is diagnosable from logs alone.

### Phase A — iOS root-cause fix (ships after B, reduces bandwidth + latency)

Guarantee that image and mask derive from the **same pixel buffer** before
upload. Either:

- Downscale the upload image to a fixed long-side (e.g., 2048) before S3
  upload, render the mask at the same dimensions, OR
- Decode the upload image's full pixel dimensions via CGImage and render the
  mask at those exact dimensions.

Preference between the two is an implementation-time decision — see `/ce:plan`.

After Phase A ships, the Phase B normalizer stays in place as defense-in-depth
and as backfill for users still on older client versions.

## Success Criteria

- New Remove Objects jobs on vertical photos from the current client succeed
  end-to-end at the same rate as landscape jobs (measure 7-day window after B
  ships).
- Zero `provider.replicate.empty_response` events attributable to
  image/mask shape mismatch after B ships (track the new
  `remove.normalize.mismatch` rate instead — it should be non-zero pre-Phase-A
  and trend to zero post-Phase-A).
- Design circuit breaker `CLOSED → OPEN` transitions caused by
  `AI_PROVIDER_FAILED` on `removeObjects` drop to near-zero.

## Open Questions (for `/ce:plan`)

1. Image long-side cap for backend downscale — 2048? 2560? LaMa's practical
   ceiling on Replicate's GPU provisioning isn't publicly documented.
2. Where do the normalized image / mask live in S3 — reuse the `uploads/` prefix
   with a suffix, or a dedicated `normalized/` scratch prefix with a TTL?
3. Should Phase B ever **reject** vs. always resize? (Rejecting gives the user
   a clearer retry message for truly broken inputs, e.g., 1×1 masks; resizing
   always is simpler.)
4. Do we still want the current `maxRetries: 1` on `callRemoval` once
   normalization is in place, or does retrying a normalized payload add
   marginal value?

## Scope Boundaries

- Changes touch `HomeDecorAI-Backend/src/lib/ai-providers/router.ts`,
  `HomeDecorAI-Backend/src/lib/ai-providers/replicate.ts`, and a new
  normalization helper. No tool-types, no API contract changes.
- Phase A touches `HomeDecorAI/Features/Wizard/Views/Steps/BrushMaskCanvasView.swift`
  and the Wizard's image-upload path. No backend changes from Phase A alone.
- No new dependencies beyond `sharp` (already used in backend per codebase
  convention — verify during planning).
