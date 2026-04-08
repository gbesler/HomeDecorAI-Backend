import { buildInteriorDesignPrompt } from "./prompts.js";

interface ToolTypeConfig {
  models: {
    replicate: `${string}/${string}`;
    falai: string;
  };
  buildPrompt: (params: Record<string, string>) => string;
}

export const TOOL_TYPES = {
  interiorDesign: {
    models: {
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    buildPrompt: (params) =>
      buildInteriorDesignPrompt(params.roomType, params.designStyle),
  },
  // Future tools:
  // exteriorDesign: { ... },
  // gardenDesign: { ... },
  // objectRemoval: { ... },
} as const satisfies Record<string, ToolTypeConfig>;
