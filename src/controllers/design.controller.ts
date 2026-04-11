import { randomUUID } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CreateInteriorDesignBody,
  GenerationHistoryItem,
  GenerationHistoryResponse,
} from "../schemas";
import { getDesignHistory } from "../services/design.service.js";
import {
  createQueuedGeneration,
  markEnqueueFailed,
} from "../lib/firestore.js";
import { enqueueGenerationTask } from "../lib/cloud-tasks.js";
import { resolveLanguage } from "../lib/notifications/i18n.js";
import type { SupportedLanguage } from "../lib/generation/types.js";

// ─── Language resolution ────────────────────────────────────────────────────

const LanguageField = z.enum(["tr", "en"]).optional();

/**
 * Derive the user's UI language for a generation from (in order):
 *  1. Explicit `language` field in the request body (zod-validated upstream).
 *  2. The first primary language tag in the `Accept-Language` header.
 *  3. Fallback `"en"`.
 */
function resolveGenerationLanguage(
  bodyLanguage: SupportedLanguage | undefined,
  acceptLanguageHeader: string | undefined,
): SupportedLanguage {
  if (bodyLanguage) return bodyLanguage;
  if (acceptLanguageHeader && acceptLanguageHeader.length > 0) {
    // Accept-Language can be `tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7` — take the
    // first tag and let resolveLanguage handle `tr-TR` → `tr`.
    const firstTag = acceptLanguageHeader.split(",")[0]?.trim();
    if (firstTag) return resolveLanguage(firstTag);
  }
  return "en";
}

// ─── POST /interior ─────────────────────────────────────────────────────────

/**
 * Enqueue an interior design generation job.
 *
 * Returns 202 Accepted with a generationId. The caller subscribes to the
 * Firestore document at `generations/{generationId}` to track status, and
 * optionally receives an FCM push when the terminal state is reached.
 *
 * Hard cutover: the previous synchronous response shape is no longer returned.
 */
export async function createInteriorDesign(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  const firebaseIdToken = request.firebaseIdToken;
  if (!userId || !firebaseIdToken) {
    reply.code(401);
    return { error: "Unauthorized", message: "Authentication required" };
  }

  const BodySchema = CreateInteriorDesignBody.extend({
    language: LanguageField,
  });

  const parsed = BodySchema.safeParse(request.body);
  if (!parsed.success) {
    reply.code(400);
    return {
      error: "Validation Error",
      message: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(", "),
    };
  }

  const { imageUrl, roomType, designStyle, language: bodyLanguage } = parsed.data;

  if (!/^https?:\/\//i.test(imageUrl)) {
    reply.code(400);
    return {
      error: "Validation Error",
      message: "imageUrl must use http or https scheme",
    };
  }

  const acceptLanguageHeader =
    typeof request.headers["accept-language"] === "string"
      ? request.headers["accept-language"]
      : undefined;

  const language = resolveGenerationLanguage(bodyLanguage, acceptLanguageHeader);
  const generationId = randomUUID();

  // Create Firestore record first. If Cloud Tasks enqueue subsequently fails,
  // we update the same record to failed(ENQUEUE_FAILED) so there is no
  // orphaned task and the client listener surfaces the error immediately.
  try {
    await createQueuedGeneration({
      generationId,
      userId,
      toolType: "interiorDesign",
      roomType,
      designStyle,
      inputImageUrl: imageUrl,
      language,
    });
  } catch (err) {
    request.log.error(
      {
        event: "generation.firestore_create_failed",
        userId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to create queued generation record",
    );
    reply.code(500);
    return {
      error: "Internal Error",
      message: "Failed to queue generation. Please try again.",
    };
  }

  try {
    await enqueueGenerationTask({ generationId, firebaseIdToken });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    request.log.error(
      {
        event: "generation.enqueue_failed",
        generationId,
        userId,
        error: errorMessage,
      },
      "Cloud Tasks enqueue failed — marking generation failed",
    );
    await markEnqueueFailed(generationId, errorMessage).catch((firestoreErr) => {
      request.log.error(
        {
          generationId,
          error:
            firestoreErr instanceof Error
              ? firestoreErr.message
              : String(firestoreErr),
        },
        "Failed to mark generation as enqueue_failed — record may be stuck in queued",
      );
    });
    reply.code(503);
    return {
      error: "Service Unavailable",
      message: "Failed to enqueue generation. Please try again.",
    };
  }

  request.log.info(
    {
      event: "generation.enqueued",
      generationId,
      userId,
      roomType,
      designStyle,
      language,
    },
    "Generation queued",
  );

  reply.code(202);
  return {
    generationId,
    status: "queued" as const,
  };
}

// ─── GET /history ───────────────────────────────────────────────────────────

const limitSchema = z.coerce.number().int().min(1).max(100);

export async function getHistory(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) {
    reply.code(401);
    return { error: "Unauthorized", message: "Authentication required" };
  }

  const query = request.query as Record<string, unknown>;
  const limitResult = limitSchema.safeParse(query.limit);
  let limit: number;
  if (query.limit === undefined || query.limit === null) {
    limit = 50;
  } else if (!limitResult.success) {
    reply.code(400);
    return {
      error: "Validation Error",
      message: "limit must be an integer between 1 and 100",
    };
  } else {
    limit = limitResult.data;
  }

  try {
    const generations = await getDesignHistory(userId, limit);

    // Filter out items that don't match the schema instead of failing entirely.
    const validGenerations = generations.filter((item) =>
      GenerationHistoryItem.safeParse(item).success,
    );

    return GenerationHistoryResponse.parse({ generations: validGenerations });
  } catch (error) {
    request.log.error(
      { userId, error: error instanceof Error ? error.message : String(error) },
      "Failed to fetch generation history",
    );
    reply.code(500);
    return {
      error: "Internal Error",
      message: "Failed to fetch generation history.",
    };
  }
}
