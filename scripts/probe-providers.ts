/**
 * U2 — Phase 0 Provider Capability Probe
 *
 * Per plan docs/plans/2026-04-10-001-refactor-interior-prompt-system-plan.md Unit 2.
 *
 * Deliberate test calls to both providers with crafted payloads to empirically
 * determine what each provider accepts / rejects / silently drops. Output is
 * both a human-readable narrative (markdown) AND a machine-readable JSON
 * fixture that U5's codegen step consumes (F5 mechanical handoff).
 *
 * Run:
 *   npm run probe:providers
 *
 * Requires valid REPLICATE_API_TOKEN and FAL_AI_API_KEY in .env.
 *
 * Outputs:
 *   docs/research/2026-04-10-provider-capability-probe.md
 *   scripts/fixtures/provider-capabilities.json
 *
 * Cost estimate: ~12 generations at $0.01–0.05 each = ~$0.15–0.60 total.
 */

import Replicate from "replicate";
import { fal } from "@fal-ai/client";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "../src/lib/env.js";
import { logger } from "../src/lib/logger.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const REPLICATE_MODEL = "prunaai/p-image-edit" as const;
const FALAI_MODEL = "fal-ai/flux-2/klein/9b/edit";
const TIMEOUT_MS = 60_000;

const MARKDOWN_OUTPUT = "docs/research/2026-04-10-provider-capability-probe.md";
const JSON_OUTPUT = "scripts/fixtures/provider-capabilities.json";

/**
 * Stable test image URL. Replace with your own fixture if you want
 * deterministic inputs across probe runs.
 */
const TEST_IMAGE =
  "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=1024";

const BASELINE_PROMPT =
  "Convert this living room to a modern interior, preserving the exact wall positions, window count, and camera angle.";

/**
 * Deliberately long prompt (~280 T5 tokens, ~200 English words).
 * Stresses the upper edge of the documented sweet spot for fal Klein.
 */
const LONG_PROMPT =
  "Convert this living room to a modern interior featuring warm walnut flooring, off-white walls, brass accents, and deep charcoal upholstery. " +
  "Replace the furniture with a low-profile sectional sofa, walnut coffee table, and a leather accent chair while preserving the exact wall positions, window count, ceiling height, and camera angle. " +
  "The lighting should be late afternoon golden hour through the existing windows with additional warm pendant lighting above the coffee table. " +
  "Shot as professional editorial architectural interior photography, 35mm lens at f/4, balanced composition, realistic materials, subtle reflections on polished surfaces. " +
  "Minimal clutter, sharp focus, rectilinear verticals, natural color balance, unoccupied room, clean photographic frame, realistic proportions, uncluttered surfaces, natural daylight direction consistent with input. " +
  "Include a single potted fiddle-leaf fig near the window and a rolled textured throw on the sofa as subtle styling anchors.";

/**
 * Deliberately excessive prompt (~500 T5 tokens). Expected to exceed any
 * plausible Flux token limit; probe observes whether truncation is silent
 * or if the API rejects the payload.
 */
const VERY_LONG_PROMPT = LONG_PROMPT + " " + LONG_PROMPT;

// ─── Probe record type ──────────────────────────────────────────────────────

interface ProbeRecord {
  probeId: string;
  provider: "replicate" | "falai";
  modelId: string;
  description: string;
  requestedFields: string[];
  success: boolean;
  durationMs: number;
  outputUrl: string | null;
  errorMessage: string | null;
  /** Free-form notes the human reviewer can use to infer silent-drop vs accepted. */
  observation: string;
}

// ─── Provider clients ───────────────────────────────────────────────────────

const replicate = new Replicate({ auth: env.REPLICATE_API_TOKEN });
fal.config({ credentials: env.FAL_AI_API_KEY });

// ─── Replicate probes ───────────────────────────────────────────────────────

