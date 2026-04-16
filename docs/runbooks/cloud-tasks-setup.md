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

## 9. AWS S3 via shared unauthenticated Cognito identity

The backend S3 upload path (`src/lib/storage/s3-upload.ts`) holds **zero
static AWS credentials**. It mints temporary AWS credentials through a single
**unauthenticated** Cognito identity (no Firebase federation, no Logins map)
and writes to S3 under `generations/{firebaseUid}/{generationId}.{ext}`.

The Firebase ID token is verified at the HTTP edge
(`src/middlewares/firebase-auth.ts` → `request.userId`) and never travels
further — not into the Cloud Tasks payload, not to Cognito.

### Why this design

1. **Zero static AWS credentials.** The only bootstrap secret the backend
   holds is `FIREBASE_SERVICE_ACCOUNT_KEY`, already required for Firestore
   and Firebase Auth. No IAM user, no access key rotation.
2. **Backend is already trusted.** Per-user federation only adds value when
   the credential consumer is the user's device. The backend already
   verifies the Firebase token at the edge — pushing it through Cognito
   again was duplicate work.
3. **Token never leaves the HTTP edge.** Removing the token from Cloud Tasks
   payloads removes it from the queue's at-rest storage and from the
   per-task retry budget (no more `TOKEN_EXPIRED` failures).
4. **Cache is process-local and shared.** A single in-memory credential
   serves every concurrent request. Cold starts pay ~200ms once.

### Trade-off accepted

Per-user IAM scoping (`generations/${cognito-identity.amazonaws.com:sub}/*`)
is gone. A compromised backend process can now write anywhere under
`generations/*`. Compensating control: per-user isolation lives in the S3
key path string (`generations/{firebaseUid}/...`) which is enforced by
application code, not IAM.

### Prerequisites

- A Cognito Identity Pool with **`AllowUnauthenticatedIdentities=true`**.
- A CloudFront distribution fronting the same S3 bucket.

### One-time setup (per environment)

**Step 1 — Configure the Cognito pool's UNAUTHENTICATED role**

Attach this IAM policy to the unauthenticated role linked to your identity
pool. The wildcard scope is intentional — the per-user prefix is enforced
by the backend, not IAM:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BackendGenerationsWrite",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::<bucket>/generations/*"
    }
  ]
}
```

> ⚠️ Attach this to the **unauthenticated** role, not the authenticated one.
> Cognito returns the unauthenticated role's credentials when GetId is
> called with no Logins map (the new flow). The authenticated role is still
> used by iOS via Firebase federation for `uploads/*`.

**Step 2 — Enable unauthenticated identities on the pool**

In the Cognito console: Identity Pool → Edit → check
"Enable access to unauthenticated identities". Without this, GetId throws
`NotAuthorizedException` and every backend S3 write fails.

**Step 3 — Set Render environment variables**

In addition to the Cloud Tasks vars documented above:

| Key | Value |
| --- | --- |
| `AWS_S3_BUCKET` | Bucket name (same bucket iOS uploads to) |
| `AWS_S3_REGION` | Bucket region |
| `AWS_CLOUDFRONT_HOST` | CloudFront host (same one iOS uses) |
| `AWS_COGNITO_IDENTITY_POOL_ID` | Format `<region>:<uuid>`, e.g. `us-east-1:abc-123-...` |

> No `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. No
> `COGNITO_DEVELOPER_PROVIDER_NAME`. No `FIREBASE_WEB_API_KEY`. The backend
> verifies Firebase tokens at the HTTP edge and uses Cognito unauthenticated.

### SSRF allowlist — why iOS-uploaded URLs are NOT there

`ALLOWED_AI_DOWNLOAD_HOSTS` (env.ts) governs what hosts the backend will
**download from** when persisting AI outputs to S3. The iOS input photo URL
(CloudFront) is **not** in this list and does not need to be — the backend
never fetches it, it only forwards the URL to Replicate/fal.ai which then
fetches it themselves. Only the AI provider output URLs land in the
allowlist (replicate.delivery, pbxt.replicate.delivery, fal.media, v3.fal.media,
storage.googleapis.com).

### Path structure note (iOS integration)

- iOS-uploaded inputs go to `uploads/{iOS-cognito-id}/…` (unchanged).
- Backend-written generations go to `generations/{firebaseUid}/…` (new).

iOS never reconstructs S3 keys — it reads `outputImageUrl` (a CloudFront URL)
directly from the Firestore listener. CloudFront is path-agnostic so the
same distribution serves both prefixes.

> Historical generations created before this refactor still live under
> `generations/{cognitoIdentityId}/…` keys. Their `outputImageUrl` fields
> point to the original CloudFront URLs and continue to resolve correctly.
> No migration required.

### Operational notes

- **Credential cache** lives in process memory
  (`src/lib/storage/cognito-credentials.ts`). A single shared credential
  refreshes when less than 5 minutes remain. Process restart forfeits the
  cache — first request after restart pays an extra ~200ms Cognito round
  trip. Concurrent cache misses are coalesced onto a single Cognito call.
- **Metric to watch:** count of `cognito.credentials_minted` log events.
  Steady state should be roughly one per hour per process. Higher counts
  suggest cold start churn or pool reconfiguration.
- **Failure mode:** if Cognito rejects the GetId call (pool misconfigured,
  unauthenticated identities disabled, IAM policy on wrong role), the
  processor logs `CognitoCredentialMintError` and Cloud Tasks retries up to
  the budget. Async generations end up `RETRY_EXHAUSTED`; sync generations
  fail immediately with `STORAGE_FAILED`. Check the operator steps above
  before debugging code.

## 10. Monitoring

- **Cloud Console → Cloud Tasks → Queue dashboard**: dispatch rate, max
  concurrent, attempt counts, 4xx/5xx rates.
- **Render logs**: search for `processor.ai.start`, `processor.storage.transient_failure`,
  `processor.request_retry`, `cloudtasks.enqueue_failed`.
- **Firestore**: a doc stuck in `processing` for more than ~15 minutes means
  the processor crashed mid-stage and Cloud Tasks exhausted retries before
  `markFailed` ran. Manual fix: update the doc to `failed` with
  `errorCode: "RETRY_EXHAUSTED"`.
