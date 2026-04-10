/**
 * U3 — Phase 0 Analytics Baseline
 *
 * Per plan docs/plans/2026-04-10-001-refactor-interior-prompt-system-plan.md Unit 3.
 *
 * Queries the Firestore `generations` collection for the last 30–90 days and
 * aggregates style/room pick distribution + a regeneration-rate baseline.
 *
 * The regen rate is estimated via a simple heuristic: same user + same
 * {roomType, designStyle} combination within a 20-minute window counts as
 * a regeneration signal.
 *
 * Run:
 *   npm run analytics:baseline
 *
 * Requires valid FIREBASE_SERVICE_ACCOUNT_KEY in .env.
 *
 * Outputs:
 *   docs/research/2026-04-10-analytics-baseline.md
 *
 * Read-only — does not modify any Firestore data.
 */

import admin from "firebase-admin";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "../src/lib/env.js";
import { logger } from "../src/lib/logger.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const OUTPUT_PATH = "docs/research/2026-04-10-analytics-baseline.md";
const GENERATIONS_COLLECTION = "generations";
const LOOKBACK_DAYS = 90;
const REGEN_WINDOW_MS = 20 * 60 * 1000; // 20 minutes
const INSUFFICIENT_DATA_THRESHOLD = 100;

// ─── Firebase initialization ────────────────────────────────────────────────

function initializeFirebase(): void {
  if (admin.apps.length > 0) return;

  admin.initializeApp({
    credential: admin.credential.cert(
      env.FIREBASE_SERVICE_ACCOUNT_KEY as admin.ServiceAccount,
    ),
  });
}

// ─── Query ──────────────────────────────────────────────────────────────────

/**
 * Minimal shape of the generations collection document we care about here.
 * Mirrors src/lib/firestore.ts GenerationDoc but re-declared locally so the
 * script does not implicitly take a runtime dependency on the live module
 * (which could change shape during the rewrite).
 */
interface GenerationRow {
  id: string;
  userId: string;
  toolType: string;
  roomType: string | null;
  designStyle: string | null;
  status: "pending" | "completed" | "failed";
  createdAtMs: number | null;
}

async function fetchGenerations(): Promise<GenerationRow[]> {
  const db = admin.firestore();
  const cutoffMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = admin.firestore.Timestamp.fromMillis(cutoffMs);

  const snapshot = await db
    .collection(GENERATIONS_COLLECTION)
    .where("createdAt", ">", cutoff)
    .orderBy("createdAt", "desc")
    .get();

  const rows: GenerationRow[] = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const rawCreatedAt = data["createdAt"];
    let createdAtMs: number | null = null;
    if (rawCreatedAt instanceof admin.firestore.Timestamp) {
      createdAtMs = rawCreatedAt.toMillis();
    }

    rows.push({
      id: doc.id,
      userId: typeof data["userId"] === "string" ? data["userId"] : "unknown",
      toolType: typeof data["toolType"] === "string" ? data["toolType"] : "unknown",
      roomType: typeof data["roomType"] === "string" ? data["roomType"] : null,
      designStyle:
        typeof data["designStyle"] === "string" ? data["designStyle"] : null,
      status:
        data["status"] === "completed" ||
        data["status"] === "failed" ||
        data["status"] === "pending"
          ? data["status"]
          : "pending",
      createdAtMs,
    });
  }

  return rows;
}

// ─── Aggregation ────────────────────────────────────────────────────────────

interface Aggregate {
  totalGenerations: number;
  interiorDesignGenerations: number;
  uniqueUsers: number;
  stylePickCounts: Record<string, number>;
  roomPickCounts: Record<string, number>;
  regenerationCount: number;
  regenerationRate: number;
  statusCounts: { completed: number; failed: number; pending: number };
  windowStart: string;
  windowEnd: string;
}

