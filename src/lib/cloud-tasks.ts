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
 * - Task payload carries the generationId plus the user's Firebase ID token.
 *   The processor uses the token to federate into Cognito with the exact same
 *   identity iOS uses, so backend writes and iOS uploads share the same
 *   Cognito Identity ID. The token must never be logged or persisted.
 * - OIDC token audience must match what the receiver validates.
 * - dispatchDeadline is explicit (600s) to give the processor enough headroom
 *   for Render cold start + AI generation + S3 upload.
 */

let cachedClient: CloudTasksClient | null = null;

function getClient(): CloudTasksClient {
  if (!cachedClient) {
    // Authenticate with the same Firebase service account credentials so that
    // staging/prod deployments don't need a separate credential file — the
    // service account just needs the cloudtasks.enqueuer + iam.serviceAccountUser
    // roles in addition to its existing Firebase roles.
    cachedClient = new CloudTasksClient({
      credentials: {
        client_email: env.FIREBASE_SERVICE_ACCOUNT_KEY["client_email"] as string,
        private_key: env.FIREBASE_SERVICE_ACCOUNT_KEY["private_key"] as string,
      },
      projectId: env.GCP_PROJECT_ID,
    });
  }
  return cachedClient;
}

function queuePath(): string {
  return `projects/${env.GCP_PROJECT_ID}/locations/${env.GCP_LOCATION}/queues/${env.GCP_QUEUE_NAME}`;
}

function taskPath(generationId: string): string {
  return `${queuePath()}/tasks/${generationId}`;
}

const PROCESS_GENERATION_PATH = "/internal/process-generation";
const DISPATCH_DEADLINE_SECONDS = 600;

export interface EnqueueGenerationTaskInput {
  generationId: string;
  /**
   * Raw Firebase ID token from the user's request. Travels through the task
   * payload to the processor, which feeds it into Cognito federation. Never
   * logged.
   */
  firebaseIdToken: string;
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
  const client = getClient();
  const parent = queuePath();
  const name = taskPath(input.generationId);
  const url = `${env.BACKEND_PUBLIC_URL}${PROCESS_GENERATION_PATH}`;

  const payload = JSON.stringify({
    generationId: input.generationId,
    firebaseIdToken: input.firebaseIdToken,
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
