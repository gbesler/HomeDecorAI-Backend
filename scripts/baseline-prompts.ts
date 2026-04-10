/**
 * U1 — Phase 0 Baseline & Cheap-Fix A/B Harness
 *
 * Per plan docs/plans/2026-04-10-001-refactor-interior-prompt-system-plan.md Unit 1.
 *
 * Runs two prompt variants against the same {style × room} combinations using
 * the primary provider (Replicate / Pruna p-image-edit) so Yusuf can label
 * outputs by failure mode and decide whether the cheap fix is sufficient or
 * the full R1–R7 rewrite is warranted.
 *
 * Run:
 *   npm run baseline:prompts
 *
 * Requires valid REPLICATE_API_TOKEN in .env.
 *
 * Outputs:
 *   docs/research/2026-04-10-prompt-baseline-findings.md
 *
 * Cost estimate: ~60 generations at $0.01–0.05 each = ~$0.60–3.00 total.
 */

import Replicate from "replicate";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "../src/lib/env.js";
import { logger } from "../src/lib/logger.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const REPLICATE_MODEL = "prunaai/p-image-edit" as const;
const OUTPUT_PATH = "docs/research/2026-04-10-prompt-baseline-findings.md";
const TIMEOUT_MS = 60_000;

/**
 * Test room photos. Stable public URLs — replace with your own S3 fixtures
 * or Unsplash images if you prefer deterministic inputs across runs.
 *
 * TODO(yusuf): swap these with representative photos from your dev dataset
 * before running, so findings reflect typical user input quality.
 */
const TEST_PHOTOS: Record<string, string> = {
  livingRoom:
    "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=1024",
  bedroom:
    "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?w=1024",
  kitchen:
    "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=1024",
  bathroom:
    "https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=1024",
  gamingRoom:
    "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=1024",
  stairway:
    "https://images.unsplash.com/photo-1600566752355-35792bedcfea?w=1024",
};

/**
 * Representative {style × room} sample (~25 combinations + edge cases).
 * Covers 5 common styles × 5 common rooms + 5 edge cases that stress the
 * current prompt in known weak ways.
 */
interface TestCase {
  designStyle: string;
  roomType: string;
  note?: string;
}

const TEST_CASES: TestCase[] = [
  // 5 styles × 5 rooms — common combinations
  { designStyle: "modern", roomType: "livingRoom" },
  { designStyle: "modern", roomType: "bedroom" },
  { designStyle: "modern", roomType: "kitchen" },
  { designStyle: "modern", roomType: "bathroom" },
  { designStyle: "modern", roomType: "gamingRoom" },
  { designStyle: "scandinavian", roomType: "livingRoom" },
  { designStyle: "scandinavian", roomType: "bedroom" },
  { designStyle: "scandinavian", roomType: "kitchen" },
  { designStyle: "scandinavian", roomType: "bathroom" },
  { designStyle: "scandinavian", roomType: "gamingRoom" },
  { designStyle: "japandi", roomType: "livingRoom" },
  { designStyle: "japandi", roomType: "bedroom" },
  { designStyle: "japandi", roomType: "kitchen" },
  { designStyle: "japandi", roomType: "bathroom" },
  { designStyle: "japandi", roomType: "gamingRoom" },
  { designStyle: "industrial", roomType: "livingRoom" },
  { designStyle: "industrial", roomType: "bedroom" },
  { designStyle: "industrial", roomType: "kitchen" },
  { designStyle: "industrial", roomType: "bathroom" },
  { designStyle: "industrial", roomType: "gamingRoom" },
  { designStyle: "luxury", roomType: "livingRoom" },
  { designStyle: "luxury", roomType: "bedroom" },
  { designStyle: "luxury", roomType: "kitchen" },
  { designStyle: "luxury", roomType: "bathroom" },
  { designStyle: "luxury", roomType: "gamingRoom" },

  // Edge cases — known weak combinations for the current prompt
  {
    designStyle: "christmas",
    roomType: "bathroom",
    note: "Absurd-output risk: Christmas tree in bathroom",
  },
  {
    designStyle: "airbnb",
    roomType: "gamingRoom",
    note: "Semantic contradiction: rental-neutral vs personalized gaming",
  },
  {
    designStyle: "minimalist",
    roomType: "stairway",
    note: "Non-furniture room: plan forbids replace-all-furniture language",
  },
  {
    designStyle: "luxury",
    roomType: "bathroom",
    note: "Fixture-focused dialect required",
  },
  {
    designStyle: "japandi",
    roomType: "livingRoom",
    note: "Control reference for rater calibration",
  },
];

// ─── Prompt builders ────────────────────────────────────────────────────────

/**
 * Current production prompt builder — copied inline from src/lib/prompts.ts
 * so this script measures the real baseline without importing live code.
 * Kept verbatim to baseline against what users see in production today.
 */
