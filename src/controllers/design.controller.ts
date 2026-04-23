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
  retryFailedGeneration,
} from "../lib/firestore.js";
import { enqueueGenerationTask } from "../lib/cloud-tasks.js";
import { processGeneration } from "../services/generation-processor.js";
import { resolveLanguage } from "../lib/notifications/i18n.js";
import type { SupportedLanguage } from "../lib/generation/types.js";
import { TOOL_TYPES, type ToolTypeConfig } from "../lib/tool-types.js";
import { env } from "../lib/env.js";

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

// Hosts our iOS clients upload to directly via Cognito-minted credentials.
// Computed once at module load — env is frozen by the zod parse in env.ts.
// Kept broad enough to cover the two S3 URL styles (virtual-hosted and
// path-style) plus CloudFront, so a signed-URL rewrite on the iOS side
// doesn't break the check.
const CLIENT_UPLOAD_HOSTS: readonly string[] = (() => {
  const hosts = new Set<string>();
  hosts.add(
    `${env.AWS_S3_BUCKET}.s3.${env.AWS_S3_REGION}.amazonaws.com`.toLowerCase(),
  );
  hosts.add(`${env.AWS_S3_BUCKET}.s3.amazonaws.com`.toLowerCase());
  hosts.add(`s3.${env.AWS_S3_REGION}.amazonaws.com`.toLowerCase());
  if (env.AWS_CLOUDFRONT_HOST) {
    hosts.add(env.AWS_CLOUDFRONT_HOST.toLowerCase());
  }
  return Array.from(hosts);
})();

