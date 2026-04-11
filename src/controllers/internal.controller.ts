import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { processGeneration } from "../services/generation-processor.js";

const BodySchema = z.object({
  generationId: z.string().min(1),
  firebaseIdToken: z.string().min(1),
});

/**
 * Cloud Tasks entry point for the async generation pipeline.
 *
 * Authentication is enforced by the `verifyCloudTask` preHandler (OIDC token
 * verification). When this handler runs, `request.cloudTask` is populated
 * with Cloud Tasks diagnostic headers.
 *
 * We override the raw socket timeout to 300s because AI generation + S3
 * upload can exceed the default Fastify request timeout of 120s. Cloud Tasks
 * dispatchDeadline is 600s, so we leave generous headroom.
 */
export async function processGenerationHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // Raise socket idle timeout for this specific request. Must happen before
  // any async work that could exceed the default 120s window.
  reply.raw.setTimeout(300_000);

  const parsed = BodySchema.safeParse(request.body);
  if (!parsed.success) {
    // Log only the paths of invalid fields — never the values, since one of
    // them is the Firebase ID token.
    request.log.warn(
      {
        event: "processor.bad_payload",
        issuePaths: parsed.error.issues.map((i) => i.path.join(".")),
      },
      "Internal processor received invalid payload",
    );
    reply.code(400);
    return { error: "Bad Request", message: "Invalid task payload" };
  }

  const { generationId, firebaseIdToken } = parsed.data;
  const retryCount = request.cloudTask?.retryCount ?? 0;

  try {
    const result = await processGeneration({
      generationId,
      firebaseIdToken,
      retryCount,
    });

    if (result.action === "retry") {
      request.log.warn(
        {
          event: "processor.request_retry",
          generationId,
          retryCount,
          reason: result.reason,
        },
        "Processor requesting Cloud Tasks retry",
      );
      reply.code(500);
      return {
        error: "Retry",
        message: result.reason,
      };
    }

    request.log.info(
      {
        event: "processor.done",
        generationId,
        retryCount,
        reason: result.reason,
      },
      "Processor finished",
    );
    reply.code(200);
    return { ok: true, reason: result.reason };
  } catch (err) {
    // Unhandled throw inside the processor. Cloud Tasks will retry; the next
    // attempt re-enters claimProcessing and the checkpoints carry progress.
    request.log.error(
      {
        event: "processor.unhandled_error",
        generationId,
        retryCount,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      "Processor threw — letting Cloud Tasks retry",
    );
    reply.code(500);
    return { error: "Internal Error", message: "Processor threw" };
  }
}