function buildBaselinePrompt(roomType: string, designStyle: string): string {
  const room = humanize(roomType);
  const style = humanize(designStyle);

  return (
    `Redesign this ${room} in a ${style} style. ` +
    `Keep the room's structural elements (walls, windows, doors) intact. ` +
    `Replace all furniture, decor, and accessories with items that match the ${style} aesthetic. ` +
    `Maintain the room's dimensions and layout while completely transforming the interior design. ` +
    `Photorealistic, high quality interior design photograph.`
  );
}

/**
 * Cheap fix — minimum viable improvement over baseline. Three changes:
 *   1. Verb: Redesign → Convert (BFL Kontext guide: convert is safe, redesign is risky)
 *   2. Structural preservation clause (Kontext I2I canonical phrasing)
 *   3. Positive-avoidance tail (positive descriptions of absent clutter)
 *
 * This is the F1 "cheap fix" arm from the pre-committed decision rule.
 * If this moves the quality needle meaningfully, the full R1–R7 rewrite may
 * not be worth the effort and scope can be compressed.
 */
function buildCheapFixPrompt(roomType: string, designStyle: string): string {
  const room = humanize(roomType);
  const style = humanize(designStyle);

  return (
    `Convert this ${room} to a ${style} interior. ` +
    `Replace the furniture, decor, and accessories with items that match the ${style} aesthetic, ` +
    `while preserving the exact wall positions, window count, ceiling height, door placements, ` +
    `camera angle, lens perspective, and room geometry. Do not add or remove walls, windows, or doors. ` +
    `Shot as professional editorial architectural interior photography, 35mm lens at f/4, ` +
    `soft natural daylight, balanced composition, realistic materials. ` +
    `Minimal clutter, sharp focus, rectilinear verticals, natural color balance, ` +
    `unoccupied room, clean photographic frame, realistic proportions.`
  );
}

/**
 * Humanize camelCase enum values — same map as src/lib/prompts.ts so the
 * baseline comparison is fair.
 */
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

// ─── Provider call ──────────────────────────────────────────────────────────

interface CallResult {
  ok: boolean;
  imageUrl: string | null;
  durationMs: number;
  error: string | null;
}

const replicate = new Replicate({ auth: env.REPLICATE_API_TOKEN });

