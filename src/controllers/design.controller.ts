import { randomUUID } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
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
import { TOOL_TYPES, type ToolTypeConfig } from "../lib/tool-types.js";

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
    const firstTag = acceptLanguageHeader.split(",")[0]?.trim();
    if (firstTag) return resolveLanguage(firstTag);
  }
  return "en";
}

function validateImageUrlScheme(
  imageUrl: unknown,
): { ok: true } | { ok: false; message: string } {
  if (typeof imageUrl !== "string" || !/^https?:\/\//i.test(imageUrl)) {
    return {
      ok: false,
      message: "imageUrl must use http or https scheme",
    };
  }
  return { ok: true };
}

// ─── Generic enqueue handler factory ────────────────────────────────────────

/**
 * Build a Fastify POST handler for a tool. The factory closes over a
 * `ToolTypeConfig` entry so a single implementation serves every tool in
 * the registry — interior, exterior, garden, and any future tool that
 * registers itself.
 *
 * Flow:
 *  1. Auth check (userId + firebaseIdToken on the request)
 *  2. Parse + validate body via `tool.bodySchema.extend({ language })`
 *  3. Validate imageUrl scheme (http/https only)
 *  4. Resolve language (body → Accept-Language → "en")
 *  5. Project validated body via `tool.toToolParams`, mirroring legacy
 *     top-level `roomType`/`designStyle` for interior so the iOS history
 *     listener stays compatible.
 *  6. Create queued Firestore record
 *  7. Enqueue Cloud Tasks job; roll back the record if enqueue fails
 *  8. Return 202 `{ generationId, status: "queued" }`
 */
export function makeCreateGenerationHandler<TParams>(
  tool: ToolTypeConfig<TParams>,
) {
  const BodySchema = tool.bodySchema.and(
    z.object({ language: LanguageField }),
  );

  return async function createGeneration(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const userId = request.userId;
    const firebaseIdToken = request.firebaseIdToken;
    if (!userId || !firebaseIdToken) {
      reply.code(401);
      return { error: "Unauthorized", message: "Authentication required" };
    }

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

    const body = parsed.data as TParams & { language?: SupportedLanguage };
    const { language: bodyLanguage, ...toolBody } = body as Record<
      string,
      unknown
    > & { language?: SupportedLanguage };

    const imageUrlCheck = validateImageUrlScheme(
      (toolBody as { imageUrl?: unknown }).imageUrl,
    );
    if (!imageUrlCheck.ok) {
      reply.code(400);
      return {
        error: "Validation Error",
        message: imageUrlCheck.message,
      };
    }

    const imageUrl = (toolBody as { imageUrl: string }).imageUrl;

    const acceptLanguageHeader =
      typeof request.headers["accept-language"] === "string"
        ? request.headers["accept-language"]
        : undefined;

    const language = resolveGenerationLanguage(
      bodyLanguage,
      acceptLanguageHeader,
    );
    const generationId = randomUUID();

    // Tool-specific projection. The processor will round-trip this back via
    // `tool.fromToolParams` — it never touches tool-specific fields directly.
    const toolParams = tool.toToolParams(parsed.data as TParams);

    // Legacy interior top-level mirror: only interiorDesign populates these
    // so the iOS history view continues to read them for existing docs.
    const legacyRoomType =
      tool.toolKey === "interiorDesign"
        ? ((toolParams["roomType"] as string | undefined) ?? null)
        : null;
    const legacyDesignStyle =
      tool.toolKey === "interiorDesign"
        ? ((toolParams["designStyle"] as string | undefined) ?? null)
        : null;

    try {
      await createQueuedGeneration({
        generationId,
        userId,
        toolType: tool.toolKey,
        roomType: legacyRoomType,
        designStyle: legacyDesignStyle,
        toolParams,
        inputImageUrl: imageUrl,
        language,
      });
    } catch (err) {
      request.log.error(
        {
          event: "generation.firestore_create_failed",
          toolType: tool.toolKey,
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
          toolType: tool.toolKey,
          userId,
          error: errorMessage,
        },
        "Cloud Tasks enqueue failed — marking generation failed",
      );
      await markEnqueueFailed(generationId, errorMessage).catch(
        (firestoreErr) => {
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
        },
      );
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
        toolType: tool.toolKey,
        userId,
        toolParams,
        language,
      },
      "Generation queued",
    );

    reply.code(202);
    return {
      generationId,
      status: "queued" as const,
    };
  };
}

// ─── Pre-built interior handler (kept as named export for callers/tests) ──

export const createInteriorDesign = makeCreateGenerationHandler(
  TOOL_TYPES.interiorDesign,
);

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
