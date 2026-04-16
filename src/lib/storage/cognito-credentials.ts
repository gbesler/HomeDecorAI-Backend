import {
  CognitoIdentityClient,
  GetCredentialsForIdentityCommand,
  GetIdCommand,
} from "@aws-sdk/client-cognito-identity";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Shared AWS credential provider backed by a single unauthenticated Cognito
 * identity. The backend is already a trusted service (Firebase ID tokens are
 * verified at the HTTP edge), so per-user federation adds cost without
 * meaningful isolation. All S3 writes share one Cognito identity; per-user
 * isolation lives in the S3 key path (`generations/{firebaseUid}/...`).
 *
 * Flow (on cache miss, ~200ms):
 *   1. cognito-identity:GetId        — no Logins map, unauthenticated
 *   2. cognito-identity:GetCredentialsForIdentity — returns ~1h temp creds
 *
 * The unauthenticated Cognito role's IAM policy must allow s3:PutObject on
 * `generations/*` in the target bucket.
 */

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_FALLBACK_LIFETIME_MS = 55 * 60 * 1000;

interface CachedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: number;
}

export interface AwsCredentials {
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

let cached: CachedCredentials | null = null;
let inflight: Promise<AwsCredentials> | null = null;

let cachedClient: CognitoIdentityClient | null = null;

function getClient(): CognitoIdentityClient {
  if (!cachedClient) {
    cachedClient = new CognitoIdentityClient({
      region: env.AWS_S3_REGION,
      credentials: async () => ({
        accessKeyId: "",
        secretAccessKey: "",
      }),
      // Bound mint() so a hung Cognito endpoint cannot pin the inflight
      // promise indefinitely and stall every concurrent uploader.
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 3_000,
        socketTimeout: 5_000,
      }),
    });
  }
  return cachedClient;
}

/**
 * Mint (or return cached) shared unauthenticated AWS temporary credentials.
 * Coalesces concurrent cache misses onto a single Cognito round trip.
 */
export async function getAwsCredentials(): Promise<AwsCredentials> {
  if (cached && cached.expiresAt - Date.now() > REFRESH_THRESHOLD_MS) {
    return {
      accessKeyId: cached.accessKeyId,
      secretAccessKey: cached.secretAccessKey,
      sessionToken: cached.sessionToken,
    };
  }

  if (inflight) return inflight;

  inflight = mint().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function mint(): Promise<AwsCredentials> {
  const client = getClient();

  const getIdResp = await client
    .send(
      new GetIdCommand({
        IdentityPoolId: env.AWS_COGNITO_IDENTITY_POOL_ID,
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

  const credsResp = await client
    .send(
      new GetCredentialsForIdentityCommand({
        IdentityId: getIdResp.IdentityId,
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

  cached = {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretKey,
    sessionToken: creds.SessionToken,
    expiresAt,
  };

  logger.info(
    {
      event: "cognito.credentials_minted",
      expiresInMinutes: Math.round((expiresAt - Date.now()) / 60_000),
    },
    "Minted shared AWS credentials via unauthenticated Cognito identity",
  );

  return {
    accessKeyId: cached.accessKeyId,
    secretAccessKey: cached.secretAccessKey,
    sessionToken: cached.sessionToken,
  };
}
