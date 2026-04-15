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
  getGenerationById,
  markEnqueueFailed,
  markFailed,
} from "../lib/firestore.js";
import { enqueueGenerationTask } from "../lib/cloud-tasks.js";
import { processGeneration } from "../services/generation-processor.js";
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

// SSRF guard for user-supplied image URLs that the backend forwards to
// external AI providers. We reject hostnames that resolve to the IPv4
// link-local metadata range, RFC-1918 private networks, loopback, the
// "0.0.0.0" any-address, and explicit `localhost` literals before the URL
// is ever sent to Replicate / fal.ai. Provider workers that fetch the URL
// run in cloud datacenters where these ranges typically reach internal
// metadata services (e.g. AWS IMDSv1 at 169.254.169.254). DNS-based
// rebinding attacks are out of scope here — the provider performs its own
// fetch, so DNS resolution happens in the provider's network namespace.
const PRIVATE_HOST_RE =
  /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|localhost$|::1$|fc[0-9a-f][0-9a-f]:|fe80:|172\.(?:1[6-9]|2[0-9]|3[01])\.)/i;

function validateImageUrlScheme(
  imageUrl: unknown,
  fieldName: string,
): { ok: true } | { ok: false; message: string } {
  if (typeof imageUrl !== "string" || !/^https?:\/\//i.test(imageUrl)) {
    return {
      ok: false,
      message: `${fieldName} must use http or https scheme`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return { ok: false, message: `${fieldName} is not a valid URL` };
  }
  const host = parsed.hostname.toLowerCase();
  if (PRIVATE_HOST_RE.test(host)) {
    return {
      ok: false,
      message: `${fieldName} resolves to a disallowed host range`,
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

    // Validate every image URL field declared by the tool. The first field
    // of `imageUrlFields` is the canonical input image written to
    // `inputImageUrl`; any remaining fields (e.g. reference-style's
    // `referenceImageUrl`) live in toolParams and are forwarded to the
    // provider. `optionalImageUrlFields` is validated only when the field
    // is actually present (e.g. paint-walls customStyle-with-reference).
    //
    // Type contract: `imageUrlFields` is a non-empty tuple of `keyof TParams`,
    // so the [0] index is always present and field names are compile-time
    // checked against the body schema.
    const bodyRecord = toolBody as Record<string, unknown>;
    for (const field of tool.imageUrlFields) {
      const check = validateImageUrlScheme(bodyRecord[field], field);
      if (!check.ok) {
        reply.code(400);
        return {
          error: "Validation Error",
          message: check.message,
        };
      }
    }
    for (const field of tool.optionalImageUrlFields ?? []) {
      if (bodyRecord[field] === undefined) continue;
      const check = validateImageUrlScheme(bodyRecord[field], field);
      if (!check.ok) {
        reply.code(400);
        return {
          error: "Validation Error",
          message: check.message,
        };
      }
    }

    const primaryImageField = tool.imageUrlFields[0];
    const imageUrl = bodyRecord[primaryImageField] as string;

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
    // Pass `toolBody` (language stripped) so the persisted blob does not
    // duplicate the language column written separately on the doc.
    const toolParams = tool.toToolParams(toolBody as TParams);

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

// ─── TEMPORARY: Sync generation handler factory ────────────────────────────

/**
 * Temporary sync variant of {@link makeCreateGenerationHandler}. Runs the full
 * async pipeline (validation → Firestore queued → AI → S3 → Firestore completed)
 * inline on the request thread and returns 200 with the final `outputImageUrl`.
 *
 * Exists only to unblock manual testing of tool features without the Cloud
 * Tasks round trip and 30–60s loading-window pad. The async enqueue handler,
 * Cloud Tasks pipeline, and iOS Firestore listener flow remain the canonical
 * path — this sync variant shares their code paths but skips the queue.
 *
 * To remove: delete this function, remove the sync route registration in
 * `src/routes/design.ts`, and drop the `skipLoadingPad` parameter on
 * `processGeneration`.
 */
export function makeSyncGenerationHandler<TParams>(
  tool: ToolTypeConfig<TParams>,
) {
  const BodySchema = tool.bodySchema.and(
    z.object({ language: LanguageField }),
  );

  return async function createGenerationSync(
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

    const bodyRecord = toolBody as Record<string, unknown>;
    for (const field of tool.imageUrlFields) {
      const check = validateImageUrlScheme(bodyRecord[field], field);
      if (!check.ok) {
        reply.code(400);
        return { error: "Validation Error", message: check.message };
      }
    }
    for (const field of tool.optionalImageUrlFields ?? []) {
      if (bodyRecord[field] === undefined) continue;
      const check = validateImageUrlScheme(bodyRecord[field], field);
      if (!check.ok) {
        reply.code(400);
        return { error: "Validation Error", message: check.message };
      }
    }

    const primaryImageField = tool.imageUrlFields[0];
    const imageUrl = bodyRecord[primaryImageField] as string;

    const acceptLanguageHeader =
      typeof request.headers["accept-language"] === "string"
        ? request.headers["accept-language"]
        : undefined;

    const language = resolveGenerationLanguage(
      bodyLanguage,
      acceptLanguageHeader,
    );
    const generationId = randomUUID();

    const toolParams = tool.toToolParams(toolBody as TParams);

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
          event: "generation.sync.firestore_create_failed",
          toolType: tool.toolKey,
          userId,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to create queued generation record (sync path)",
      );
      reply.code(500);
      return {
        error: "Internal Error",
        message: "Failed to create generation record. Please try again.",
      };
    }

    request.log.info(
      {
        event: "generation.sync.start",
        generationId,
        toolType: tool.toolKey,
        userId,
        toolParams,
        language,
      },
      "Sync generation started",
    );

    try {
      const result = await processGeneration({
        generationId,
        firebaseIdToken,
        retryCount: 0,
        skipLoadingPad: true,
      });

      if (result.action === "retry") {
        // Sync path has no retry mechanism — promote transient storage
        // failures to a terminal fail so the doc does not linger in `processing`.
        await markFailed(
          generationId,
          "STORAGE_FAILED",
          "Transient storage error in sync mode (no retry)",
        ).catch((e) =>
          request.log.error(
            { generationId, error: e instanceof Error ? e.message : String(e) },
            "Failed to mark sync generation as failed after storage retry",
          ),
        );
        reply.code(502);
        return {
          generationId,
          status: "failed" as const,
          errorCode: "STORAGE_FAILED" as const,
          errorMessage: "Storage upload failed",
        };
      }
    } catch (err) {
      request.log.error(
        {
          event: "generation.sync.processor_threw",
          generationId,
          error: err instanceof Error ? err.message : String(err),
        },
        "Sync processor threw unexpectedly",
      );
      reply.code(500);
      return {
        error: "Internal Error",
        message: "Sync generation failed",
        generationId,
      };
    }

    const finalDoc = await getGenerationById(generationId);
    if (!finalDoc) {
      request.log.error(
        { event: "generation.sync.doc_missing", generationId },
        "Generation doc missing after sync processing",
      );
      reply.code(500);
      return {
        error: "Internal Error",
        message: "Generation record missing after processing",
        generationId,
      };
    }

    if (finalDoc.status === "failed") {
      reply.code(502);
      return {
        generationId,
        status: "failed" as const,
        errorCode: finalDoc.errorCode ?? ("AI_PROVIDER_FAILED" as const),
        errorMessage: finalDoc.errorMessage ?? "Generation failed",
      };
    }

    reply.code(200);
    return {
      generationId,
      status: "completed" as const,
      outputImageUrl: finalDoc.outputImageUrl,
      provider: finalDoc.provider,
      durationMs: finalDoc.durationMs,
      toolType: finalDoc.toolType,
    };
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