async function probeReplicate(
  probeId: string,
  description: string,
  extraInput: Record<string, unknown>,
): Promise<ProbeRecord> {
  const start = Date.now();
  const input: Record<string, unknown> = {
    prompt: BASELINE_PROMPT,
    images: [TEST_IMAGE],
    output_format: "jpg",
    aspect_ratio: "16:9",
    ...extraInput,
  };

  const record: ProbeRecord = {
    probeId,
    provider: "replicate",
    modelId: REPLICATE_MODEL,
    description,
    requestedFields: Object.keys(input),
    success: false,
    durationMs: 0,
    outputUrl: null,
    errorMessage: null,
    observation: "",
  };

  try {
    const output = (await replicate.run(REPLICATE_MODEL, {
      input,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })) as unknown;

    record.durationMs = Date.now() - start;
    record.success = true;

    if (typeof output === "string") {
      record.outputUrl = output;
    } else if (Array.isArray(output) && output.length > 0) {
      record.outputUrl =
        typeof output[0] === "string" ? output[0] : String(output[0]);
    }

    const extraKeys = Object.keys(extraInput);
    if (extraKeys.length === 0) {
      record.observation =
        "Baseline accepted — minimal fields only.";
    } else {
      record.observation = `Extra fields accepted by SDK (${extraKeys.join(", ")}). ` +
        "Whether the server-side cog actually consumed them requires visual comparison of the output against the baseline.";
    }
  } catch (error) {
    record.durationMs = Date.now() - start;
    record.errorMessage =
      error instanceof Error ? error.message : String(error);

    if (
      record.errorMessage.toLowerCase().includes("unprocessable") ||
      record.errorMessage.includes("422")
    ) {
      record.observation =
        "Schema rejection (422). Unknown fields cause a hard fail — use inline-in-prompt fallback for any unsupported feature.";
    } else if (record.errorMessage.toLowerCase().includes("timeout")) {
      record.observation = "Timeout before response.";
    } else {
      record.observation = `Unexpected error shape: ${record.errorMessage.slice(0, 120)}`;
    }
  }

  return record;
}

// ─── fal.ai probes ──────────────────────────────────────────────────────────

async function probeFalAI(
  probeId: string,
  description: string,
  extraInput: Record<string, unknown>,
  promptOverride?: string,
): Promise<ProbeRecord> {
  const start = Date.now();
  const input: Record<string, unknown> = {
    prompt: promptOverride ?? BASELINE_PROMPT,
    image_url: TEST_IMAGE,
    num_images: 1,
    output_format: "jpeg",
    ...extraInput,
  };

  const record: ProbeRecord = {
    probeId,
    provider: "falai",
    modelId: FALAI_MODEL,
    description,
    requestedFields: Object.keys(input),
    success: false,
    durationMs: 0,
    outputUrl: null,
    errorMessage: null,
    observation: "",
  };

  try {
    const result = await fal.subscribe(FALAI_MODEL, {
      input,
      logs: true,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      pollInterval: 1000,
    });

    record.durationMs = Date.now() - start;
    record.success = true;

    const images = result.data?.images;
    if (Array.isArray(images) && images.length > 0 && images[0]?.url) {
      record.outputUrl = images[0].url;
    }

    const extraKeys = Object.keys(extraInput);
    if (extraKeys.length === 0) {
      record.observation = "Baseline accepted — minimal fields only.";
    } else {
      record.observation = `Extra fields accepted by SDK (${extraKeys.join(", ")}). ` +
        "Visual comparison against baseline determines whether the server consumed them.";
    }
  } catch (error) {
    record.durationMs = Date.now() - start;
    record.errorMessage =
      error instanceof Error ? error.message : String(error);

    if (
      record.errorMessage.toLowerCase().includes("unprocessable") ||
      record.errorMessage.includes("422") ||
      record.errorMessage.toLowerCase().includes("validation")
    ) {
      record.observation =
        "Schema rejection. Unknown or malformed field caused hard fail.";
    } else if (record.errorMessage.toLowerCase().includes("timeout")) {
      record.observation = "Timeout before response.";
    } else {
      record.observation = `Unexpected error shape: ${record.errorMessage.slice(0, 120)}`;
    }
  }

  return record;
}

// ─── Run ────────────────────────────────────────────────────────────────────

async function runAll(): Promise<ProbeRecord[]> {
  const records: ProbeRecord[] = [];

  // Probe 1: baseline (both)
  logger.info({ event: "probe.start", probe: "1-baseline" }, "Probe 1: baseline");
  records.push(await probeReplicate("1-baseline", "Baseline minimal prompt", {}));
  records.push(await probeFalAI("1-baseline", "Baseline minimal prompt", {}));

  // Probe 2: negative_prompt
  logger.info({ event: "probe.start", probe: "2-negative-prompt" }, "Probe 2: negative_prompt");
  records.push(
    await probeReplicate("2-negative-prompt", "With negative_prompt field", {
      negative_prompt: "cluttered, blurry, warped, distorted",
    }),
  );
  records.push(
    await probeFalAI("2-negative-prompt", "With negative_prompt field", {
      negative_prompt: "cluttered, blurry, warped, distorted",
    }),
  );

  // Probe 3: guidance_scale
  logger.info({ event: "probe.start", probe: "3-guidance-scale" }, "Probe 3: guidance_scale=5.0");
  records.push(
    await probeReplicate("3-guidance-scale", "With guidance_scale=5.0", {
      guidance_scale: 5.0,
    }),
  );
  records.push(
    await probeFalAI("3-guidance-scale", "With guidance_scale=5.0", {
      guidance_scale: 5.0,
    }),
  );

  // Probe 4: enable_prompt_expansion (fal.ai only — documented by Relook)
  logger.info({ event: "probe.start", probe: "4-prompt-expansion" }, "Probe 4: enable_prompt_expansion");
  records.push(
    await probeFalAI("4-prompt-expansion", "With enable_prompt_expansion=true", {
      enable_prompt_expansion: true,
    }),
  );

  // Probe 5: long prompt (~280 T5 tokens)
  logger.info({ event: "probe.start", probe: "5-long-prompt" }, "Probe 5: long prompt (~280 tokens)");
  records.push(
    await probeReplicate("5-long-prompt", "Long prompt (~280 T5 tokens)", {
      prompt: LONG_PROMPT,
      images: [TEST_IMAGE],
    }),
  );
  records.push(
    await probeFalAI(
      "5-long-prompt",
      "Long prompt (~280 T5 tokens)",
      {},
      LONG_PROMPT,
    ),
  );

  // Probe 6: very long prompt (~500 T5 tokens)
  logger.info({ event: "probe.start", probe: "6-very-long-prompt" }, "Probe 6: very long prompt (~500 tokens)");
  records.push(
    await probeReplicate("6-very-long-prompt", "Very long prompt (~500 T5 tokens)", {
      prompt: VERY_LONG_PROMPT,
      images: [TEST_IMAGE],
    }),
  );
  records.push(
    await probeFalAI(
      "6-very-long-prompt",
      "Very long prompt (~500 T5 tokens)",
      {},
      VERY_LONG_PROMPT,
    ),
  );

  return records;
}