// Stricter check layered ON TOP of `validateImageUrlScheme` for tools whose
// input URLs must have been produced by the iOS direct-upload flow. Blocks
// the "attacker POSTs an arbitrary URL to Remove Objects and has Replicate
// fetch it" class of abuse. Only applied to tools that declare
// `clientUploadFields` in their registry entry.
function validateClientUploadHost(
  imageUrl: unknown,
  fieldName: string,
): { ok: true } | { ok: false; message: string } {
  if (typeof imageUrl !== "string") {
    return { ok: false, message: `${fieldName} must be a string` };
  }
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return { ok: false, message: `${fieldName} is not a valid URL` };
  }
  const host = parsed.hostname.toLowerCase();
  if (!CLIENT_UPLOAD_HOSTS.includes(host)) {
    return {
      ok: false,
      message: `${fieldName} host is not an allowed client-upload origin`,
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
 *  1. Auth check (userId on the request)
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
    if (!userId) {
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
    // Client-upload host enforcement. Only runs for tools that opt in via
    // `clientUploadFields`; the fields are validated even when listed as
    // optional elsewhere, because presence alone (not scheme alone) was
    // already the gap reviewers flagged.
    for (const field of tool.clientUploadFields ?? []) {
      if (bodyRecord[field] === undefined) continue;
      const check = validateClientUploadHost(bodyRecord[field], field);
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
      await enqueueGenerationTask({ generationId });
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
    if (!userId) {
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
    for (const field of tool.clientUploadFields ?? []) {
      if (bodyRecord[field] === undefined) continue;
      const check = validateClientUploadHost(bodyRecord[field], field);
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
      const errorMessage = err instanceof Error ? err.message : String(err);
      request.log.error(
        {
          event: "generation.sync.processor_threw",
          generationId,
          error: errorMessage,
        },
        "Sync processor threw unexpectedly",
      );
      // Force the doc to a terminal state so the iOS listener settles and
      // history is not polluted with stuck queued/processing records. The
      // error handler for markFailed is best-effort — a double-failure is
      // logged but does not override the outer 500 we already decided to
      // return.
      await markFailed(generationId, "AI_PROVIDER_FAILED", errorMessage).catch(
        (firestoreErr) =>
          request.log.error(
            {
              generationId,
              error:
                firestoreErr instanceof Error
                  ? firestoreErr.message
                  : String(firestoreErr),
            },
            "Failed to mark sync generation as failed after processor throw — doc may be stuck",
          ),
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

    // Defensive guard: the happy path below assumes a populated outputImageUrl
    // alongside a `completed` status. If processGeneration returned action:"ok"
    // but the doc is still non-terminal, surface the inconsistency explicitly
    // rather than handing the client a 200 with a null image URL.
    if (finalDoc.status !== "completed" || !finalDoc.outputImageUrl) {
      request.log.error(
        {
          event: "generation.sync.unexpected_state",
          generationId,
          status: finalDoc.status,
          hasOutputImageUrl: Boolean(finalDoc.outputImageUrl),
        },
        "Sync generation reached handler end in unexpected state",
      );
      reply.code(500);
      return {
        error: "Internal Error",
        message: `Unexpected terminal state: ${finalDoc.status}`,
        generationId,
      };
    }

    reply.code(200);
    return {
      generationId,
      status: "completed" as const,
      outputImageUrl: finalDoc.outputImageUrl,
      outputImageCDNUrl: finalDoc.outputImageCDNUrl,
      provider: finalDoc.provider,
      durationMs: finalDoc.durationMs,
      toolType: finalDoc.toolType,
    };
  };
}

// ─── POST /generations/:id/retry ────────────────────────────────────────────

/**
 * Retry a terminally-failed generation in place. Preserves `generationId`
 * so the iOS detail screen's Firestore listener updates the open document
 * (failed → queued → processing → completed) instead of having to navigate
 * to a brand-new record. Does NOT consume freemium — a failed generation
 * never debited the user's meter in the first place, and the UI explicitly
 * advertises the retry as free.
 *
 * Distinct from the regular enqueue handler: no body, no prompt builder,
 * no rate-limit on the tool key. The only caller is the Failed detail
 * surface, which already gates behind auth. Rate-limiting retries would
 * give a frustrating "try again" → "rate limited" loop — the gate is
 * already "must own a failed doc to retry".
 */
export async function retryGeneration(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) {
    reply.code(401);
    return { error: "Unauthorized", message: "Authentication required" };
  }

  const params = request.params as Record<string, unknown>;
  const generationId =
    typeof params["id"] === "string" ? params["id"] : undefined;
  if (!generationId || generationId.length === 0) {
    reply.code(400);
    return {
      error: "Validation Error",
      message: "generationId path parameter is required",
    };
  }

  const result = await retryFailedGeneration(generationId, userId);
  if (result.kind === "not_found") {
    reply.code(404);
    return {
      error: "Not Found",
      message: "Generation record not found",
    };
  }
  if (result.kind === "forbidden") {
    // Deliberately mirrors "not found" externally so owner-probing a
    // sibling's id returns the same shape as a missing record. Internally
    // the log captures the userId mismatch for audit.
    request.log.warn(
      { event: "generation.retry.forbidden", generationId, userId },
      "Retry attempted on a generation owned by a different user",
    );
    reply.code(404);
    return {
      error: "Not Found",
      message: "Generation record not found",
    };
  }
  if (result.kind === "already_done") {
    reply.code(409);
    return {
      error: "Conflict",
      message: "Generation already completed — nothing to retry",
    };
  }
  if (result.kind === "already_live") {
    reply.code(409);
    return {
      error: "Conflict",
      message: `Generation is ${result.status} — wait for it to finish`,
    };
  }

  // result.kind === "reset"
  try {
    await enqueueGenerationTask({ generationId, mode: "retry" });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    request.log.error(
      {
        event: "generation.retry.enqueue_failed",
        generationId,
        userId,
        error: errorMessage,
      },
      "Cloud Tasks enqueue failed after retry reset — marking failed again",
    );
    // Best-effort: roll the doc back to failed so the user can try again.
    // A stuck-in-queued retry would be invisible to the user (no loading
    // timeout on the iOS listener for retried jobs).
    await markEnqueueFailed(generationId, errorMessage).catch((firestoreErr) => {
      request.log.error(
        {
          generationId,
          error:
            firestoreErr instanceof Error
              ? firestoreErr.message
              : String(firestoreErr),
        },
        "Failed to roll retry back to failed state",
      );
    });
    reply.code(503);
    return {
      error: "Service Unavailable",
      message: "Failed to enqueue retry. Please try again.",
    };
  }

  request.log.info(
    { event: "generation.retry.enqueued", generationId, userId },
    "Generation retry enqueued",
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
