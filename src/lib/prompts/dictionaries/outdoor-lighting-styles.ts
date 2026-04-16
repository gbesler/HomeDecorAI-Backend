/**
 * Outdoor lighting styles dictionary — 10 entries covering the iOS
 * `OutdoorLightingStyle` enum. Reuses the `StyleEntry` shape so the existing
 * `checkStyleEntry` validator works unchanged. The `signatureItems` slot holds
 * signature fixture placements, and `materials` holds fixture types and finishes.
 *
 * Note: this tool is light-only — the action is relighting an existing
 * outdoor scene, not restyling its architecture. The `lightingCharacter`
 * slot therefore carries the heaviest prompt weight; `actionMode` is
 * `overlay` for styles that layer lighting onto an unchanged scene and
 * `transform` for styles that meaningfully re-color ambient tonality.
 *
 * R25 editorial validation: `references` must have >= 3 entries per style.
 */

import { OutdoorLightingStyle } from "../../../schemas/generated/types/outdoorLightingStyle.js";
import type { OutdoorLightingStylesDict } from "../types.js";

function placeholderRefs(keyword: string): string[] {
  const q = encodeURIComponent(keyword);
  return [
    `https://www.pinterest.com/search/pins/?q=${q}+outdoor+lighting`,
    `https://www.gardenista.com/?s=${q}`,
    `https://www.houzz.com/photos/query/${q}--outdoor-lighting`,
  ];
}