async function runPrompt(
  prompt: string,
  imageUrl: string,
): Promise<CallResult> {
  const start = Date.now();
  try {
    const output = (await replicate.run(REPLICATE_MODEL, {
      input: {
        prompt,
        images: [imageUrl],
        output_format: "jpg",
        aspect_ratio: "16:9",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })) as unknown;

    const durationMs = Date.now() - start;

    let resultUrl: string;
    if (typeof output === "string") {
      resultUrl = output;
    } else if (Array.isArray(output) && output.length > 0) {
      resultUrl =
        typeof output[0] === "string" ? output[0] : String(output[0]);
    } else {
      return {
        ok: false,
        imageUrl: null,
        durationMs,
        error: "No images in response",
      };
    }

    return { ok: true, imageUrl: resultUrl, durationMs, error: null };
  } catch (error) {
    return {
      ok: false,
      imageUrl: null,
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Run ────────────────────────────────────────────────────────────────────

interface CaseResult {
  testCase: TestCase;
  inputImageUrl: string;
  baselinePrompt: string;
  cheapFixPrompt: string;
  baselineResult: CallResult;
  cheapFixResult: CallResult;
}

async function runAll(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  for (let i = 0; i < TEST_CASES.length; i++) {
    const testCase = TEST_CASES[i]!;
    const { designStyle, roomType } = testCase;
    const inputImageUrl =
      TEST_PHOTOS[roomType] ?? TEST_PHOTOS["livingRoom"]!;

    logger.info(
      { event: "baseline.case_start", index: i + 1, total: TEST_CASES.length, designStyle, roomType },
      `Running ${designStyle} × ${roomType} (${i + 1}/${TEST_CASES.length})`,
    );

    const baselinePrompt = buildBaselinePrompt(roomType, designStyle);
    const cheapFixPrompt = buildCheapFixPrompt(roomType, designStyle);

    const [baselineResult, cheapFixResult] = await Promise.all([
      runPrompt(baselinePrompt, inputImageUrl),
      runPrompt(cheapFixPrompt, inputImageUrl),
    ]);

    results.push({
      testCase,
      inputImageUrl,
      baselinePrompt,
      cheapFixPrompt,
      baselineResult,
      cheapFixResult,
    });

    if (!baselineResult.ok || !cheapFixResult.ok) {
      logger.warn(
        {
          event: "baseline.case_failure",
          designStyle,
          roomType,
          baselineError: baselineResult.error,
          cheapFixError: cheapFixResult.error,
        },
        `Failure on ${designStyle} × ${roomType}`,
      );
    }
  }

  return results;
}

// ─── Report writer ──────────────────────────────────────────────────────────

function renderMarkdown(results: CaseResult[]): string {
  const totalPairs = results.length;
  const baselineOk = results.filter((r) => r.baselineResult.ok).length;
  const cheapFixOk = results.filter((r) => r.cheapFixResult.ok).length;

  const now = new Date().toISOString();

  return `---
date: ${now.slice(0, 10)}
topic: prompt-baseline-findings
source: U1 — scripts/baseline-prompts.ts
---

# Prompt Baseline & Cheap-Fix A/B Findings

**Status:** Run complete — pending manual rater labels.

## Run Summary

- Total combinations: ${totalPairs}
- Baseline successful generations: ${baselineOk}/${totalPairs}
- Cheap-fix successful generations: ${cheapFixOk}/${totalPairs}
- Provider: Replicate \`prunaai/p-image-edit\`
- Run timestamp: ${now}

## Pre-Committed Decision Rule (F1)

Label each of the ${totalPairs * 2} outputs with one of:
\`acceptable\` | \`wrong-style\` | \`structural-drift\` | \`photo-quality\` | \`model-artifact\`

**"Cheap fix sufficient" trigger — ALL three must hold:**

1. \`(structural-drift + wrong-style)\` combined labels drop by **≥50%** from baseline to cheap-fix run
2. \`model-artifact\` labels do NOT increase (cheap fix must not introduce new failure modes)
3. Edge-case combinations (christmas+bathroom, airbnb+gamingRoom, minimalist+stairway) show **no worse** structural fidelity than baseline

**"Full rewrite warranted" trigger — ANY of:**

1. Combined reduction is **<30%** (cheap fix doesn't move the needle)
2. Cheap fix introduces new \`model-artifact\` failures
3. Edge-case combinations regress

**"Ambiguous middle" (30–50% reduction, no regressions):** default to SHIP cheap fix only, defer full rewrite until a second round of evidence is gathered.

## Per-Combination Results — Label These

Fill the \`Label\` columns by viewing the output images. After all rows are labeled, fill the Aggregation and Decision sections at the bottom.

| # | Style × Room | Baseline Output | Baseline Label | Cheap-Fix Output | Cheap-Fix Label | Notes |
|---|---|---|---|---|---|---|
${results
  .map((r, i) => {
    const id = i + 1;
    const pair = `${r.testCase.designStyle} × ${r.testCase.roomType}`;
    const baselineUrl = r.baselineResult.ok
      ? `[output](${r.baselineResult.imageUrl ?? "(missing)"})`
      : `FAIL: ${r.baselineResult.error ?? "unknown"}`;
    const cheapFixUrl = r.cheapFixResult.ok
      ? `[output](${r.cheapFixResult.imageUrl ?? "(missing)"})`
      : `FAIL: ${r.cheapFixResult.error ?? "unknown"}`;
    const note = r.testCase.note ?? "";
    return `| ${id} | ${pair} | ${baselineUrl} | _ | ${cheapFixUrl} | _ | ${note} |`;
  })
  .join("\n")}

## Aggregation — Fill After Labeling

| Label | Baseline count | Cheap-fix count | Delta |
|---|---|---|---|
| acceptable | _ | _ | _ |
| wrong-style | _ | _ | _ |
| structural-drift | _ | _ | _ |
| photo-quality | _ | _ | _ |
| model-artifact | _ | _ | _ |

**Combined (structural-drift + wrong-style):**
- Baseline: _
- Cheap-fix: _
- Reduction: _ %

## Decision — Fill After Aggregation

- [ ] Cheap fix sufficient (all 3 triggers met) → ship cheap fix path, compress Phase 1–4 scope
- [ ] Full rewrite warranted (any failure trigger) → proceed with plan as written
- [ ] Ambiguous middle → default ship cheap fix, defer full rewrite

**Rationale:** _(write 2–3 sentences explaining the call)_

## Raw Prompts Used

Useful for reproducing or debugging. Full prompt strings for each combination:

${results
  .map((r, i) => {
    const id = i + 1;
    return `### ${id}. ${r.testCase.designStyle} × ${r.testCase.roomType}

**Input image:** ${r.inputImageUrl}

**Baseline prompt:**
\`\`\`
${r.baselinePrompt}
\`\`\`

**Cheap-fix prompt:**
\`\`\`
${r.cheapFixPrompt}
\`\`\`
`;
  })
  .join("\n")}
`;
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info(
    { event: "baseline.start", totalCases: TEST_CASES.length },
    "Starting U1 baseline A/B run",
  );

  const results = await runAll();

  const markdown = renderMarkdown(results);

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, markdown, "utf-8");

  logger.info(
    {
      event: "baseline.complete",
      output: OUTPUT_PATH,
      totalCases: results.length,
      baselineOk: results.filter((r) => r.baselineResult.ok).length,
      cheapFixOk: results.filter((r) => r.cheapFixResult.ok).length,
    },
    `Wrote findings to ${OUTPUT_PATH}`,
  );

  logger.info(
    {},
    "Next: open the findings file, view each image pair, fill the Label columns, then the Aggregation and Decision sections.",
  );
}

main().catch((error: unknown) => {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    "Baseline run failed",
  );
  process.exit(1);
});
