# Cloud Tasks Setup Runbook

Manual steps to provision the GCP infrastructure that backs the async generation
pipeline. Run this once per environment (staging and production each get their
own queue + service account).

> **Prerequisites**
> - `gcloud` CLI authenticated against the Firebase project (the same project
>   that holds the existing Firestore database — Cloud Tasks lives alongside
>   Firestore, not in a separate project).
> - Project Owner or equivalent rights during setup only. Runtime uses a
>   narrow service account.

## 1. Variables

Set the following shell variables once; every command below uses them.

```bash
export PROJECT_ID="<firebase-project-id>"
export LOCATION="us-central1"
export QUEUE_NAME="design-generation"               # or "design-generation-staging"
export BACKEND_URL="https://homedecorai-backend-pv3k.onrender.com"
export SA_NAME="cloud-tasks-invoker"
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
```

## 2. Enable APIs

```bash
gcloud services enable cloudtasks.googleapis.com --project "$PROJECT_ID"
gcloud services enable iamcredentials.googleapis.com --project "$PROJECT_ID"
```

## 3. Create the queue

```bash
gcloud tasks queues create "$QUEUE_NAME" \
  --location="$LOCATION" \
  --max-concurrent-dispatches=10 \
  --max-attempts=3 \
  --min-backoff=10s \
  --max-backoff=60s \
  --max-doublings=3 \
  --project "$PROJECT_ID"
```

Settings rationale:
- `max-concurrent-dispatches=10` caps parallel AI calls so we don't exceed
  Replicate rate limits.
- `max-attempts=3` matches the retry budget the processor assumes.
- Exponential backoff (10s → 60s, double 3 times) keeps the retry train tight
  without hammering a transient outage.

## 4. Create the invoker service account

```bash
gcloud iam service-accounts create "$SA_NAME" \
  --display-name="Cloud Tasks invoker for HomeDecorAI async pipeline" \
  --project "$PROJECT_ID"

# Permission to create tasks in the queue.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/cloudtasks.enqueuer"

# Permission to mint its own OIDC tokens (needed for HTTP targets with OIDC).
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser"
```

## 5. Export a key (only for backends that do not run on GCP)

Because the backend runs on Render, we need a JSON key file. On pure-GCP
deployments you would use workload identity instead.

```bash
gcloud iam service-accounts keys create cloud-tasks-invoker.json \
  --iam-account="$SA_EMAIL" \
  --project "$PROJECT_ID"
```

Store `cloud-tasks-invoker.json` in a password manager. **Note:** the current
backend re-uses `FIREBASE_SERVICE_ACCOUNT_KEY` for Cloud Tasks auth, so you
only need a separate key if you want to isolate permissions. In that case:

1. Base64-encode the file: `base64 -i cloud-tasks-invoker.json | tr -d '\n'`
2. Set `FIREBASE_SERVICE_ACCOUNT_KEY` on Render to the encoded value, OR
3. Extend `src/lib/cloud-tasks.ts` to take a separate `GCP_TASKS_SERVICE_ACCOUNT_KEY`.

For staging, re-using the Firebase service account is fine — it already has
Firestore admin and Cloud Tasks enqueuer.

## 6. Render environment variables

Add to both **staging** and **production** environments:

| Key | Value |
| --- | --- |
| `GCP_PROJECT_ID` | `<firebase-project-id>` |
| `GCP_LOCATION` | `us-central1` |
| `GCP_QUEUE_NAME` | `design-generation` (prod) / `design-generation-staging` (staging) |
| `GCP_SERVICE_ACCOUNT_EMAIL` | `cloud-tasks-invoker@<project>.iam.gserviceaccount.com` |
| `BACKEND_PUBLIC_URL` | Render public URL (e.g. `https://homedecorai-backend-pv3k.onrender.com`) |
| `INTERNAL_TASK_AUDIENCE` | `${BACKEND_PUBLIC_URL}/internal/process-generation` |
| `FCM_ENABLED` | `true` (flip to `false` to disable push without a code deploy) |
| `ALLOWED_AI_DOWNLOAD_HOSTS` | *(optional; defaults cover Replicate + fal.ai)* |

## 7. Smoke test

```bash
# Enqueue a dummy task against staging
gcloud tasks create-http-task \
  --queue="$QUEUE_NAME" \
  --location="$LOCATION" \
  --url="${BACKEND_URL}/internal/process-generation" \
  --method=POST \
  --header="Content-Type: application/json" \
  --body-content='{"generationId":"smoke-test-missing"}' \
  --oidc-service-account-email="$SA_EMAIL" \
  --oidc-token-audience="${BACKEND_URL}/internal/process-generation" \
  --project "$PROJECT_ID"
```

Expected: backend logs `processor.not_found` and acks with 200. The task
disappears from the queue. Any 4xx/5xx means OIDC verification or env
wiring is wrong — fix before continuing.

Then post a real generation via the iOS app or a manual `curl`:

