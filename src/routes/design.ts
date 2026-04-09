import type { FastifyPluginAsync } from "fastify";
import { CreateInteriorDesignBody } from "../schemas/index.js";
import { createRateLimitPreHandler } from "../lib/rate-limiter.js";
import { callDesignGeneration } from "../lib/ai-providers/index.js";
import { TOOL_TYPES } from "../lib/tool-types.js";
import { createGeneration, updateGeneration } from "../lib/firestore.js";
import { downloadAndUploadToS3 } from "../lib/storage.js";

const designRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/interior",
    {
      preHandler: [
        app.authenticate,
        createRateLimitPreHandler("interiorDesign"),
      ],
    },
    async (request, reply) => {
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
      const toolConfig = TOOL_TYPES.interiorDesign;

      // Validate imageUrl scheme to prevent SSRF
      if (!/^https?:\/\//i.test(imageUrl)) {
        reply.code(400);
        return {
          error: "Validation Error",
          message: "imageUrl must use http or https scheme",
        };
      }

      const prompt = toolConfig.buildPrompt({ roomType, designStyle });

      // Create pending generation record in Firestore
      let generationId: string;
      try {
        generationId = await createGeneration({
          userId,
          toolType: "interiorDesign",
          roomType,
          designStyle,
          inputImageUrl: imageUrl,
          outputImageUrl: null,
          prompt,
          provider: "pending",
          status: "pending",
          errorMessage: null,
          durationMs: null,
        });
      } catch (error) {
        request.log.error(
          { userId, error: error instanceof Error ? error.message : String(error) },
          "Failed to create generation record in Firestore",
        );
        reply.code(503);
        return {
          error: "Service Unavailable",
          message: "Unable to initialize generation. Please try again.",
        };
      }

      request.log.info(
        { userId, generationId, roomType, designStyle },
        "Processing interior design request",
      );

      try {
        const result = await callDesignGeneration(toolConfig.models, {
          prompt,
          imageUrl,
        });

        // Download generated image from provider CDN and upload to S3
        const s3Url = await downloadAndUploadToS3(result.imageUrl, {
          folder: "generations",
          userId,
        });

        await updateGeneration(generationId, {
          outputImageUrl: s3Url,
          provider: result.provider,
          status: "completed",
          durationMs: result.durationMs,
        });

        request.log.info(
          {
            generationId,
            provider: result.provider,
            durationMs: result.durationMs,
          },
          "Interior design generation completed",
        );

        return {
          id: generationId,
          outputImageUrl: s3Url,
          provider: result.provider,
          durationMs: result.durationMs,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const isTimeout = errorMessage.includes("timeout");

        request.log.error(
          {
            generationId,
            userId,
            errorType: isTimeout ? "TIMEOUT" : "API_ERROR",
            error: errorMessage,
          },
          "Interior design generation failed",
        );

        try {
          await updateGeneration(generationId, {
            status: "failed",
            errorMessage: errorMessage.slice(0, 500),
          });
        } catch (updateErr) {
          request.log.error(
            { generationId, error: updateErr instanceof Error ? updateErr.message : String(updateErr) },
            "Failed to update generation status in Firestore",
          );
        }

        reply.code(500);
        return {
          error: "Generation Failed",
          message: "Failed to generate interior design. Please try again.",
        };
      }
    },
  );
};

export default designRoutes;
