---
date: 2026-04-15
topic: backend-s3-auth-setup
status: superseded-by-implementation
---

# Backend S3 Auth Setup (Cognito + Firebase OIDC)

> **⚠️ Superseded — read `docs/runbooks/cloud-tasks-setup.md` Section 9 for
> the authoritative operator steps.**
>
> Implementation diverged from R1–R6 below. Instead of keeping per-user
> Firebase OIDC federation, the backend now uses a **single shared
> unauthenticated Cognito identity** (no Logins map). Operator changes:
>
> - **R3 should target the UNAUTHENTICATED role**, not the authenticated
>   role. Attaching the policy to the wrong role causes 100% S3 write
>   failure post-deploy.
> - The Cognito pool must have `AllowUnauthenticatedIdentities=true`.
> - **R6 was not honored**: `cognitoIdentityId` was dropped from the
>   Firestore generation doc. CloudTrail-to-Firebase cross-reference is no
>   longer possible via the doc; accepted as a deliberate trade-off because
>   the new shared identity makes CloudTrail attribution coarse-grained
>   regardless.
> - **TOKEN_EXPIRED** failure mode no longer exists; the Firebase token is
>   verified at the HTTP edge only and never travels through Cloud Tasks.
>
> The original requirements below are preserved for historical context.

## Problem Frame

`POST /api/design/interior/sync` (and every other generation endpoint) fails
during the S3 upload stage with:

```
Cognito GetId failed: Identity pool - us-east-1:88c05e2d-91af-402e-9629-e0d107bc12d7
does not have identity providers configured.
```

Root cause, verified against both `src/lib/storage/cognito-credentials.ts` and
AWS docs: the backend calls `Cognito.GetId` with a Firebase OIDC `Logins` map,
but the Cognito Identity Pool in AWS has no authentication providers
configured. The code path works — the infrastructure is missing. Until S3
upload succeeds, **no design tool (sync or async) can complete end-to-end.**

A secondary issue surfaced during the brainstorm: backend and iOS use
different S3 key formats (`generations/<cognitoIdentityId>/…` vs
`uploads/<firebaseUid>/…`). The code comment in `cognito-credentials.ts:13`
claims they share the same Cognito Identity ID "so S3 paths stay consistent
across both clients," which the code does not actually implement. iOS has
never exercised the S3 upload path today (`settings/aws` Firestore doc is
absent), so this divergence has not yet caused runtime errors — but leaving
the false claim in-code misleads future reviewers and will block per-user
IAM scoping if that work is ever picked up.

Why this matters now: sync endpoints were introduced for manual tool testing
(see `2026-04-15-001-feat-sync-tool-endpoints` work). Every test attempt
today hits the Cognito wall. Unblocking tests and unblocking the real
generation pipeline are the same task.

## Requirements

### AWS infrastructure (no code changes, console work)

- R1. Register Firebase as an IAM OIDC identity provider.
  - Provider URL: `https://securetoken.google.com/homedecorai-f12b7`
  - Audience: `homedecorai-f12b7`
  - Verified as required per AWS docs: the Cognito Identity Pool custom OIDC
    provider must reference an existing IAM OIDC identity provider.

- R2. Add the Firebase OIDC provider to Cognito Identity Pool
  `us-east-1:88c05e2d-91af-402e-9629-e0d107bc12d7` under the **User access**
  tab → **Add identity provider** → **OpenID Connect (OIDC)**.

- R3. Attach an IAM policy to the Cognito authenticated role that grants
  `s3:PutObject` on the bucket identified by the `AWS_S3_BUCKET` env var,
  covering both `uploads/*` and `generations/*` prefixes.

### Backend code alignment

- R4. Change the backend S3 key format in
  `src/lib/storage/s3-upload.ts:158` from
  `generations/${cognitoIdentityId}/${generationId}.${ext}` to
  `generations/${firebaseUid}/${generationId}.${ext}` so backend writes and
  iOS uploads share a common `<firebaseUid>` identity namespace.

