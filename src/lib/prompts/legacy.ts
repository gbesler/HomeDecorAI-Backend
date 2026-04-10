/**
 * Legacy interior design prompt builder — preserved behind the
 * `PROMPT_BUILDER_VERSION=legacy` safety valve (D17 F2).
 *
 * This is the original 41-line generic template from `src/lib/prompts.ts`,
 * wrapped to return the new `PromptResult` shape so the contract is uniform
 * across builder versions. If post-launch quality regresses after the v1
 * rewrite ships, operators flip the env var to `"legacy"` for a fast revert
 * without a code rollback.
 */

import type { PromptResult } from "./types.js";

const PROMPT_VERSION_LEGACY = "interiorDesign/legacy";

/**
 * Produce a `PromptResult` using the original single-template builder.
 *
 * `actionMode` and `guidanceBand` default to `"transform"` and `"balanced"`
 * since the legacy template does not carry that metadata. `positiveAvoidance`
 * is empty — the legacy template did not include an avoidance tail.
 */
export function buildInteriorPromptLegacy(params: {
  roomType: string;
  designStyle: string;
}): PromptResult {
  const room = humanize(params.roomType);
  const style = humanize(params.designStyle);

  const prompt =
    `Redesign this ${room} in a ${style} style. ` +
    `Keep the room's structural elements (walls, windows, doors) intact. ` +
    `Replace all furniture, decor, and accessories with items that match the ${style} aesthetic. ` +
    `Maintain the room's dimensions and layout while completely transforming the interior design. ` +
    `Photorealistic, high quality interior design photograph.`;

  return {
    prompt,
    positiveAvoidance: "",
    guidanceScale: 3.0, // Klein balanced band; Pruna ignores this at provider layer
    actionMode: "transform",
    guidanceBand: "balanced",
    promptVersion: PROMPT_VERSION_LEGACY,
  };
}

// ─── Humanize ───────────────────────────────────────────────────────────────

function humanize(camelCase: string): string {
  const specialCases: Record<string, string> = {
    midCentury: "mid-century modern",
    artDeco: "art deco",
    homeOffice: "home office",
    underStairSpace: "under-stair space",
    studyRoom: "study room",
    gamingRoom: "gaming room",
    diningRoom: "dining room",
  };

  if (specialCases[camelCase]) {
    return specialCases[camelCase];
  }

  return camelCase
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim();
}
