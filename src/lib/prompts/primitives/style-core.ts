/**
 * Style-core primitive — the canonical "Color palette: …. Mood: …."
 * sentence that every style-bearing prompt builder emits.
 *
 * Centralises two shapes that were inlined seven times across the
 * builders:
 *
 * - **Style-only** (interior, patio, pool, outdoor-lighting): the user
 *   only picks a style; the palette and mood come from the style entry's
 *   own `colorPalette`/`moodKeywords` fields.
 * - **Style + optional palette override** (exterior-design, garden-design,
 *   virtual-staging): the wizard exposes a separate color-palette
 *   selector. When present, its swatch wins; when absent, fall back to
 *   the style's native palette. Same fallback rule for `mood`.
 *
 * Generic-fallback string literals in the per-tool `buildXGenericFallback`
 * helpers are intentionally not routed through this primitive — those
 * strings are hand-tuned defaults that the builders ship without
 * consulting the dictionary, so wrapping them in this helper would
 * obscure the intent ("this is the literal we picked for the
 * style-unknown path").
 */

import type { ColorPaletteEntry, StyleEntry } from "../types.js";

export function buildStyleCore(
  style: StyleEntry,
  paletteOverride?: ColorPaletteEntry | null,
): string {
  const swatch =
    paletteOverride?.swatch && paletteOverride.swatch.length > 0
      ? paletteOverride.swatch
      : style.colorPalette;
  const mood = paletteOverride?.mood
    ? paletteOverride.mood
    : style.moodKeywords.join(", ");
  return `Color palette: ${swatch.join(", ")}. Mood: ${mood}.`;
}
