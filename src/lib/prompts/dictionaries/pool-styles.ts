/**
 * Pool styles dictionary — 10 entries covering the iOS `PoolStyle` enum.
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
    guidanceBand: "faithful",
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
    guidanceBand: "faithful",
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
    guidanceBand: "faithful",
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

  [PoolStyle.lagoon]: {
    coreAesthetic:
      "free-form lagoon pool with organic curves, pebble interior, and lush tropical planting",
    colorPalette: [
      "lagoon aqua",
      "warm sand",
      "lush palm green",
      "soft stone gray",
    ],
    materials: [
      "pebble-finish pool interior",
      "organic boulder edging",
      "flagstone or pebble decking",
      "dense tropical planting",
    ],
    signatureItems: [
      "a free-form curved pool edge softened by natural boulders",
      "sandy beach-style entry blending into pebble decking",
      "overhanging palms and tropical foliage around the pool",
    ],
    lightingCharacter:
      "dappled tropical daylight on turquoise water with warm amber late-day glow",
    moodKeywords: ["natural", "tropical", "serene"],
    actionMode: "transform",
    guidanceBand: "faithful",
    references: placeholderRefs("lagoon-pool"),
  },

  [PoolStyle.lapPool]: {
    coreAesthetic:
      "long narrow lap pool designed for swimming, with a clean rectangular footprint and minimal surround",
    colorPalette: [
      "clear swimming-pool blue",
      "pale stone gray",
      "sun-bleached timber",
      "crisp white",
    ],
    materials: [
      "large-format stone or porcelain decking",
      "tile or plaster pool interior",
      "minimal coping in a single material",
      "architectural linear planting",
    ],
    signatureItems: [
      "a long rectangular lap pool with lane-clean proportions",
      "a minimal stone or timber deck running the length of the pool",
      "architectural linear planting along one edge",
    ],
    lightingCharacter:
      "crisp directional midday light with clean linear shadows on still water",
    moodKeywords: ["athletic", "minimal", "linear"],
    actionMode: "transform",
    guidanceBand: "faithful",
    references: placeholderRefs("lap-pool"),
  },

  [PoolStyle.mediterranean]: {
    coreAesthetic:
      "Mediterranean-style pool with terracotta tile, stucco surrounds, and aromatic planting",
    colorPalette: [
      "Mediterranean aqua",
      "terracotta",
      "whitewashed stucco",
      "olive green",
    ],
    materials: [
      "terracotta or limestone decking",
      "mosaic-tile pool interior in Mediterranean blue",
      "whitewashed stucco surround walls",
      "glazed ceramic planters",
    ],
    signatureItems: [
      "a mosaic-tile pool in Mediterranean blue with terracotta coping",
      "whitewashed stucco walls with climbing bougainvillea",
      "potted olive trees and lavender framing the pool",
    ],
    lightingCharacter:
      "warm Mediterranean sunlight with crisp shadows and a soft dusk amber over still water",
    moodKeywords: ["sun-drenched", "timeless", "aromatic"],
    actionMode: "transform",
    guidanceBand: "faithful",
    references: placeholderRefs("mediterranean-pool"),
  },

  [PoolStyle.grotto]: {
    coreAesthetic:
      "dramatic grotto pool with a stone cave feature, hidden seating nook, and waterfall concealment",
    colorPalette: [
      "deep cave blue",
      "dark stone gray",
      "moss green",
      "warm sandstone",
    ],
    materials: [
      "stacked natural stone and boulder formation",
      "dark pebble or plaster pool interior",
      "flagstone decking",
      "shaded fern and moss planting",
    ],
    signatureItems: [
      "a stone grotto cave with a waterfall concealing a hidden nook",
      "natural boulder edging wrapping one side of the pool",
      "shaded underwater seating within the grotto",
    ],
    lightingCharacter:
      "dramatic shaded grotto interior with bright water reflections and dappled filtered daylight",
    moodKeywords: ["dramatic", "hidden", "naturalistic"],
    actionMode: "transform",
    guidanceBand: "faithful",
    references: placeholderRefs("grotto-pool"),
  },

  [PoolStyle.beachEntry]: {
    coreAesthetic:
      "zero-edge beach-entry pool with a gradual sandy slope into the water and resort-style surround",
    colorPalette: [
      "resort turquoise",
      "warm sand",
      "sun-bleached white",
      "soft teak",
    ],
    materials: [
      "textured sand-finish entry slope",
      "pebble or plaster pool interior",
      "large-format travertine decking",
      "teak or woven loungers",
    ],
    signatureItems: [
      "a gradual zero-edge beach entry sloping into the water",
      "a pair of loungers resting partially in the shallow entry",
      "travertine decking transitioning smoothly into the pool",
    ],
    lightingCharacter:
      "bright resort daylight with crisp highlights on the shallow entry and warm late-day reflection",
    moodKeywords: ["resort", "relaxed", "wade-in"],
    actionMode: "transform",
    guidanceBand: "faithful",
    references: placeholderRefs("beach-entry-pool"),
  },

  [PoolStyle.mosaicTile]: {
    coreAesthetic:
      "ornate mosaic-tile pool with intricate patterned interior and classical surround",
    colorPalette: [
      "deep mosaic blue",
      "gilded gold",
      "pale stone ivory",
      "warm terracotta",
    ],
    materials: [
      "hand-set mosaic-tile pool interior",
      "polished stone coping",
      "classical stone decking",
      "ornamental planters",
    ],
    signatureItems: [
      "an intricate mosaic-tile pattern covering the pool interior",
      "a classical stone fountain or spout feeding the pool",
      "ornamental urns and clipped topiary framing the surround",
    ],
    lightingCharacter:
      "warm classical daylight catching mosaic color beneath the water, with soft dusk gold on stone",
    moodKeywords: ["ornate", "classical", "crafted"],
    actionMode: "transform",
    guidanceBand: "faithful",
    references: placeholderRefs("mosaic-tile-pool"),
  },
};