function aggregate(rows: GenerationRow[]): Aggregate {
  const interior = rows.filter((r) => r.toolType === "interiorDesign");
  const stylePickCounts: Record<string, number> = {};
  const roomPickCounts: Record<string, number> = {};
  const statusCounts = { completed: 0, failed: 0, pending: 0 };
  const userIds = new Set<string>();

  for (const row of interior) {
    userIds.add(row.userId);
    if (row.designStyle) {
      stylePickCounts[row.designStyle] =
        (stylePickCounts[row.designStyle] ?? 0) + 1;
    }
    if (row.roomType) {
      roomPickCounts[row.roomType] = (roomPickCounts[row.roomType] ?? 0) + 1;
    }
    statusCounts[row.status]++;
  }

  // Regeneration signal: same user + same {roomType, designStyle} within 20 minutes.
  // Group by user and sort by createdAt ascending, then scan for close pairs.
  const byUser = new Map<string, GenerationRow[]>();
  for (const row of interior) {
    const bucket = byUser.get(row.userId) ?? [];
    bucket.push(row);
    byUser.set(row.userId, bucket);
  }

  let regenerationCount = 0;
  for (const bucket of byUser.values()) {
    const sorted = [...bucket].sort((a, b) => {
      return (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0);
    });
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      if (!prev.createdAtMs || !curr.createdAtMs) continue;
      if (curr.createdAtMs - prev.createdAtMs > REGEN_WINDOW_MS) continue;
      if (
        curr.roomType === prev.roomType &&
        curr.designStyle === prev.designStyle
      ) {
        regenerationCount++;
      }
    }
  }

  const regenerationRate =
    interior.length > 0 ? regenerationCount / interior.length : 0;

  const windowEnd = new Date().toISOString();
  const windowStart = new Date(
    Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  return {
    totalGenerations: rows.length,
    interiorDesignGenerations: interior.length,
    uniqueUsers: userIds.size,
    stylePickCounts,
    roomPickCounts,
    regenerationCount,
    regenerationRate,
    statusCounts,
    windowStart,
    windowEnd,
  };
}

// ─── Report writer ──────────────────────────────────────────────────────────

function sortByCountDesc(
  record: Record<string, number>,
): Array<[string, number]> {
  return Object.entries(record).sort((a, b) => b[1] - a[1]);
}

function renderMarkdown(agg: Aggregate): string {
  const now = new Date().toISOString();

  if (agg.interiorDesignGenerations < INSUFFICIENT_DATA_THRESHOLD) {
    return `---
date: ${now.slice(0, 10)}
topic: analytics-baseline
source: U3 — scripts/analytics-baseline.ts
---

# Analytics Baseline — Insufficient Data

**Status:** Lookback window returned **${agg.interiorDesignGenerations}** interior-design generations (below the ${INSUFFICIENT_DATA_THRESHOLD}-threshold for statistical confidence).

## Decision

Per plan Phase 0.6, when history is insufficient the Success Criteria user-outcome metric shifts to a **post-launch 2-week window**. Ship the plan; measure regen rate and style-pick distribution during the first two weeks post-deploy and compare against the rewrite's target (≤ baseline × 1.0).

## What We Saw

- Window: ${agg.windowStart} → ${agg.windowEnd}
- Total generations (all tools): ${agg.totalGenerations}
- interiorDesign generations: ${agg.interiorDesignGenerations}
- Unique users: ${agg.uniqueUsers}
- Status counts: completed=${agg.statusCounts.completed}, failed=${agg.statusCounts.failed}, pending=${agg.statusCounts.pending}

Recorded for reference. Do not treat this as a statistical baseline.
`;
  }

  const styleRows = sortByCountDesc(agg.stylePickCounts);
  const roomRows = sortByCountDesc(agg.roomPickCounts);

  return `---
date: ${now.slice(0, 10)}
topic: analytics-baseline
source: U3 — scripts/analytics-baseline.ts
---

# Analytics Baseline — Style Pick Distribution & User Outcome

**Status:** Run complete — sufficient data for baseline.

## Run Summary

- Window: ${agg.windowStart} → ${agg.windowEnd} (${LOOKBACK_DAYS} days)
- Total generations (all tools): ${agg.totalGenerations}
- interiorDesign generations: ${agg.interiorDesignGenerations}
- Unique users (interiorDesign): ${agg.uniqueUsers}
- Status distribution: completed=${agg.statusCounts.completed}, failed=${agg.statusCounts.failed}, pending=${agg.statusCounts.pending}

## User Outcome Baseline

**Regeneration rate:** ${(agg.regenerationRate * 100).toFixed(2)}% (${agg.regenerationCount} regenerations across ${agg.interiorDesignGenerations} generations)

Heuristic: same user + same \`{roomType, designStyle}\` combination within a ${Math.round(REGEN_WINDOW_MS / 60_000)}-minute window counts as a regeneration.

**Target for the rewrite:** regen rate after ship **≤ ${(agg.regenerationRate * 100).toFixed(2)}%** (hard gate: does not regress). Aspirational target: 15–25% relative decrease → ${(agg.regenerationRate * 100 * 0.8).toFixed(2)}%–${(agg.regenerationRate * 100 * 0.85).toFixed(2)}%.

## Style Pick Distribution

| Rank | Style | Count | Percentage |
|---|---|---|---|
${styleRows
  .map(
    ([style, count], i) =>
      `| ${i + 1} | \`${style}\` | ${count} | ${((count / agg.interiorDesignGenerations) * 100).toFixed(1)}% |`,
  )
  .join("\n")}

