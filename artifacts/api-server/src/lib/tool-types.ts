import type { RoomType, DesignStyle } from "@workspace/api-zod";
import { buildInteriorDesignPrompt } from "./prompts.js";

interface InteriorDesignPromptParams {
  roomType: RoomType;
  designStyle: DesignStyle;
}

interface ToolTypeConfig<T = Record<string, string>> {
  models: {
    replicate: `${string}/${string}`;
    falai: string;
  };
  buildPrompt: (params: T) => string;
}

export const TOOL_TYPES = {
  interiorDesign: {
    models: {
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    buildPrompt: (params: InteriorDesignPromptParams) =>
      buildInteriorDesignPrompt(params.roomType, params.designStyle),
  } satisfies ToolTypeConfig<InteriorDesignPromptParams>,
};
