import { CloudTasksClient, protos } from "@google-cloud/tasks";
import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Cloud Tasks wrapper for the async generation pipeline.
 *
 * Design notes:
 * - In "create" mode the task name equals the generationId so Cloud Tasks
 *   performs submission-side dedup. If the enqueue endpoint is double-submitted
 *   by the client, the second submit hits ALREADY_EXISTS and we treat it as
 *   success.
 * - In "retry" mode the task name is OMITTED so Cloud Tasks auto-assigns one.
 *   The prior task's tombstone (Cloud Tasks retains completed/failed task
 *   records for ~1h) would otherwise block a same-name createTask, and our
 *   service account does not hold the `cloudtasks.tasks.delete` permission
 *   needed to clear it. Auto-naming sidesteps the collision entirely. Retry
 *   dedup is enforced upstream by the Firestore transaction in
 *   `retryFailedGeneration` — concurrent retries cannot both pass its
 *   status/staleness guard.
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

function getClient(projectId: string): CloudTasksClient {
  const cached = clientCache.get(projectId);
  if (cached) return cached;

  // Use the GCP service account from GOOGLE_APPLICATION_CREDENTIALS. The
  // credential JSON is decoded + validated at process boot in env.ts, so we
  // can read the parsed fields directly here.
  const creds = env.GOOGLE_APPLICATION_CREDENTIALS;
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

export type EnqueueGenerationTaskMode = "create" | "retry";

export interface EnqueueGenerationTaskInput {
  generationId: string;
  /**
   * `"create"` (default) — original enqueue from a wizard submit. Task name
   *   is set to the generationId so a client double-click on the enqueue
   *   endpoint hits ALREADY_EXISTS and is idempotently treated as success.
   * `"retry"` — user-initiated retry from a failed/orphaned doc. Task name
   *   is omitted so Cloud Tasks auto-assigns a unique one, sidestepping the
   *   1-hour tombstone collision that blocks a same-name createTask after
   *   the prior task reached a terminal state. Dedup on retry is enforced
   *   upstream by the Firestore transaction in `retryFailedGeneration`
   *   (concurrent retries can't both pass its status guard), so losing
   *   submission-side dedup here is not an additional risk. Avoiding a
   *   same-name reuse also means we do not need the
   *   `cloudtasks.tasks.delete` IAM permission, which our service account
   *   does not currently hold.
   */
  mode?: EnqueueGenerationTaskMode;
}

// gRPC status code returned by @google-cloud/tasks.
// https://grpc.github.io/grpc/core/md_doc_statuscodes.html
const GRPC_ALREADY_EXISTS = 6;

/**
 * Enqueue a task that will POST to the internal processor endpoint.
 *
 * In `"create"` mode the task is submitted with a deterministic name
 * (= generationId) so client double-clicks dedup at the Cloud Tasks
 * submission layer. In `"retry"` mode the name is omitted so every retry
 * becomes a fresh task, bypassing the tombstone collision entirely.
 *
 * Returns normally on success. Throws if Cloud Tasks rejects the submission
 * for any reason other than ALREADY_EXISTS in `"create"` mode (treated as
 * idempotent success).
 */
export async function enqueueGenerationTask(
  input: EnqueueGenerationTaskInput,
): Promise<void> {
  const projectId = env.GCP_PROJECT_ID;
  const client = getClient(projectId);
  const parent = queuePath(projectId);
  const url = `${env.BACKEND_PUBLIC_URL}${PROCESS_GENERATION_PATH}`;
  const mode: EnqueueGenerationTaskMode = input.mode ?? "create";

  const payload = JSON.stringify({
    generationId: input.generationId,
  });

  const task: protos.google.cloud.tasks.v2.ITask = {
    // `name` is only stamped in "create" mode. In "retry" mode we let
    // Cloud Tasks auto-assign the name so a same-id tombstone from the
    // prior run can't block this createTask.
    ...(mode === "create"
      ? { name: taskPath(projectId, input.generationId) }
      : {}),
    httpRequest: {
      httpMethod: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
      },
      body: Buffer.from(payload).toString("base64"),
      oidcToken: {
        serviceAccountEmail: env.GCP_SERVICE_ACCOUNT_EMAIL,
        audience: env.INTERNAL_TASK_AUDIENCE,
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
        mode,
        queue: env.GCP_QUEUE_NAME,
      },
      "Cloud Tasks enqueue succeeded",
    );
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === GRPC_ALREADY_EXISTS && mode === "create") {
      // Client double-clicked the wizard submit. The first task is still
      // pending and the processor will run it exactly once.
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
        mode,
        error: err instanceof Error ? err.message : String(err),
      },
      "Cloud Tasks enqueue failed",
    );
    throw err;
  }
}
