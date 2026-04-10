import { callDesignGeneration } from "../lib/ai-providers";
import { TOOL_TYPES } from "../lib/tool-types.js";
import {
  createGeneration,
  updateGeneration,
  getGenerationsByUser,
  truncatePromptForPersistence,
  type GenerationDoc,
} from "../lib/firestore.js";
import { logger } from "../lib/logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GenerateInteriorDesignInput {
  userId: string;
  imageUrl: string;
  roomType: string;
  designStyle: string;
}

export interface GenerateInteriorDesignResult {
  id: string;
  outputImageUrl: string;
  provider: string;
  durationMs: number;
}

export type GenerationStatus = "pending" | "completed" | "failed";

export interface HistoryItem {
  id: string;
  toolType: string;
  roomType: string | null;
  designStyle: string | null;
  inputImageUrl: string;
  outputImageUrl: string | null;
  status: GenerationStatus;
  provider: string;
  durationMs: number | null;
  createdAt: string | null;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// ─── Interior Design Generation ─────────────────────────────────────────────

export async function generateInteriorDesign(
  input: GenerateInteriorDesignInput,
): Promise<GenerateInteriorDesignResult> {
  const { userId, imageUrl, roomType, designStyle } = input;

  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new ValidationError("imageUrl must use http or https scheme");
  }

  const toolConfig = TOOL_TYPES.interiorDesign;
  const promptResult = toolConfig.buildPrompt({ roomType, designStyle });

  logger.info(
    {
      event: "generation.start",
      userId,
      roomType,
      designStyle,
      actionMode: promptResult.actionMode,
      guidanceBand: promptResult.guidanceBand,
      promptVersion: promptResult.promptVersion,
    },
    "Starting interior design generation",
  );

  const persistedPrompt = truncatePromptForPersistence(promptResult.prompt);

  const generationId = await createGeneration({
    userId,
    toolType: "interiorDesign",
    roomType,
    designStyle,
    inputImageUrl: imageUrl,
    outputImageUrl: null,
    prompt: persistedPrompt,
    actionMode: promptResult.actionMode,
    guidanceBand: promptResult.guidanceBand,
    promptVersion: promptResult.promptVersion,
    provider: "pending",
    status: "pending",
    errorMessage: null,
    durationMs: null,
  });

  try {
    const result = await callDesignGeneration(toolConfig.models, {
      prompt: promptResult.prompt,
      imageUrl,
      guidanceScale: promptResult.guidanceScale,
    });

    await updateGeneration(generationId, {
      outputImageUrl: result.imageUrl,
      provider: result.provider,
      status: "completed",
      durationMs: result.durationMs,
    });

    return {
      id: generationId,
      outputImageUrl: result.imageUrl,
      provider: result.provider,
      durationMs: result.durationMs,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    await updateGeneration(generationId, {
      status: "failed",
      errorMessage: errorMessage.slice(0, 500),
    }).catch((firestoreError) => {
      logger.error(
        { generationId, error: firestoreError instanceof Error ? firestoreError.message : String(firestoreError) },
        "Failed to update generation status to failed — record may be stuck in pending",
      );
    });

    throw error;
  }
}

// ─── Generation History ─────────────────────────────────────────────────────

export async function getDesignHistory(
  userId: string,
  limit: number,
): Promise<HistoryItem[]> {
  const docs = await getGenerationsByUser(userId, limit);

  return docs.map((doc) => ({
    id: doc.id,
    toolType: doc.toolType,
    roomType: doc.roomType,
    designStyle: doc.designStyle,
    inputImageUrl: doc.inputImageUrl,
    outputImageUrl: doc.outputImageUrl,
    status: doc.status,
    provider: doc.provider,
    durationMs: doc.durationMs,
    createdAt: doc.createdAt?.toDate().toISOString() ?? null,
  }));
}
