import { env } from "./env.js";
import { buildInteriorPromptLegacy } from "./prompts/legacy.js";
import {
  buildInteriorPrompt,
  type InteriorParams,
} from "./prompts/tools/interior-design.js";
import type { PromptResult } from "./prompts/types.js";

export type { InteriorParams };

/**
 * Tool registry entry shape. Generic over the parameter type and return
 * shape so future tools (VirtualStaging with `referenceImageUrl`, Garden
 * Design with `seasonHint`, etc.) can extend `PromptResult` without breaking
 * the registry or the provider call path (which reads only the base fields).
 */
export interface ToolTypeConfig<
  TParams = Record<string, string>,
  TResult extends PromptResult = PromptResult,
> {
  models: {
    replicate: `${string}/${string}`;
    falai: string;
  };
  buildPrompt: (params: TParams) => TResult;
}

/**
 * Dispatches interior design prompt building to either the v1 modular
 * builder or the legacy wrapper, based on the `PROMPT_BUILDER_VERSION`
 * env var. This is the D17 F2 runtime rollback safety valve.
 */
function buildInteriorPromptDispatch(params: InteriorParams): PromptResult {
  if (env.PROMPT_BUILDER_VERSION === "legacy") {
    return buildInteriorPromptLegacy(params);
  }
  return buildInteriorPrompt(params);
}

export const TOOL_TYPES = {
  interiorDesign: {
    models: {
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    buildPrompt: buildInteriorPromptDispatch,
  },
  // Future tools plug in here. Each entry is a `ToolTypeConfig<TParams, TResult>`.
  // exteriorDesign: { ... },
  // virtualStaging: { ... },
} as const satisfies Record<string, ToolTypeConfig<InteriorParams, PromptResult>>;
