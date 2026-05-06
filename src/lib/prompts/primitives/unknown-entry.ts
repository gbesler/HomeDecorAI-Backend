/**
 * Centralised "dictionary lookup missed → log + fall back to generic" helper.
 *
 * Every prompt builder that consults a per-tool dictionary (designStyles,
 * gardenStyles, patioStyles, wallTextures, etc.) has the same branch when
 * the requested key is missing: emit a `prompt.unknown_<kind>` warn with
 * `tool`, the missing value, any per-tool context fields, and
 * `fallback: "generic"`, then return the generic fallback prompt. Eleven
 * callsites reproduced the same shape with cosmetic differences (some
 * inlined as one-liners, some as multi-line object literals; some
 * including `tool` in the log fields, some not).
 *
 * Callers now invoke `warnUnknownEntry({ tool, kind, fields })` and the
 * log shape is uniform across the codebase. This is the prerequisite for
 * any future "alert me when fallback rate spikes" dashboard — without a
 * uniform shape that query is per-tool ad-hoc.
 */

import { logger } from "../../logger.js";

export interface WarnUnknownEntryInput {
  /** Tool key as it appears in `tool-types.ts` (e.g. `"interiorDesign"`). */
  tool: string;
  /** Short snake_case noun that names the missing concept; suffixes the
   *  event name as `prompt.unknown_<kind>`. Examples: `"style"`,
   *  `"room"`, `"building"`, `"material"`, `"texture"`. */
  kind: string;
  /** Per-tool context fields included in the log payload (e.g.
   *  `{ designStyle, roomType }`). The verbose names matter — they're
   *  what dashboards filter on. */
  fields?: Record<string, unknown>;
  /** Override the default human-readable message. Use when the tool's
   *  log message already shipped with a specific phrasing the team
   *  greps for. */
  message?: string;
}

export function warnUnknownEntry(input: WarnUnknownEntryInput): void {
  const { tool, kind, fields = {}, message } = input;
  logger.warn(
    {
      event: `prompt.unknown_${kind}`,
      tool,
      ...fields,
      fallback: "generic",
    },
    message ?? `Unknown ${kind} — using generic fallback prompt`,
  );
}