## Room Pick Distribution

| Rank | Room | Count | Percentage |
|---|---|---|---|
${roomRows
  .map(
    ([room, count], i) =>
      `| ${i + 1} | \`${room}\` | ${count} | ${((count / agg.interiorDesignGenerations) * 100).toFixed(1)}% |`,
  )
  .join("\n")}

## Recommendations for U8 (style dictionary authoring)

${(() => {
  const lowPick = styleRows.filter(
    ([, count]) => count / agg.interiorDesignGenerations < 0.05,
  );
  const highPick = styleRows.filter(
    ([, count]) => count / agg.interiorDesignGenerations >= 0.05,
  );

  return `- **High-priority styles (≥5% of picks):** ${highPick.length} styles. Author rich R2 entries with all 6–8 fields fully curated. Effort: significant editorial review.
${highPick.map(([style]) => `  - \`${style}\``).join("\n")}

- **Low-priority styles (<5% of picks):** ${lowPick.length} styles. Satisfy R8 completeness (all required fields populated) but authoring effort can be minimal; copy conservative descriptors and defer rich tuning to a post-launch refinement pass.
${lowPick.map(([style]) => `  - \`${style}\``).join("\n")}`;
})()}

## Recommendations for U7 (room dictionary authoring)

${(() => {
  const lowPick = roomRows.filter(
    ([, count]) => count / agg.interiorDesignGenerations < 0.05,
  );
  const highPick = roomRows.filter(
    ([, count]) => count / agg.interiorDesignGenerations >= 0.05,
  );

  return `- **High-priority rooms (≥5% of picks):** ${highPick.length} rooms. Author rich focusSlots with full dialect.
${highPick.map(([room]) => `  - \`${room}\``).join("\n")}

- **Low-priority rooms (<5% of picks):** ${lowPick.length} rooms. Minimal but correct focusSlots. Special-case rooms (bathroom, kitchen, gamingRoom, stairway/entryway/underStairSpace) are still fully authored regardless of pick rate because they drive the R13/R14/R15 requirements.
${lowPick.map(([room]) => `  - \`${room}\``).join("\n")}`;
})()}

## Raw Counts (JSON)

<details>
<summary>JSON dump (for scripting downstream)</summary>

\`\`\`json
${JSON.stringify(agg, null, 2)}
\`\`\`

</details>
`;
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info(
    { event: "analytics.start", lookbackDays: LOOKBACK_DAYS },
    "Starting U3 analytics baseline query",
  );

  initializeFirebase();

  const rows = await fetchGenerations();
  const agg = aggregate(rows);

  const markdown = renderMarkdown(agg);

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, markdown, "utf-8");

  logger.info(
    {
      event: "analytics.complete",
      output: OUTPUT_PATH,
      totalRows: rows.length,
      interiorDesignCount: agg.interiorDesignGenerations,
      uniqueUsers: agg.uniqueUsers,
      regenerationRate: agg.regenerationRate,
    },
    `Wrote analytics baseline to ${OUTPUT_PATH}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Analytics baseline run failed",
    );
    process.exit(1);
  });
