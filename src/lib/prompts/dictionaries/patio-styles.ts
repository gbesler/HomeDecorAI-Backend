/**
 * Patio styles dictionary — 8 entries covering the iOS `PatioStyle` enum.
 * Reuses the `StyleEntry` shape so the existing `checkStyleEntry` validator
 * works unchanged. The `signatureItems` slot holds signature outdoor furniture
 * and features for each style, and `materials` holds hardscape + surface finishes.
 *
 * R25 editorial validation: `references` must have >= 3 entries per style.
 */

import { PatioStyle } from "../../../schemas/generated/types/patioStyle.js";
import type { PatioStylesDict } from "../types.js";

function placeholderRefs(keyword: string): string[] {
  const q = encodeURIComponent(keyword);
  return [
    `https://www.pinterest.com/search/pins/?q=${q}+patio+design`,
    `https://www.gardenista.com/?s=${q}`,
    `https://www.houzz.com/photos/query/${q}--patio`,
  ];
}

export const patioStyles: PatioStylesDict = {
  [PatioStyle.outdoorDining]: {
    coreAesthetic: "warm outdoor dining patio with a welcoming communal table",
    colorPalette: [
      "warm timber",
      "soft cream",
      "muted sage",
      "candlelight amber",
    ],
    materials: [
      "natural timber dining table",
      "cushioned dining chairs",
      "stone or timber decking",
      "woven pendant shades",
    ],
    signatureItems: [
      "a long timber dining table set for a meal",
      "string bistro lights draped overhead",
      "potted greenery framing the dining zone",
    ],
    lightingCharacter:
      "warm late-afternoon light transitioning to candlelight and string lights",
    moodKeywords: ["welcoming", "warm", "convivial"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("outdoor-dining"),
  },

  [PatioStyle.lounge]: {
    coreAesthetic:
      "relaxed outdoor lounge patio with deep modular seating around a low table",
    colorPalette: [
      "warm charcoal",
      "soft linen",
      "aged teak",
      "muted terracotta",
    ],
    materials: [
      "weather-resistant modular sofa",
      "low timber coffee table",
      "plush outdoor cushions",
      "woven outdoor rug",
    ],
    signatureItems: [
      "a deep modular outdoor sofa with layered cushions",
      "a low timber coffee table anchoring the seating",
      "an outdoor rug grounding the lounge zone",
    ],
    lightingCharacter:
      "soft golden afternoon light with warm lantern and sconce accents in the evening",
    moodKeywords: ["relaxed", "layered", "resort-like"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("outdoor-lounge"),
  },

  [PatioStyle.bistro]: {
    coreAesthetic:
      "intimate European bistro patio with a small café table and ornamental planting",
    colorPalette: [
      "wrought iron black",
      "café cream",
      "soft green",
      "warm blossom pink",
    ],
    materials: [
      "wrought iron café table",
      "wrought iron bistro chairs",
      "pea gravel or tile flooring",
      "terracotta planters",
    ],
    signatureItems: [
      "a small round wrought iron bistro table with two chairs",
      "abundant potted flowers in terracotta pots",
      "a trellis of climbing vines framing the space",
    ],
    lightingCharacter:
      "soft Parisian late-afternoon light with a single overhead pendant for evening",
    moodKeywords: ["intimate", "romantic", "European"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("bistro-patio"),
  },

  [PatioStyle.sundeck]: {
    coreAesthetic:
      "bright sundeck patio with sun loungers oriented toward open sky",
    colorPalette: [
      "sun-bleached timber",
      "crisp white",
      "soft sand",
      "resort teal",
    ],
    materials: [
      "weathered teak sun loungers",
      "pale timber decking",
      "lightweight umbrella canopy",
      "crisp white cushions",
    ],
    signatureItems: [
      "a pair of teak sun loungers with white cushions",
      "a large market umbrella shading the loungers",
      "a small side table between the loungers",
    ],
    lightingCharacter: "bright open midday sunlight with clean directional shadows",
    moodKeywords: ["bright", "resort", "breezy"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("sundeck"),
  },

  [PatioStyle.firePit]: {
    coreAesthetic:
      "cozy fire pit patio with seating gathered around a central flame",
    colorPalette: [
      "warm ember orange",
      "charcoal stone",
      "aged timber",
      "deep forest green",
    ],
    materials: [
      "stone or steel fire pit",
      "timber Adirondack chairs",
      "flagstone or gravel ground plane",
      "wool throws",
    ],
    signatureItems: [
      "a round stone fire pit with a live flame",
      "a circle of timber chairs around the fire pit",
      "a stack of split firewood nearby",
    ],
    lightingCharacter:
      "warm ember glow from the fire pit with soft twilight sky",
    moodKeywords: ["cozy", "gathering", "warm"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("fire-pit-patio"),
  },

  [PatioStyle.pergola]: {
    coreAesthetic:
      "shaded pergola patio with a timber overhead structure and climbing greenery",
    colorPalette: [
      "warm timber",
      "soft sage",
      "natural stone gray",
      "muted cream",
    ],
    materials: [
      "timber pergola beams",
      "climbing wisteria or grape vines",
      "stone or timber flooring",
      "cushioned outdoor seating",
    ],
    signatureItems: [
      "a timber pergola structure overhead",
      "climbing vines weaving through the pergola beams",
      "a shaded seating group beneath the pergola",
    ],
    lightingCharacter:
      "dappled afternoon light filtering through pergola beams and vines",
    moodKeywords: ["shaded", "architectural", "romantic"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("pergola-patio"),
  },

  [PatioStyle.zenDeck]: {
    coreAesthetic:
      "minimal Zen-inspired deck patio with restrained materials and calm planting",
    colorPalette: [
      "warm timber",
      "moss green",
      "stone gray",
      "soft paper white",
    ],
    materials: [
      "smooth hardwood decking",
      "natural boulders",
      "raked gravel accents",
      "bamboo fencing",
    ],
    signatureItems: [
      "a low timber deck with minimal furniture",
      "a cluster of natural boulders beside the deck",
      "a sculpted specimen plant in a simple stone planter",
    ],
    lightingCharacter:
      "soft diffused morning light with gentle directional shadows",
    moodKeywords: ["serene", "minimal", "contemplative"],
    actionMode: "transform",
    guidanceBand: "faithful",
    references: placeholderRefs("zen-deck"),
  },

  [PatioStyle.coastal]: {
    coreAesthetic:
      "breezy coastal patio with light materials and a blue-and-white palette",
    colorPalette: [
      "soft white",
      "coastal blue",
      "bleached driftwood",
      "sandy beige",
    ],
    materials: [
      "whitewashed timber furniture",
      "striped outdoor cushions",
      "weathered rope accents",
      "pale decking or stone",
    ],
    signatureItems: [
      "whitewashed timber seating with blue-and-white cushions",
      "a striped outdoor rug underfoot",
      "lantern accents with rope detailing",
    ],
    lightingCharacter: "bright breezy coastal daylight with soft sea-salt haze",
    moodKeywords: ["breezy", "bright", "coastal"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("coastal-patio"),
  },
};