export const outdoorLightingStyles: OutdoorLightingStylesDict = {
  [OutdoorLightingStyle.warmAmbient]: {
    coreAesthetic:
      "warm ambient outdoor glow with soft globe lanterns casting a welcoming evening wash",
    colorPalette: [
      "warm amber",
      "soft candle yellow",
      "deep dusk blue",
      "bronze fixture",
    ],
    materials: [
      "frosted globe lanterns",
      "bronze or matte-black fixtures",
      "low-voltage garden spots",
      "softly illuminated planting",
    ],
    signatureItems: [
      "clusters of warm globe lanterns scattered across the yard",
      "a soft amber glow washing across planting and seating",
      "low garden spots subtly lighting key foliage",
    ],
    lightingCharacter:
      "warm 2700K ambient glow at dusk with soft shadow falloff and deep-blue sky",
    moodKeywords: ["warm", "welcoming", "ambient"],
    actionMode: "overlay",
    guidanceBand: "faithful",
    references: placeholderRefs("warm-ambient"),
  },

  [OutdoorLightingStyle.stringLights]: {
    coreAesthetic:
      "festive outdoor patio draped with warm bistro string lights overhead",
    colorPalette: [
      "incandescent amber",
      "warm dusk indigo",
      "soft cream",
      "matte black wire",
    ],
    materials: [
      "bistro-style Edison string lights",
      "matte-black or bronze suspension hardware",
      "warm-white filament bulbs",
      "wooden or metal support posts",
    ],
    signatureItems: [
      "warm bistro string lights crisscrossing overhead",
      "soft twinkle reflected across the deck and planting",
      "a canopy of gentle amber light over the seating area",
    ],
    lightingCharacter:
      "warm filament twinkle against a deep-blue dusk sky with soft reflections on stone and timber",
    moodKeywords: ["festive", "warm", "celebratory"],
    actionMode: "overlay",
    guidanceBand: "faithful",
    references: placeholderRefs("string-lights"),
  },

  [OutdoorLightingStyle.pathwayLighting]: {
    coreAesthetic:
      "landscaped pathway softly lit by low bollard and stake fixtures guiding the route",
    colorPalette: [
      "warm pathway amber",
      "deep nighttime blue",
      "soft planting green",
      "matte-bronze fixture",
    ],
    materials: [
      "low bollard path lights",
      "staked LED path markers",
      "bronze or copper fixtures",
      "crushed-gravel or stone pathway",
    ],
    signatureItems: [
      "a rhythmic line of low path lights tracing the walkway",
      "soft pools of warm light on the pathway surface",
      "subtle glow spilling onto bordering planting",
    ],
    lightingCharacter:
      "intimate low-level 2700K pools of light along the path with the surrounding garden falling into soft night shadow",
    moodKeywords: ["guided", "inviting", "intimate"],
    actionMode: "overlay",
    guidanceBand: "faithful",
    references: placeholderRefs("pathway-lighting"),
  },

  [OutdoorLightingStyle.uplighting]: {
    coreAesthetic:
      "dramatic architectural and tree uplighting highlighting key verticals against the night",
    colorPalette: [
      "warm uplight amber",
      "deep architectural charcoal",
      "cool planting green",
      "crisp white accent",
    ],
    materials: [
      "in-ground uplight fixtures",
      "adjustable well lights",
      "narrow-beam LED spots",
      "stone or timber uplit surfaces",
    ],
    signatureItems: [
      "strong uplight beams grazing tree trunks and canopies",
      "feature walls washed from below by warm narrow beams",
      "architectural columns or pergola posts highlighted against the night",
    ],
    lightingCharacter:
      "strong directional uplight beams with crisp vertical light streaks and deep surrounding shadow",
    moodKeywords: ["dramatic", "architectural", "sculptural"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("uplighting"),
  },

  [OutdoorLightingStyle.lantern]: {
    coreAesthetic:
      "classic lantern-lit outdoor setting with wall-mounted and freestanding lanterns casting gentle warm light",
    colorPalette: [
      "warm lantern amber",
      "matte-black metal",
      "aged-bronze patina",
      "deep dusk blue",
    ],
    materials: [
      "wall-mounted coach lanterns",
      "freestanding post lanterns",
      "hand-forged metal frames",
      "warm filament candelabra bulbs",
    ],
    signatureItems: [
      "matte-black coach lanterns flanking an outdoor entry",
      "a tall post lantern anchoring the garden path",
      "lantern light reflected softly on stone and timber",
    ],
    lightingCharacter:
      "warm filament candelabra glow from multiple lanterns with soft overlapping light pools",
    moodKeywords: ["classic", "timeless", "warm"],
    actionMode: "overlay",
    guidanceBand: "faithful",
    references: placeholderRefs("lantern"),
  },

  [OutdoorLightingStyle.modernArchitectural]: {
    coreAesthetic:
      "sleek modern outdoor lighting with clean linear LED strips and concealed fixtures highlighting architecture",
    colorPalette: [
      "cool architectural white",
      "warm 3000K accent",
      "matte charcoal",
      "crisp concrete gray",
    ],
    materials: [
      "recessed linear LED strips",
      "concealed step and wall-wash fixtures",
      "matte-black or anodized aluminum trim",
      "large-format stone or concrete surfaces",
    ],
    signatureItems: [
      "a crisp linear LED line grazing a feature wall or stair",
      "concealed step lights illuminating a clean tread edge",
      "a minimal wall-wash fixture catching a textured concrete surface",
    ],
    lightingCharacter:
      "precise 3000K architectural light with clean linear streaks, minimal spill, and a restrained contrast range",
    moodKeywords: ["architectural", "precise", "modern"],
    actionMode: "transform",
    guidanceBand: "faithful",
    references: placeholderRefs("modern-architectural"),
  },

  [OutdoorLightingStyle.moody]: {
    coreAesthetic:
      "moody, low-key outdoor lighting with restrained warm pools and deep surrounding shadow",
    colorPalette: [
      "deep amber ember",
      "rich nighttime indigo",
      "soft smoke gray",
      "warm bronze",
    ],
    materials: [
      "a handful of carefully placed low-voltage spots",
      "shielded warm downlights",
      "matte-bronze or blackened fixtures",
      "dim candle-like wall accents",
    ],
    signatureItems: [
      "a single warm downlight pooling across a seating group",
      "deep surrounding shadow keeping most of the scene dark",
      "a restrained wall-accent glow marking a key architectural detail",
    ],
    lightingCharacter:
      "low-key 2400K pools of warm light against a near-black garden with strong chiaroscuro contrast",
    moodKeywords: ["moody", "intimate", "cinematic"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("moody-lighting"),
  },

  [OutdoorLightingStyle.festiveHoliday]: {
    coreAesthetic:
      "festive holiday-decorated outdoor scene with warm fairy lights, wreaths, and seasonal sparkle",
    colorPalette: [
      "warm holiday amber",
      "deep pine green",
      "soft candle cream",
      "warm winter red accent",
    ],
    materials: [
      "dense warm-white fairy-light strands",
      "wreath-mounted mini lights",
      "candle-style window and porch fixtures",
      "lit garlands on rails and planters",
    ],
    signatureItems: [
      "warm fairy lights wrapped through trees and railings",
      "a lit wreath on an entry door with candle accents in windows",
      "soft sparkle blanketing shrubs and planters",
    ],
    lightingCharacter:
      "dense warm-white fairy sparkle against a deep-blue winter dusk with soft amber haze",
    moodKeywords: ["festive", "sparkling", "seasonal"],
    actionMode: "overlay",
    guidanceBand: "faithful",
    references: placeholderRefs("festive-holiday"),
  },

  [OutdoorLightingStyle.poolside]: {
    coreAesthetic:
      "poolside evening lighting with submerged pool lights, soft perimeter glow, and reflections on still water",
    colorPalette: [
      "cool pool aqua",
      "warm deck amber",
      "deep dusk blue",
      "sun-bleached timber",
    ],
    materials: [
      "submerged underwater pool lights",
      "low deck perimeter lights",
      "warm lanterns or wall-wash fixtures on the pool surround",
      "reflective pool surface",
    ],
    signatureItems: [
      "an illuminated pool glowing aqua against the evening sky",
      "warm perimeter lights reflected on the still water",
      "soft lantern glow on the surrounding deck and seating",
    ],
    lightingCharacter:
      "cool underwater glow paired with warm surround lights and mirror-still water reflections at dusk",
    moodKeywords: ["resort", "reflective", "serene"],
    actionMode: "transform",
    guidanceBand: "faithful",
    references: placeholderRefs("poolside-lighting"),
  },

  [OutdoorLightingStyle.torchlight]: {
    coreAesthetic:
      "tropical torchlit outdoor scene with live-flame tiki torches and warm flickering glow",
    colorPalette: [
      "warm flame orange",
      "rich ember amber",
      "deep tropical night",
      "bamboo tan",
    ],
    materials: [
      "bamboo or metal tiki torches",
      "live-flame fire accents",
      "warm low-voltage ground spots for planting",
      "rattan or teak surrounds",
    ],
    signatureItems: [
      "a row of live-flame tiki torches lining the deck or path",
      "flickering ember glow catching foliage and surfaces",
      "warm firelight reflected in water or on stone",
    ],
    lightingCharacter:
      "warm flickering 2000K flame light with live-fire motion, amber highlights, and soft tropical night haze",
    moodKeywords: ["tropical", "flickering", "primal"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("torchlight"),
  },
};