// ─── Capabilities derivation ────────────────────────────────────────────────

interface ProviderCapabilities {
  provider: "replicate" | "falai";
  modelId: string;
  supportsNegativePrompt: boolean;
  supportsGuidanceScale: boolean;
  supportsPromptExpansion: boolean;
  maxPromptTokens: number;
  defaultAspectRatio?: string;
  defaultImageSize?: string;
  notes: string;
}

/**
 * Derive capability flags from probe outcomes.
 *
 * Caveat: "success" here means the SDK call returned without rejection.
 * Whether the server-side cog CONSUMED the extra field requires visual
 * comparison against the baseline output by a human reviewer — encoded as
 * `needsManualConfirmation: true` when the SDK didn't fail.
 *
 * Defensive defaults match the external-research assumptions from the plan:
 * - Pruna: no negative_prompt, no guidance_scale, maxTokens=200
 * - fal Klein: no negative_prompt, yes guidance_scale (default 2.5), maxTokens=250
 *
 * The script writes the defensive defaults ONLY when a probe fails; if the
 * probe succeeds, it flags the field as "accepted by SDK" and marks it for
 * manual visual confirmation before flipping supportsX to true.
 */
function deriveCapabilities(
  records: ProbeRecord[],
): Record<string, ProviderCapabilities> {
  const byProvider = (provider: "replicate" | "falai") =>
    records.filter((r) => r.provider === provider);

  function supportsField(
    provider: "replicate" | "falai",
    probeId: string,
  ): boolean | "manual-confirm" {
    const record = byProvider(provider).find((r) => r.probeId === probeId);
    if (!record) return false;
    if (!record.success) return false;
    // Success means the SDK accepted the call; visual confirmation needed.
    return "manual-confirm";
  }

  function maxTokensFromProbes(
    provider: "replicate" | "falai",
  ): number {
    const long = byProvider(provider).find(
      (r) => r.probeId === "5-long-prompt",
    );
    const veryLong = byProvider(provider).find(
      (r) => r.probeId === "6-very-long-prompt",
    );
    // Conservative inference: if very-long succeeds, use 500; else if long succeeds, use 280; else fallback 200.
    if (veryLong?.success) return 500;
    if (long?.success) return 280;
    return 200;
  }

  const replicateNegProbe = supportsField("replicate", "2-negative-prompt");
  const replicateGuidanceProbe = supportsField("replicate", "3-guidance-scale");
  const falaiNegProbe = supportsField("falai", "2-negative-prompt");
  const falaiGuidanceProbe = supportsField("falai", "3-guidance-scale");
  const falaiPromptExpansionProbe = supportsField("falai", "4-prompt-expansion");

  return {
    [REPLICATE_MODEL]: {
      provider: "replicate",
      modelId: REPLICATE_MODEL,
      // Defensive default: false until manually confirmed true
      supportsNegativePrompt: replicateNegProbe === true,
      supportsGuidanceScale: replicateGuidanceProbe === true,
      supportsPromptExpansion: false,
      maxPromptTokens: Math.min(maxTokensFromProbes("replicate"), 200),
      defaultAspectRatio: "16:9",
      notes:
        replicateNegProbe === "manual-confirm" || replicateGuidanceProbe === "manual-confirm"
          ? "SDK accepted extra fields but server-side consumption requires visual comparison. Flags left at defensive default (false) until confirmed."
          : "Probe observations match defensive assumptions. Pruna does not expose negative_prompt or guidance_scale per official docs.",
    },
    [FALAI_MODEL]: {
      provider: "falai",
      modelId: FALAI_MODEL,
      supportsNegativePrompt: falaiNegProbe === true,
      supportsGuidanceScale: falaiGuidanceProbe === true,
      supportsPromptExpansion: falaiPromptExpansionProbe === true,
      maxPromptTokens: Math.min(maxTokensFromProbes("falai"), 250),
      defaultImageSize: "landscape_4_3",
      notes:
        "fal Klein 9B edit documents guidance_scale (default 2.5, range 0-20). Negative prompt and prompt expansion not in documented schema; probe confirms behavior.",
    },
  };
}

