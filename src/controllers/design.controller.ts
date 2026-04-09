import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CreateInteriorDesignBody,
  GenerationHistoryItem,
  GenerationHistoryResponse,
} from "../schemas";
import {
  generateInteriorDesign,
  getDesignHistory,
  ValidationError,
} from "../services/design.service.js";

// ─── POST /interior ─────────────────────────────────────────────────────────

export async function createInteriorDesign(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const userId = request.userId;
  if (!userId) {
    reply.code(401);
    return { error: "Unauthorized", message: "Authentication required" };
  }

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
    if (error instanceof ValidationError) {
      reply.code(400);
      return { error: "Validation Error", message: error.message };
    }

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

    // Filter out items that don't match the schema instead of failing entirely
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
