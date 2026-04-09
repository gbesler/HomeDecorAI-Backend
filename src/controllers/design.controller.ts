import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CreateInteriorDesignBody,
  GenerationHistoryResponse,
} from "../schemas";
import {
  validateImageUrl,
  generateInteriorDesign,
  getDesignHistory,
} from "../services/design.service.js";

// ─── POST /interior ─────────────────────────────────────────────────────────

export async function createInteriorDesign(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const parsed = CreateInteriorDesignBody.safeParse(request.body);
  if (!parsed.success) {
    reply.code(400);
    return {
      error: "Validation Error",
      message: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(", "),
    };
  }

  const { imageUrl, roomType, designStyle } = parsed.data;
  const userId = request.userId!;

  const validationError = validateImageUrl(imageUrl);
  if (validationError) {
    reply.code(400);
    return { error: "Validation Error", message: validationError };
  }

  request.log.info(
    { userId, roomType, designStyle },
    "Processing interior design request",
  );

  try {
    const result = await generateInteriorDesign({
      userId,
      imageUrl,
      roomType,
      designStyle,
    });

    request.log.info(
      {
        generationId: result.id,
        provider: result.provider,
        durationMs: result.durationMs,
      },
      "Interior design generation completed",
    );

    return result;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const isTimeout = errorMessage.includes("timeout");

    request.log.error(
      {
        userId,
        errorType: isTimeout ? "TIMEOUT" : "API_ERROR",
        error: errorMessage,
      },
      "Interior design generation failed",
    );

    reply.code(500);
    return {
      error: "Generation Failed",
      message: "Failed to generate interior design. Please try again.",
    };
  }
}

// ─── GET /history ───────────────────────────────────────────────────────────

const limitSchema = z.coerce.number().int().min(1).max(100).default(50);

export async function getHistory(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId!;
  const query = request.query as Record<string, unknown>;
  const limitResult = limitSchema.safeParse(query.limit ?? undefined);
  const limit = limitResult.success ? limitResult.data : 50;

  try {
    const generations = await getDesignHistory(userId, limit);
    return GenerationHistoryResponse.parse({ generations });
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
