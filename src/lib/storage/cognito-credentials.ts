import {
  CognitoIdentityClient,
  GetCredentialsForIdentityCommand,
  GetIdCommand,
} from "@aws-sdk/client-cognito-identity";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Per-user AWS credential provider backed by Cognito Identity Pool with
 * **Firebase OIDC federation**, using the exact same federation scheme iOS
 * uses. Backend and iOS share the same Cognito Identity ID for the same
 * Firebase user, so S3 paths stay consistent across both clients.
 *
 * Unlike a symmetric admin-side flow, this module does **not** mint its own
 * Firebase ID token. The token arrives with every async-pipeline job,
 * originally produced by the iOS client, verified on enqueue, and passed
 * through the Cloud Tasks payload. The processor runs an expiry pre-flight
 * before calling into this module, so by the time we federate we have at
 * least ~60s of remaining token lifetime.
 *
 * Flow per unique Firebase UID (on cache miss, ~200ms):
 *   1. cognito-identity:GetId
 *      - Logins: { "securetoken.google.com/<projectId>": firebaseIdToken }
 *      - deterministic: same Firebase UID always resolves to the same
 *        Cognito IdentityId
 *      - called with an *unsigned* Cognito client; GetId accepts unauth callers
 *   2. cognito-identity:GetCredentialsForIdentity
 *      - same Logins map
 *      - returns 1-hour AWS temp credentials scoped by the Cognito
 *        authenticated role, whose IAM policy uses
 *        `${cognito-identity.amazonaws.com:sub}` variables to restrict writes
 *        to this user's own S3 prefix.
 *
 * The resulting credentials are cached in memory per Firebase UID and
 * refreshed when their remaining lifetime falls below the refresh window.
 * On cache hit the incoming Firebase token is not touched — the STS creds
 * themselves are what matter once minted.
 *
 * Security posture:
 * - **Zero static AWS credentials** in the backend. The only bootstrap
 *   secret is `FIREBASE_SERVICE_ACCOUNT_KEY`, already required for
 *   Firestore and Firebase Auth.
 * - The Firebase ID token is a short-lived user credential — never log it,
 *   never persist it to Firestore, never include it in error messages.
 * - The credential cache lives in process memory only and auto-expires
 *   with the Cognito credential lifetime.
 */

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // refresh when < 5 min remains
const DEFAULT_FALLBACK_LIFETIME_MS = 55 * 60 * 1000; // used only if Expiration is missing

interface CachedCredentials {
  identityId: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: number; // epoch ms
}

export interface UserAwsCredentials {
  identityId: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export class CognitoCredentialMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CognitoCredentialMintError";
  }
}

const cache = new Map<string, CachedCredentials>();

let cachedClient: CognitoIdentityClient | null = null;

/**
 * Unsigned Cognito client. `GetId` and `GetCredentialsForIdentity` are both
 * public-accessible APIs when called with a valid Logins map — they do not
 * need AWS SigV4 credentials. Passing anonymous credentials keeps the SDK
 * from attempting to locate keys in the environment.
 */
function getClient(): CognitoIdentityClient {
  if (!cachedClient) {
    cachedClient = new CognitoIdentityClient({
      region: env.AWS_S3_REGION,
      credentials: async () => ({
        accessKeyId: "",
        secretAccessKey: "",
      }),
    });
  }
  return cachedClient;
}

/**
 * Mint (or return cached) AWS temporary credentials for a specific Firebase
 * user, federating via a Firebase ID token produced on the iOS client.
 *
 * The returned credentials carry a Cognito Identity ID that's safe to use in
 * S3 key paths — IAM policy variables restrict writes to the matching prefix
 * at the AWS level.
 *
 * The caller is expected to have already pre-flighted the token's remaining
 * lifetime. If the token is expired, Cognito will reject it and this
 * function throws `CognitoCredentialMintError`; the processor turns that
 * into a `TOKEN_EXPIRED` failure so the client can retry.
 */
export async function getUserAwsCredentials(
  firebaseUid: string,
  firebaseIdToken: string,
): Promise<UserAwsCredentials> {
  const cached = cache.get(firebaseUid);
  if (cached && cached.expiresAt - Date.now() > REFRESH_THRESHOLD_MS) {
    return {
      identityId: cached.identityId,
      accessKeyId: cached.accessKeyId,
      secretAccessKey: cached.secretAccessKey,
      sessionToken: cached.sessionToken,
    };
  }

  const projectId = (
    env.FIREBASE_SERVICE_ACCOUNT_KEY as { project_id: string }
  ).project_id;
  const providerKey = `securetoken.google.com/${projectId}`;

  const client = getClient();

  // Step 1: resolve the Cognito Identity ID for this federated token.
  const getIdResp = await client
    .send(
      new GetIdCommand({
        IdentityPoolId: env.AWS_COGNITO_IDENTITY_POOL_ID,
        Logins: { [providerKey]: firebaseIdToken },
      }),
    )
    .catch((err: unknown) => {
      throw new CognitoCredentialMintError(
        `Cognito GetId failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  if (!getIdResp.IdentityId) {
    throw new CognitoCredentialMintError("Cognito GetId returned no IdentityId");
  }

  // Step 2: exchange the federated token for AWS temp credentials scoped by
  // the Cognito authenticated role. Policy variables in that role's IAM
  // policy restrict writes to `generations/<identityId>/*`.
  const credsResp = await client
    .send(
      new GetCredentialsForIdentityCommand({
        IdentityId: getIdResp.IdentityId,
        Logins: { [providerKey]: firebaseIdToken },
      }),
    )
    .catch((err: unknown) => {
      throw new CognitoCredentialMintError(
        `Cognito GetCredentialsForIdentity failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  const creds = credsResp.Credentials;
  if (!creds || !creds.AccessKeyId || !creds.SecretKey || !creds.SessionToken) {
    throw new CognitoCredentialMintError(
      "Cognito GetCredentialsForIdentity returned incomplete credentials",
    );
  }

  const expiresAt =
    creds.Expiration instanceof Date
      ? creds.Expiration.getTime()
      : Date.now() + DEFAULT_FALLBACK_LIFETIME_MS;

  const entry: CachedCredentials = {
    identityId: getIdResp.IdentityId,
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretKey,
    sessionToken: creds.SessionToken,
    expiresAt,
  };
  cache.set(firebaseUid, entry);

  logger.info(
    {
      event: "cognito.credentials_minted",
      firebaseUid,
      identityId: getIdResp.IdentityId,
      expiresInMinutes: Math.round((expiresAt - Date.now()) / 60_000),
    },
    "Minted per-user AWS credentials via Cognito Firebase federation",
  );

  return {
    identityId: entry.identityId,
    accessKeyId: entry.accessKeyId,
    secretAccessKey: entry.secretAccessKey,
    sessionToken: entry.sessionToken,
  };
}

/**
 * Clear a user's cached credentials. Call on forced invalidation (e.g. when
 * a PutObject returns 403, signalling that the policy has changed or the
 * identity has been deleted).
 */
export function invalidateUserAwsCredentials(firebaseUid: string): void {
  cache.delete(firebaseUid);
}
