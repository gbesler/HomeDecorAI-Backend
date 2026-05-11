# Interior Prompt Builder Version Rollout

**Owner:** prompt-quality
**Last updated:** 2026-05-11

The interior prompt builder ships three versions behind a single env var so
operators can flip forward to v2 (or back to v1 / legacy) without a code
deploy. This runbook covers the flip command, what to watch after a flip,
and the rollback path.

## Versions

| Value | Builder | Module |
|-------|---------|--------|
| `legacy` | Original single-template builder (D17 F2 escape hatch). | `src/lib/prompts/legacy.ts` |
| `v1` | 7-layer composition with action-mode branches. **Current default.** | `src/lib/prompts/tools/interior-design.ts` |
| `v2` | Head-layer-inlined preservation, descriptive `preservationHint`, input-anchored photography-quality, `changeBudget`-driven verbs. | `src/lib/prompts/tools/interior-design-v2.ts` |

Dispatch happens in `tool-types.ts → buildInteriorPromptDispatch`.

## Flip to v2

On the host where the backend runs (Render, GCP, etc.):

```bash
# Set the env var on the running service. Example: Render env tab,
# Cloud Run revision env, or wherever PROMPT_BUILDER_VERSION lives today.
PROMPT_BUILDER_VERSION=v2
```

A service restart (or container roll) is required for env to take effect.

The change is process-level — the value is read once at module load in
`env.ts` and forwarded to every `buildInteriorPromptDispatch` call.

## What to watch after a flip

1. **Firestore `generations/{id}.promptVersion`** — should show
   `interiorDesign/v2.0` for new interior runs after the flip. v1 entries
   stay `interiorDesign/v1.0`. Use this field to slice success/failure
   metrics by builder version.

2. **`prompt.token_truncation` log events** — emitted by both v1 and v2 when
   a prompt is trimmed to fit the 280-token Pruna budget. The `tool` +
   `promptVersion` + `droppedLayers` fields tell you whether v2 is dropping
   layers more aggressively than v1. Expected steady-state: 0 truncations.

3. **`generation.failed` rate by promptVersion** — Cloud Tasks delivery
   failures, model-side schema rejections, S3 upload errors. Any visible
   increase after the flip is a v2 regression signal.

4. **User-visible quality** — review at least 20 production generations in
   the first 24 hours (across `modern`, `industrial`, `bohemian`,
   `airbnb`). Check for:
   - Camera angle preserved vs source photo
   - Visible doors / doorframes / windows preserved
   - Room not silently converted to a different room type
   - Two different photos of the same room+style should produce
     visibly different layouts (cookie-cutter test)

## Rollback

If v2 shows a regression on any monitored signal, flip back instantly:

```bash
PROMPT_BUILDER_VERSION=v1
# (restart / roll)
```

Or further, to legacy if v1 also misbehaves (very unlikely — v1 is in
production today):

```bash
PROMPT_BUILDER_VERSION=legacy
```

No code change needed; both v1 and legacy modules stay in the build.

## Validation invariant on boot

`validateDictionaries({ mode: 'strict' })` runs at backend startup and
catches:

- Missing `preservationHint` is allowed (v2 falls back to focusSlots
  composition for the affected room), but an *empty* string is rejected.
- `changeBudget` outside the four enum values is rejected.
- Any `slotOverrides` value containing a negation token (`avoid`, `no`,
  `not`, `without`, `never`, `none`) is rejected — this is the invariant
  that closed the v1 airbnb negation leak.

If the backend fails to boot after a dictionary change, the validator
message names the exact entry and field. Fix the dictionary, redeploy.

To run the validator locally against the current dictionaries:

```bash
npx tsx -e "import { validateDictionaries } from './src/lib/prompts/validate.ts'; validateDictionaries({ mode: 'strict' }); console.log('OK');"
```

## Related

- Plan: `docs/plans/2026-05-11-001-refactor-interior-design-prompting-plan.md`
  (in the iOS repo, marked `Target repo: HomeDecorAI-Backend`).
- Companion plan: `docs/plans/2026-05-11-002-refactor-prompt-system-cross-tool-plan.md`
  — covers virtual-staging, exterior, garden, surface-restyle, and
  replace-add-object follow-ups.