- R5. Replace the code comment blocks at
  `src/lib/storage/cognito-credentials.ts:9-17` **and**
  `src/lib/storage/s3-upload.ts:18-21` with an accurate description of the
  chosen model: (a) `GetId` returns a Cognito Identity ID distinct from the
  Firebase UID, (b) S3 keys use the Firebase UID as the user segment, (c)
  the IAM policy grants bucket-wide `s3:PutObject` on the two prefixes
  (no per-user path isolation at the IAM layer), (d) `cognitoIdentityId`
  is preserved on the Firestore generation doc as an audit field. The
  s3-upload.ts block currently claims "IAM policy … restricts writes to
  generations/${cognito-identity.amazonaws.com:sub}/*" — that claim is
  also incorrect under R3 and must be removed.

- R6. Keep `cognitoIdentityId` on the Firestore generation doc
  (`src/lib/generation/types.ts:107`) as an audit/debug field. Do not drop
  it — it's the only way to cross-reference an S3 CloudTrail event back to
  a Firebase user given CloudTrail's Cognito-side identifier.

## Success Criteria

- A Swagger `POST /api/design/interior/sync` request with a valid Firebase
  ID token returns HTTP 200 with an `outputImageUrl` (CloudFront-fronted
  when `AWS_CLOUDFRONT_HOST` is set, native S3 URL otherwise — the existing
  code in `src/lib/storage/s3-upload.ts:182-184` already handles both).
- The AI output file lands at `s3://<bucket>/generations/<firebaseUid>/<generationId>.jpg`.
- No Cognito-related errors in Render logs for a week of normal async +
  sync traffic.
- Code review on this branch no longer carries a "symmetric Cognito ID"
  claim that the code does not implement.

## Scope Boundaries

- **iOS AWS config** — iOS's `settings/aws` Firestore document is still
  absent (`Failed to fetch AWS config: Document 'aws' not found`), meaning
  iOS has never actually uploaded to S3 yet. Populating that doc and
  exercising iOS uploads is separate work.
- **Per-user IAM path isolation** — an IAM policy that restricts each
  authenticated user to `generations/<their-own-id>/*` via
  `${cognito-identity.amazonaws.com:sub}` is a worthwhile future
  hardening, but incompatible with the Firebase-UID key format without
  additional STS session tagging. Deliberately deferred.
- **Migration of existing images** — no production generations exist yet,
  so no backfill or dual-read concerns.
- **Alternative architectures** — AssumeRoleWithWebIdentity (Cognito-less
  STS) and static backend IAM user + iOS presigned URLs were considered
  and rejected in favor of keeping the existing Cognito design intact.

## Key Decisions

- **Keep Cognito Identity Pool + Firebase OIDC federation.** Preserves
  "zero static AWS credentials in backend" and matches the mental model iOS
  already implements. Ruled out simpler alternatives (static IAM user,
  direct STS) to avoid a larger refactor while sync testing is active.
- **Align backend path format to Firebase UID (not Cognito Identity ID).**
  iOS already uses Firebase UID in `uploads/<firebaseUid>/…`. Aligning the
  backend to match keeps the `<firebaseUid>` identity as the single
  cross-surface join key and avoids a larger iOS refactor.
- **Trade per-user IAM policy isolation for simpler key format.** Using
  `${cognito-identity.amazonaws.com:sub}` policy variables would re-require
  the Cognito ID in the path. Chose bucket-level write permission on the
  two prefixes instead. **Known consequence:** every authenticated user's
  temporary credentials can write to any key under `uploads/*` and
  `generations/*`, not just their own prefix. Path correctness is enforced
  only at the backend before upload; there is no AWS-side cross-tenant
  write prevention until per-user IAM scoping is picked up (see scope
  boundaries). This deferral is covered in the Review Findings section
  below and needs an explicit acceptance decision, not a silent trade-off.

## Dependencies / Assumptions

- AWS Console access with IAM + Cognito admin permissions.
- Firebase project ID `homedecorai-f12b7` (verified from
  `GoogleService-Info.plist`).
- Cognito Identity Pool `us-east-1:88c05e2d-91af-402e-9629-e0d107bc12d7`
  already exists (verified: Render env `AWS_COGNITO_IDENTITY_POOL_ID`).
- `AWS_S3_BUCKET` and `AWS_S3_REGION` already set on Render.
- The Identity Pool's authenticated role exists (Cognito creates a default
  one on pool creation). If it doesn't, create it with a standard
  `cognito-identity.amazonaws.com` web identity trust policy.

## Outstanding Questions

### Deferred to Planning

- [Affects R3][Technical] IAM policy shape for the authenticated role —
  single `PutObject` statement with two `Resource` ARNs, vs a wildcard
  `generations/*` + `uploads/*`, vs a more restrictive condition. Planning
  should write the concrete JSON and verify against the Cognito auth role
  that was created with the pool.
- [Affects R4][Technical] Callers of `persistGenerationImage` — do any
  code paths derive the S3 key elsewhere? Planning should grep for
  `cognitoIdentityId` usage outside this function.
- [Affects R6][Needs research] Does iOS history view consume
  `cognitoIdentityId` from the generation doc in any way? If not, the
  field is purely audit and can stay unused in responses.

## Review Findings (Open for Decision)

Document review (2026-04-15, 5 personas) surfaced the following items that
need explicit user judgment before planning. Auto-fixes have been applied
inline; the items below require product/security decisions.

**RF1 — Architecture challenge: presigned URLs vs Cognito federation.**
Both `product-lens` (F2/F7) and `security-lens` (SEC-001) argued that a
backend-issued presigned URL approach would preserve the "client never
sees AWS creds" property while (a) eliminating R1+R2 infrastructure,
(b) resolving the lateral-write vulnerability by construction (each URL
scoped to one key), (c) simplifying the iOS integration. The original
decision to keep Cognito rested partly on "matches iOS mental model" —
but iOS has never actually exercised the Cognito path. This option
deserves a deliberate yes/no from the user, not dismissal.

**RF2 — Lateral-write vulnerability under R3.**
`security-lens` (SEC-001/005) and `product-lens` (F3): the R3 IAM policy
grants `s3:PutObject` on `uploads/*` and `generations/*` without any
path constraint. Any authenticated Firebase user's temporary credentials
can overwrite any other user's object. "Application-layer enforcement"
is the only barrier. At zero users this is abstract; at launch it is a
real attack vector. Options: (a) accept the risk with S3 versioning +
object-key randomization as compensating controls, (b) implement
per-user IAM scoping now via session tags, (c) switch to presigned URLs
(RF1) which bypass the issue entirely.

**RF3 — Authenticated role existence is an unresolved branch.**
`adversarial` (F4) + `feasibility` (F3): the doc hedges with "If the
role doesn't exist, create it" but does not specify the trust policy
JSON or verification step. An unconfigured pool (as evidenced by the
current Cognito error) may also have an unconfigured role. The plan
needs an explicit pre-check and a create-if-missing path before R3.

**RF4 — R4 vs R6 audit-chain semantics.**
`coherence` (F4) + `adversarial` (F1): R6 justifies keeping
`cognitoIdentityId` for CloudTrail cross-reference, but R4 removes it
from the S3 key. After R4 the cross-reference requires a Firestore
lookup by `cognitoIdentityId` — not a direct path-to-user mapping.
Either accept the extra indirection explicitly in R6 or drop the audit
rationale.

**RF5 — R3 `uploads/*` grant is unexplained at this time.**
`feasibility` (F4): the scope boundaries defer iOS AWS config, but
R3 grants S3 write on the `uploads/*` prefix anyway. No current code
path produces that prefix server-side. Either remove `uploads/*` from
R3 until iOS work is picked up, or document that the grant is
deliberate forward-compat.

**RF6 — Multi-environment story.**
`adversarial` (F5): R1 hardcodes the Firebase project ID
(`homedecorai-f12b7`). Each environment (dev, staging, prod) will need
its own IAM OIDC provider and its own Cognito Identity Pool. The doc
treats R1-R3 as one-time; consider whether a follow-up plan should
codify the per-env setup.

**RF7 — Success criterion "no Cognito errors for a week" is weakly
falsifiable.** `product-lens` (F6) + `adversarial` (F6): the criterion
cannot distinguish "fix worked" from "no traffic hit the path" from
"TOKEN_EXPIRED noise masking real Cognito failures." Replace with a
positive assertion: "At least 10 successful `storage.upload.ok` log
events from distinct users within the first week."

## Rejected Reviewer Claim

One feasibility finding was **dismissed** after verification:
`feasibility` F1 argued R1 (IAM OIDC provider) is redundant because
Cognito Identity Pools validate tokens themselves. This is incorrect:
AWS docs ([Cognito OIDC provider](https://docs.aws.amazon.com/cognito/latest/developerguide/open-id.html))
explicitly require "Choose an OIDC identity provider from the IAM IdPs
in your AWS account" when adding an OIDC provider to an Identity Pool.
R1 stays.

## Next Steps

→ Resolve RF1 (presigned URL reconsideration) first — if the user
pivots, R1-R3 are discarded and a different requirements doc replaces
this one. If the user confirms Cognito, address RF2-RF7, then
`/ce:plan` for structured implementation planning.