// ─── Report writers ─────────────────────────────────────────────────────────

function renderMarkdown(
  records: ProbeRecord[],
  capabilities: Record<string, ProviderCapabilities>,
): string {
  const now = new Date().toISOString();

  return `---
date: ${now.slice(0, 10)}
topic: provider-capability-probe
source: U2 — scripts/probe-providers.ts
---

# Provider Capability Probe Findings

**Status:** ${records.every((r) => r.success || r.errorMessage) ? "Run complete" : "Run incomplete"}

## Run Summary

- Replicate model: \`${REPLICATE_MODEL}\`
- fal.ai model: \`${FALAI_MODEL}\`
- Test image: ${TEST_IMAGE}
- Run timestamp: ${now}

## Per-Probe Results

| Probe | Provider | Description | Success | Duration (ms) | Output / Error | Observation |
|---|---|---|---|---|---|---|
${records
  .map(
    (r) =>
      `| ${r.probeId} | ${r.provider} | ${r.description} | ${r.success ? "✓" : "✗"} | ${r.durationMs} | ${r.outputUrl ? `[output](${r.outputUrl})` : (r.errorMessage ?? "-").slice(0, 80)} | ${r.observation} |`,
  )
  .join("\n")}

## Derived Capabilities (defensive defaults applied)

${Object.entries(capabilities)
  .map(
    ([modelId, caps]) => `### ${modelId}

- Provider: \`${caps.provider}\`
- supportsNegativePrompt: \`${caps.supportsNegativePrompt}\`
- supportsGuidanceScale: \`${caps.supportsGuidanceScale}\`
- supportsPromptExpansion: \`${caps.supportsPromptExpansion}\`
- maxPromptTokens: \`${caps.maxPromptTokens}\`
${caps.defaultAspectRatio ? `- defaultAspectRatio: \`${caps.defaultAspectRatio}\`` : ""}
${caps.defaultImageSize ? `- defaultImageSize: \`${caps.defaultImageSize}\`` : ""}
- Notes: ${caps.notes}
`,
  )
  .join("\n")}

## Manual Confirmation Required

If any probe returned "SDK accepted extra fields", the machine cannot tell
whether the server-side cog actually consumed the field. Open the baseline
output and the extra-field output side by side — if they visually differ in
the direction the extra field should push (e.g., negative prompt reduces
clutter), flip the capability flag to \`true\` in \`scripts/fixtures/provider-capabilities.json\`
by hand. Otherwise leave the defensive default.

## Next Steps

1. Review this markdown report and manually confirm any "SDK-accepted but not visually verified" fields.
2. Edit \`scripts/fixtures/provider-capabilities.json\` to reflect visual findings.
3. U5 (capabilities module) will consume the JSON via codegen (\`npm run gen:capabilities\`).

## Raw Probe Records

<details>
<summary>JSON dump (for debugging)</summary>

\`\`\`json
${JSON.stringify(records, null, 2)}
\`\`\`

</details>
`;
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info({ event: "probe.start" }, "Starting U2 provider capability probe");

  const records = await runAll();
  const capabilities = deriveCapabilities(records);

  const markdown = renderMarkdown(records, capabilities);
  const json = JSON.stringify(capabilities, null, 2) + "\n";

  await mkdir(dirname(MARKDOWN_OUTPUT), { recursive: true });
  await writeFile(MARKDOWN_OUTPUT, markdown, "utf-8");

  await mkdir(dirname(JSON_OUTPUT), { recursive: true });
  await writeFile(JSON_OUTPUT, json, "utf-8");

  logger.info(
    {
      event: "probe.complete",
      markdown: MARKDOWN_OUTPUT,
      json: JSON_OUTPUT,
      totalProbes: records.length,
      successfulProbes: records.filter((r) => r.success).length,
    },
    `Wrote findings to ${MARKDOWN_OUTPUT} and ${JSON_OUTPUT}`,
  );

  logger.info(
    {},
    "Next: review the markdown, manually confirm any SDK-accepted fields via visual comparison, then edit the JSON fixture.",
  );
}

main().catch((error: unknown) => {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    "Probe run failed",
  );
  process.exit(1);
});
