---
title: Interior prompt v2 — post-review follow-ups
priority: p2
status: ready
created: 2026-05-11
source: ce-review autofix run on refactor/prompt-system-v2
related-plan: HomeDecorAI/docs/plans/2026-05-11-001-refactor-interior-design-prompting-plan.md
---

# Interior v2 — non-blocking follow-ups

These items came out of the ce:review autofix pass on `refactor/prompt-system-v2`. They are **not blockers** for the initial flag-gated v2 rollout (default stays `v1`), but should be resolved before flipping `PROMPT_BUILDER_VERSION=v2` to default in production.

## Gated decisions (need human input)

### 1. Narrow `ChangeBudget` type to exclude `"overlay"` for transform path

The `overlay` value on `ChangeBudget` is only set by christmas, and christmas routes to `composeOverlay` before `resolveVerbAndBoundary` is ever consulted. The dead branch is preserved with a `Layer additional decor` placeholder that never ships.

**Options:**
- Drop `overlay` from `ChangeBudget` entirely (christmas keeps `actionMode: "overlay"` but no `changeBudget`).
- Make `StyleEntry` a discriminated union on `actionMode` so `transform`/`target` require a non-overlay `changeBudget` and `overlay`/`target` forbid the field.

**Decision needed:** which option, or accept the dead branch as defense-in-depth.

### 2. `airbnb.slotOverrides.personalization` prescriptive plant/art

Current value: `"neutralized styling with minimal generic accents, broadly appealing styling, a single tasteful plant or art piece"`.

The "a single tasteful plant or art piece" clause may instruct Flux to *add* a plant to source photos that don't have one — particularly noticeable in kitchen/bathroom (fixture rooms) where `composeTarget` merges this into the prompt body. This contradicts the v2 preservation goal.

**Decision needed:** prompt-quality designer to pick between (a) drop the prescriptive item ("broadly appealing texture, minimal generic accents"), (b) keep but gate per room type, (c) accept as intended airbnb-staging behavior.

## Manual work (downstream)

### 3. CI test asserting `structural-preservation` never trims

Worst-case scenario: a future style adds 100 tokens to `coreAesthetic`. HEAD layer bloats. `trimLayersToBudget` drops priorities 7 → 6 → 5 → 4 → 3 → 2 until it fits. Priority-2 `structural-preservation` is the last to drop but the algorithm can drop it. The 216-pair audit run today passes, but it's a snapshot — there's no CI guard against future bloat.

**Work:**
- Add a unit test (when test framework is set up) that iterates all 216 pairs and asserts `result.trimResult.droppedLayers` excludes `"structural-preservation"`.
- Or: add upper-bound length checks in `checkStyleEntry` for `coreAesthetic` and in `checkRoomEntry` for `preservationHint`.
- Or: pin `structural-preservation` to priority 1.5 (a HEAD sibling) so the trim algorithm physically cannot drop it.

### 4. photography-quality priority demotion vs new input-anchor content

In v1, `photography-quality` had a fixed lens directive (`"35mm at f/4"`) that was a primary contributor to camera drift. v2 rewrote it to input-anchored phrasing — but kept it at priority 7 (first to drop). Under token pressure, the new input-anchor token is lost first.

**Options:**
- Raise priority since the content is now load-bearing for camera fidelity.
- Move the input-anchor token into `style-core` or `style-detail` so it survives trimming.
- Accept partial loss under pressure; rely on the HEAD `HEAD_PRESERVATION_CLAUSE` to cover camera anchor.

### 5. Christmas overlay lighting vs strengthened structural-preservation conflict

Christmas overlay mode uses `style.lightingCharacter` (`"warm candlelit glow with festive string lights throughout"`) at the lighting layer. v2's strengthened structural-preservation primitive includes `"Keep the camera angle, lens, framing, vanishing points, and field of view exactly the same as the source image"`. When the source photo is daytime, these conflict.

**Options:**
- Override `INPUT_LIGHTING_ANCHOR` for overlay mode + add festive lighting as additive ("with additional festive string-light accents in places that fit the existing lighting").
- Build per-actionMode subvariants of `buildStructuralPreservation` that omit/soften the lens clause for overlay.
- Document as known limitation ("Christmas styling works best on daytime photos with neutral light") in user-facing copy.

## Advisory (no action required)

- **v1/v2 helper duplication will drift.** ~150 lines of pure-function helpers (`FIXTURE_ROOMS`, regex constants, `resolveStyleAssets`, etc.) duplicated between v1 and v2 files. Acceptable for the rollout window (v1 is the rollback target). Schedule v1 file deletion in the same plan that flips v2 to default.
- **Cross-tool plan #002 should extend the same patterns** to virtual-staging (which shares `composeRoomFocus(room)` pain), exterior tools, and the surface-restyle helper.
- **`preservationHint` could be made required** in types.ts now that all 12 rooms populate it. Skipped during initial v2 ship to avoid widening the type contract; revisit when v2 becomes default.
