import { CloudTasksClient, protos } from "@google-cloud/tasks";
import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Cloud Tasks wrapper for the async generation pipeline.
 *
 * Design notes:
 * - Task name equals the generationId so Cloud Tasks performs submission-side
 *   dedup. If the enqueue endpoint is retried by the client, the second submit
 *   hits ALREADY_EXISTS and we treat it as success.
 * - Task payload carries only the generationId. The processor reads everything
 *   else from the Firestore record and uses shared Cognito credentials for S3.
 * - OIDC token audience must match what the receiver validates.
 * - dispatchDeadline is explicit (600s) to give the processor enough headroom
 *   for Render cold start + AI generation + S3 upload.
 */

// Keyed by projectId so a changed environment (hot reload, credentials
// rotation, test harness) cannot serve a stale client to the wrong project.
// In production the credentials are static and the map stays at size 1.
const clientCache = new Map<string, CloudTasksClient>();

/**
 * Assert that the async-pipeline env vars are configured. Called at the entry
 * of `enqueueGenerationTask`. While the temporary /sync endpoints are in use
 * these env vars are optional — invoking the async path without them is a
 * configuration error surfaced here rather than hiding as a null reference.
 *
 * Also fails fast when `GCP_PROJECT_ID` disagrees with the `project_id`
 * embedded in `GOOGLE_APPLICATION_CREDENTIALS`. Without this check the
 * Cloud Tasks client authenticates against the credentials' project while
 * `queuePath()` builds a resource name for `GCP_PROJECT_ID` — the resulting
 * PERMISSION_DENIED is opaque and hard to attribute to the env mismatch.
 */
function requireAsyncEnv(): {
  projectId: string;
  serviceAccountEmail: string;
  backendUrl: string;
  internalAudience: string;
} {
  const missing: string[] = [];
  if (!env.GCP_PROJECT_ID) missing.push("GCP_PROJECT_ID");
  if (!env.GCP_SERVICE_ACCOUNT_EMAIL) missing.push("GCP_SERVICE_ACCOUNT_EMAIL");
  if (!env.BACKEND_PUBLIC_URL) missing.push("BACKEND_PUBLIC_URL");
  if (!env.INTERNAL_TASK_AUDIENCE) missing.push("INTERNAL_TASK_AUDIENCE");
  if (!env.GOOGLE_APPLICATION_CREDENTIALS)
    missing.push("GOOGLE_APPLICATION_CREDENTIALS");
  if (missing.length > 0) {
    throw new Error(
      `Async Cloud Tasks pipeline is not configured. Missing env: ${missing.join(", ")}. ` +
        `Use the /sync endpoints for testing, or set these to enable async.`,
    );
  }

  const credsProjectId = env.GOOGLE_APPLICATION_CREDENTIALS![
    "project_id"
  ] as string;
  if (credsProjectId !== env.GCP_PROJECT_ID) {
    throw new Error(
      `GCP_PROJECT_ID ("${env.GCP_PROJECT_ID}") does not match ` +
        `GOOGLE_APPLICATION_CREDENTIALS.project_id ("${credsProjectId}"). ` +
        `Align the two env vars and restart — queue writes will PERMISSION_DENIED otherwise.`,
    );
  }

  return {
    projectId: env.GCP_PROJECT_ID!,
    serviceAccountEmail: env.GCP_SERVICE_ACCOUNT_EMAIL!,
    backendUrl: env.BACKEND_PUBLIC_URL!,
    internalAudience: env.INTERNAL_TASK_AUDIENCE!,
  };
}

function getClient(projectId: string): CloudTasksClient {
  const cached = clientCache.get(projectId);
  if (cached) return cached;

  // Use the GCP service account from GOOGLE_APPLICATION_CREDENTIALS. The
  // credential JSON is decoded + validated at process boot in env.ts, so we
  // can read the parsed fields directly here.
  const creds = env.GOOGLE_APPLICATION_CREDENTIALS!;
  const client = new CloudTasksClient({
    credentials: {
      client_email: creds["client_email"] as string,
      private_key: creds["private_key"] as string,
    },
    projectId,
  });
  clientCache.set(projectId, client);
  return client;
}

function queuePath(projectId: string): string {
  return `projects/${projectId}/locations/${env.GCP_LOCATION}/queues/${env.GCP_QUEUE_NAME}`;
}

function taskPath(projectId: string, generationId: string): string {
  return `${queuePath(projectId)}/tasks/${generationId}`;
}

const PROCESS_GENERATION_PATH = "/internal/process-generation";
const DISPATCH_DEADLINE_SECONDS = 600;

export interface EnqueueGenerationTaskInput {
  generationId: string;
}

/**
 * Enqueue a task that will POST to the internal processor endpoint.
 *
 * Returns normally on success. Throws if Cloud Tasks rejects the submission
 * for any reason other than ALREADY_EXISTS (which is treated as idempotent
 * success — the client retried an enqueue request that had already gone through).
 */
export async function enqueueGenerationTask(
  input: EnqueueGenerationTaskInput,
): Promise<void> {
  const asyncEnv = requireAsyncEnv();
  const client = getClient(asyncEnv.projectId);
  const parent = queuePath(asyncEnv.projectId);
  const name = taskPath(asyncEnv.projectId, input.generationId);
  const url = `${asyncEnv.backendUrl}${PROCESS_GENERATION_PATH}`;

  const payload = JSON.stringify({
    generationId: input.generationId,
  });

  const task: protos.google.cloud.tasks.v2.ITask = {
    name,
    httpRequest: {
      httpMethod: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
      },
      body: Buffer.from(payload).toString("base64"),
      oidcToken: {
        serviceAccountEmail: asyncEnv.serviceAccountEmail,
        audience: asyncEnv.internalAudience,
      },
    },
    dispatchDeadline: {
      seconds: DISPATCH_DEADLINE_SECONDS,
    },
  };

  try {
    await client.createTask({ parent, task });
    logger.info(
      {
        event: "cloudtasks.enqueued",
        generationId: input.generationId,
        queue: env.GCP_QUEUE_NAME,
      },
      "Cloud Tasks enqueue succeeded",
    );
  } catch (err) {
    // Cloud Tasks surfaces ALREADY_EXISTS (gRPC code 6) when a task with the
    // same name is re-submitted within the 1-hour tombstone window. Treat as
    // idempotent success — the generationId is already queued, and the
    // processor will still handle it exactly once.
    const code = (err as { code?: number }).code;
    if (code === 6) {
      logger.info(
        {
          event: "cloudtasks.already_exists",
          generationId: input.generationId,
        },
        "Cloud Tasks task already exists — treating as idempotent success",
      );
      return;
    }

    logger.error(
      {
        event: "cloudtasks.enqueue_failed",
        generationId: input.generationId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Cloud Tasks enqueue failed",
    );
    throw err;
  }
}