```bash
curl -X POST "${BACKEND_URL}/api/design/interior" \
  -H "Authorization: Bearer <firebase-id-token>" \
  -H "User-Agent: HomeDecorAI/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "imageUrl": "https://example.com/test.jpg",
    "roomType": "livingRoom",
    "designStyle": "modern",
    "language": "tr"
  }'
```

Expected: `202 { "generationId": "...", "status": "queued" }` within 1 sec.
Firestore console shows the doc move queued → processing → completed. iOS
listener (or a manual Firestore read) mirrors the transitions.

## 8. Rollback

```bash
# Pause the queue — in-flight tasks finish, no new dispatches.
gcloud tasks queues pause "$QUEUE_NAME" \
  --location="$LOCATION" \
  --project "$PROJECT_ID"

# Resume
gcloud tasks queues resume "$QUEUE_NAME" \
  --location="$LOCATION" \
  --project "$PROJECT_ID"

# Nuclear option: purge everything
gcloud tasks queues purge "$QUEUE_NAME" \
  --location="$LOCATION" \
  --project "$PROJECT_ID"
```

Pairs well with flipping `FCM_ENABLED=false` on Render to silence push while
the queue is paused.

## 9. AWS S3 via Cognito (Firebase OIDC federation)

The backend S3 upload path (`src/lib/storage/s3-upload.ts`) holds **zero
static AWS credentials**. For every generation it mints per-user temporary
AWS credentials through the **same** Cognito Identity Pool iOS uses, with
the **same** Firebase OIDC federation scheme, and writes to S3 under
`generations/{cognitoIdentityId}/{generationId}.{ext}` using those temp
creds.

Because both clients federate the same Firebase ID token against the same
pool, a given Firebase user resolves to the *same* Cognito Identity ID from
iOS and from the backend. iOS uploads land under
`uploads/{sub}/…`; backend writes land under `generations/{sub}/…`; both
use the same `sub`.

### Why this design

1. **Zero static AWS credentials.** The only bootstrap secret the backend
   holds is `FIREBASE_SERVICE_ACCOUNT_KEY`, already required for Firestore
   and Firebase Auth. No IAM user, no access key rotation.
2. **Path consistency with iOS.** Same Firebase user → same Cognito Identity
   ID on both clients. GDPR export, account deletion, and audit trails join
   cleanly on a single identifier; no `MergeDeveloperIdentities` debt.
3. **Blast radius per request.** Each set of temp credentials is scoped by
   the IAM policy variable `${cognito-identity.amazonaws.com:sub}` — so even
   if the processor is compromised mid-call, the credential it holds can
   only write to one user's prefix, never the whole bucket.
4. **Auto-rotation.** Temp creds live 1 hour, refreshed automatically by the
   in-process cache in `cognito-credentials.ts`.

### How the backend obtains a Firebase ID token

The backend does **not** mint its own Firebase ID token. Instead the token
travels through the async pipeline as part of the Cloud Tasks payload:

1. iOS calls `Auth.auth().currentUser?.getIDToken(forcingRefresh: true)`
   before every enqueue. Force-refresh guarantees the token has the full
   ~60-minute lifetime ahead of it.
2. iOS sends the token in `Authorization: Bearer` on the enqueue request.
3. The enqueue endpoint's `authenticate` middleware verifies the token
   (`admin.auth().verifyIdToken`) and decorates `request.firebaseIdToken`
   with the raw string.
4. The controller packs `{ generationId, firebaseIdToken }` into the Cloud
   Tasks HTTP body. Cloud Tasks stores task bodies encrypted at rest and
   they never touch Firestore.
5. The internal processor receives the task, pre-flights the token's
   remaining lifetime (minimum 60 seconds), and feeds the token directly
   into the Cognito federation flow (`GetId` + `GetCredentialsForIdentity`
   with `Logins: { "securetoken.google.com/<projectId>": <token> }`).

**Token lifetime budget:**

| Stage | Elapsed | Remaining (worst case) |
| --- | --- | --- |
| iOS force-refresh | 0s | ~60 min |
| Enqueue → Cloud Tasks dispatch (incl. cold start) | ~30s | ~59 min |
| Processor first attempt (normal) | ~1 min | ~59 min |
| Processor after retry storm (3 retries, max backoff) | ~15 min | ~45 min |

The 60-second pre-flight threshold leaves a huge margin. If the token is
somehow closer to expiry (clock skew, catastrophic retry), the processor
fails fast with error code `TOKEN_EXPIRED` — Cloud Tasks is acked (no
retry), Firestore is marked failed, and the iOS listener recovers by
re-enqueueing with a fresh token.

**Never log the token.** Backend code must keep `firebaseIdToken` out of
structured log fields and error messages. Task payloads stay inside Cloud
Tasks and never surface in logs.

### Prerequisites

- An existing Cognito Identity Pool with Firebase token federation already
  configured (iOS is using it today — check the Firestore `settings/aws`
  document for `CognitoPoolId`).
