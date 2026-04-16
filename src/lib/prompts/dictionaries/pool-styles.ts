/**
 * Pool styles dictionary — 4 entries covering the iOS `PoolStyle` enum.
 * Reuses the `StyleEntry` shape so the existing `checkStyleEntry` validator
 * works unchanged. The `signatureItems` slot holds signature pool features
 * for each style, and `materials` holds pool coping, decking, and surround finishes.
 *
 * R25 editorial validation: `references` must have >= 3 entries per style.
 */

import { PoolStyle } from "../../../schemas/generated/types/poolStyle.js";
import type { PoolStylesDict } from "../types.js";

function placeholderRefs(keyword: string): string[] {
  const q = encodeURIComponent(keyword);
  return [
    `https://www.pinterest.com/search/pins/?q=${q}+pool+design`,
    `https://www.gardenista.com/?s=${q}`,
    `https://www.houzz.com/photos/query/${q}--pool`,
  ];
}

export const poolStyles: PoolStylesDict = {
  [PoolStyle.poolSpa]: {
    coreAesthetic:
      "elegant residential pool paired with an integrated spa, unified by shared coping and finish",
    colorPalette: [
      "aqua turquoise",
      "warm travertine",
      "soft cream",
      "sun-bleached timber",
    ],
    materials: [
      "travertine pool coping",
      "pebble or glass-tile pool interior",
      "stone or tile spa surround",
      "timber or stone decking",
    ],
    signatureItems: [
      "a spillover spa raised above the main pool with water cascading between them",
      "a continuous coping line unifying pool and spa edges",
      "a pair of sun loungers on the adjoining deck",
    ],
    lightingCharacter:
      "warm late-afternoon sunlight on water with subtle underwater pool lighting for evening",
    moodKeywords: ["elegant", "resort-like", "integrated"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("pool-spa-combo"),
  },

  [PoolStyle.resort]: {
    coreAesthetic:
      "lush resort-style pool surrounded by abundant tropical planting, loungers, and shade structures",
    colorPalette: [
      "tropical turquoise",
      "sun-bleached white",
      "warm teak",
      "lush palm green",
    ],
    materials: [
      "large-format travertine or limestone decking",
      "pebble pool interior",
      "teak or woven loungers",
      "thatched or canvas shade canopies",
    ],
    signatureItems: [
      "a row of teak sun loungers with white cushions lining the pool deck",
      "tropical palms and lush planting framing the pool",
      "a cabana or thatched shade structure anchoring one end",
    ],
    lightingCharacter:
      "bright open tropical daylight with crisp directional shadows and soft late-day warmth",
    moodKeywords: ["resort", "lush", "indulgent"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("resort-pool"),
  },

  [PoolStyle.waterfall]: {
    coreAesthetic:
      "naturalistic pool with a rock-formation waterfall feature cascading into the water",
    colorPalette: [
      "deep lagoon blue",
      "natural stone gray",
      "moss green",
      "warm sandstone",
    ],
    materials: [
      "natural boulder and stacked stone surround",
      "dark pebble or plaster pool interior",
      "flagstone decking",
      "moss and fern planting between rocks",
    ],
    signatureItems: [
      "a stacked stone waterfall cascading into the pool",
      "natural boulders forming a rugged pool edge",
      "lush planting softening the stonework",
    ],
    lightingCharacter:
      "dappled afternoon light filtering through planting with crisp highlights on falling water",
    moodKeywords: ["naturalistic", "lush", "dramatic"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("waterfall-pool"),
  },

  [PoolStyle.infinity]: {
    coreAesthetic:
      "sleek infinity-edge pool with a vanishing horizon, minimal architectural surround, and open sky",
    colorPalette: [
      "deep horizon blue",
      "architectural concrete gray",
      "crisp white",
      "sun-bleached timber",
    ],
    materials: [
      "honed stone or large-format porcelain decking",
      "dark-finish pool interior for horizon contrast",
      "minimal architectural coping",
      "glass or cable railing at the infinity edge",
    ],
    signatureItems: [
      "a vanishing infinity edge meeting an open horizon",
      "a minimal pair of low-profile loungers on the deck",
      "a clean architectural surround with no visible pool equipment",
    ],
    lightingCharacter:
      "bright open midday sky reflected on still water, transitioning to a warm horizon glow at dusk",
    moodKeywords: ["sleek", "expansive", "architectural"],
    actionMode: "transform",
    guidanceBand: "faithful",
    references: placeholderRefs("infinity-pool"),
  },
};
