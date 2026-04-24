# Pre-Launch Notification Campaign

14-day push notification sequence that runs for every new user until they
either buy premium, disable notifications, or reach day 14. One-time schedule
at first FCM-token registration. See
`docs/plans/2026-04-24-001-feat-pre-purchase-notification-campaign-plan.md`.

## Moving parts

| Component | Path |
|---|---|
| Templates (TR/EN) | `src/lib/notifications/campaign-templates.ts` |
| Scheduler | `src/services/pre-launch-campaign.service.ts` |
| Enqueue helper | `src/lib/cloud-tasks.ts` → `enqueueCampaignTask` |
| FCM dispatch | `src/lib/notifications/fcm.ts` → `sendCampaignNotification` |
| Fire receiver | `src/controllers/campaign.controller.ts` (`POST /internal/notifications/campaign-fire`) |
| User doc helpers | `src/lib/notifications/user-state.ts` |
| iOS deep-link router | `HomeDecorAI/App/DeepLinkRoute.swift`, `AppDelegate.swift` |
| iOS premium sync | `HomeDecorAI/Core/Paywall/PremiumStateManager.swift` |

Trigger point: successful `POST /api/users/me/fcm-token`. The handler
fires `schedulePreLaunchCampaign(uid)` in the background — failures are
logged but never fail the token registration.

## Environment variables

The campaign has no dedicated env vars. It reuses:

| Name | Purpose |
|---|---|
| `GCP_QUEUE_NAME` | Cloud Tasks queue that carries both generation and campaign tasks. |
| `INTERNAL_TASK_AUDIENCE` | OIDC audience shared with the generation processor. |
| `FCM_ENABLED` | Hard kill-switch for *all* FCM dispatch, including campaigns. |

The fallback timezone (`Europe/Istanbul`) and all template content live
in source — changes require a deploy.

## Enable / disable in production

- **Stop all pushes (incl. generation-complete):** set `FCM_ENABLED=false`.
  The dispatch layer skips every `sendEachForMulticast`.
- **Purge scheduled campaign tasks:** use the GCP console or
  `gcloud tasks tasks delete --queue=<queue>`. Campaign tasks are named
  `precampaign-<uid>-day-<N>`.
- **Per-user cancellation:** set `users/{uid}.isPremium=true` in Firestore.
  Each fire reads this at dispatch time and skips.

## QA: verify a single day without waiting

The fire receiver is reachable only through Cloud Tasks OIDC — you cannot
curl it directly. To verify any day without waiting:

1. Open the Cloud Tasks console and pick the queue.
2. Create a one-off task pointing at `/internal/notifications/campaign-fire`
   with body `{ "userId": "<uid>", "day": <N> }`, OIDC token from the
   configured service account, and `scheduleTime = now + 30s`.
3. Watch backend logs for the fire event.

For end-to-end validation of the sequence across days, either:

- Leave a test device on for the full 14-day window, or
- Manually enqueue one task per day using the console (takes a minute per day).

To test the premium gate mid-flight: set `users/{uid}.isPremium=true` in
Firestore before a scheduled task fires. The handler returns
`{ skipped: "premium" }` and no push is dispatched.

Reset between runs: delete the `preLaunchCampaign` map from the user doc
and purge any remaining Cloud Tasks with matching names.

## Verifying a specific day

The fire receiver is reachable internally only through Cloud Tasks OIDC —
you cannot curl it directly. To verify a single template manually:

1. Write a one-off Cloud Task in the console pointing at
   `/internal/notifications/campaign-fire` with body
   `{ "userId": "<uid>", "day": <N> }`.
2. Use `scheduleTime = now + 30s` so you can observe the fire in logs.

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Scheduler logs `user_missing` | Token register wrote `users/{uid}` but doc was deleted before scheduler ran | Benign; next token register reschedules. |
| Scheduler logs `already_scheduled` | Repeat launch | Expected — idempotent. |
| Fire returns `skipped: no-tokens` | User revoked notification permission or uninstalled | Expected. Reinstall + re-grant triggers a new register → new campaign. |
| Fire returns `skipped: premium` | User purchased during the campaign | Expected. |
| Cloud Tasks `ALREADY_EXISTS` | Concurrent schedule calls | Expected — idempotent dedup. |
| All pushes silently missing on iOS | `aps-environment` in entitlements wrong for build flavor | Check `HomeDecorAI.entitlements` — `development` vs `production`. |

## Editing templates

Templates live in
`src/lib/notifications/campaign-templates.ts`. Editing title/body/deepLink
values requires a deploy; there is no runtime override. Deep-link targets
must match:

- `homedecorai://tool/<toolId>` — `toolId` must equal a `HomeTool.deepLinkIdentifier` on iOS.
- `homedecorai://paywall?offer=<trial|half-off>`
- `homedecorai://gallery`
- `homedecorai://generation/<id>` (existing — generation completion).

Adding a new day: extend `CampaignDay` and `PRE_LAUNCH_TEMPLATES`. Day 7
is deliberately omitted — do not reintroduce it without a product decision.