- An existing CloudFront distribution fronting the same S3 bucket.

### One-time setup (per environment — staging and prod)

**Step 1 — Extend the existing Cognito authenticated role's IAM policy**

The role iOS already assumes via Firebase federation grants writes to
`uploads/${cognito-identity.amazonaws.com:sub}/*`. Add a second statement so
the same role also covers backend generation writes:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "IosUploadsPerUser",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::<bucket>/uploads/${cognito-identity.amazonaws.com:sub}/*"
    },
    {
      "Sid": "BackendGenerationsPerUser",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::<bucket>/generations/${cognito-identity.amazonaws.com:sub}/*"
    }
  ]
}
```

No new role, no new provider, no role mappings to reshuffle. Backend and iOS
assume the same role, differentiated only by S3 key prefix.

**Step 2 — Confirm the trust policy already allows Firebase federation**

The iOS path already works, so this should be a no-op. For reference, the
trust policy looks like this and must not be narrowed further:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "cognito-identity.amazonaws.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "cognito-identity.amazonaws.com:aud": "<IDENTITY_POOL_ID>",
          "cognito-identity.amazonaws.com:amr": "authenticated"
        }
      }
    }
  ]
}
```

**Step 3 — Set Render environment variables**

In addition to the Cloud Tasks vars documented above:

| Key | Value |
| --- | --- |
| `AWS_S3_BUCKET` | Bucket name (same bucket iOS uploads to) |
| `AWS_S3_REGION` | Bucket region |
| `AWS_CLOUDFRONT_HOST` | CloudFront host (same one iOS uses) |
| `COGNITO_IDENTITY_POOL_ID` | Format `<region>:<uuid>`, e.g. `us-east-1:abc-123-...` |

> No `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. No
> `COGNITO_DEVELOPER_PROVIDER_NAME`. No `FIREBASE_WEB_API_KEY`. If you see
> any of these in env, you're on a previous iteration of this design —
> delete them. The backend does not mint its own Firebase tokens; iOS
> force-refreshes on every enqueue and the token travels through the Cloud
> Tasks payload.

### SSRF allowlist — why iOS-uploaded URLs are NOT there

`ALLOWED_AI_DOWNLOAD_HOSTS` (env.ts) governs what hosts the backend will
**download from** when persisting AI outputs to S3. The iOS input photo URL
(CloudFront) is **not** in this list and does not need to be — the backend
never fetches it, it only forwards the URL to Replicate/fal.ai which then
fetches it themselves. Only the AI provider output URLs land in the
allowlist (replicate.delivery, pbxt.replicate.delivery, fal.media, v3.fal.media,
storage.googleapis.com).

### Path structure note (iOS integration)

iOS-uploaded inputs go to `uploads/{iOS-cognito-id}/…`.
Backend-written generations go to `generations/{backend-cognito-id}/…`.

These **may be different Cognito Identity IDs** for the same Firebase user,
because iOS federates via Firebase OIDC while the backend uses the developer
provider. This is fine: iOS never constructs generation paths — it reads
`outputImageUrl` (a CloudFront URL) directly from the Firestore listener.
CloudFront is path-agnostic so the same distribution serves both prefixes.

If a future requirement forces both to resolve to the **same** Cognito Identity
ID, use `cognito-identity:MergeDeveloperIdentities` to link the two. Not
required today.

### Operational notes

- **Credential cache** lives in process memory (`src/lib/storage/cognito-credentials.ts`).
  One entry per Firebase UID, refreshed when less than 5 minutes remain on the
  temp creds. Process restart forfeits the cache — first request per user
  after restart pays an extra ~200 ms Cognito round trip.
- **Metric to watch:** count of `cognito.credentials_minted` log events.
  A healthy steady state has this count roughly equal to the number of unique
  active users per hour. Unexpectedly high counts suggest the cache is being
  evicted (process crashes, container restarts, cold scale events).
- **Failure mode:** if Cognito rejects the dev token (rare — usually due to
  pool misconfiguration), the processor records `STORAGE_FAILED` on the
  generation and surfaces it to iOS via the Firestore listener. Rollback
  option: downgrade to direct static-IAM writes by temporarily reverting
  `src/lib/storage/s3-upload.ts` to use a plain `S3Client` with the bootstrap
  user's creds — but for that to work, the bootstrap user needs broader S3
  permissions, which defeats the point. Prefer fixing the pool.

## 10. Monitoring

- **Cloud Console → Cloud Tasks → Queue dashboard**: dispatch rate, max
  concurrent, attempt counts, 4xx/5xx rates.
- **Render logs**: search for `processor.ai.start`, `processor.storage.transient_failure`,
  `processor.request_retry`, `cloudtasks.enqueue_failed`.
- **Firestore**: a doc stuck in `processing` for more than ~15 minutes means
  the processor crashed mid-stage and Cloud Tasks exhausted retries before
  `markFailed` ran. Manual fix: update the doc to `failed` with
  `errorCode: "RETRY_EXHAUSTED"`.
