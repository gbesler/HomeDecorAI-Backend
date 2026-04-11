/**
 * Garden styles dictionary — 10 entries covering the iOS `GardenStyle` enum.
 * Reuses the `StyleEntry` shape so the existing `checkStyleEntry` validator
 * works unchanged. The `signatureItems` slot holds signature plants and
 * features for each style, and `materials` holds hardscape finishes.
 *
 * Mode conventions:
 * - `transform` for styles that restyle the whole garden (9 of 10)
 * - `overlay` + `recipeRef` for christmas seasonal layering
 *
 * R25 editorial validation: `references` must have >= 3 entries per style.
 */

import { GardenStyle } from "../../../schemas/generated/types/gardenStyle.js";
import type { GardenStylesDict } from "../types.js";

function placeholderRefs(keyword: string): string[] {
  const q = encodeURIComponent(keyword);
  return [
    `https://www.pinterest.com/search/pins/?q=${q}+garden+design`,
    `https://www.gardenista.com/?s=${q}`,
    `https://www.houzz.com/photos/query/${q}--garden`,
  ];
}

export const gardenStyles: GardenStylesDict = {
  [GardenStyle.cozy]: {
    coreAesthetic: "intimate, layered, inviting small-scale garden",
    colorPalette: ["warm terracotta", "cream blossom", "soft sage", "muted rose"],
    materials: ["weathered brick pavers", "aged timber", "terracotta pots"],
    signatureItems: [
      "a small wooden bench beneath climbing vines",
      "layered container plantings in terracotta pots",
      "soft perennial borders along a curving path",
    ],
    lightingCharacter: "warm filtered afternoon light through small trees",
    moodKeywords: ["cozy", "inviting", "layered"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("cozy"),
  },

  [GardenStyle.englishCottage]: {
    coreAesthetic: "romantic English cottage garden with abundant perennials",
    colorPalette: ["rose pink", "lavender", "cream white", "soft sage"],
    materials: ["weathered stone pavers", "aged brick edging", "lichen-covered timber"],
    signatureItems: [
      "abundant perennial borders overflowing onto a stone path",
      "climbing roses on a timber arch",
      "a rustic wooden gate framed by lavender",
    ],
    lightingCharacter: "soft overcast English morning light",
    moodKeywords: ["romantic", "abundant", "storybook"],
    actionMode: "transform",
    guidanceBand: "creative",
    references: placeholderRefs("english-cottage"),
  },

  [GardenStyle.christmas]: {
    coreAesthetic: "festive winter garden with holiday accents",
    colorPalette: ["deep evergreen", "holly red", "polished brass", "candlelight amber"],
    materials: ["fir garland", "red velvet ribbon", "aged timber", "brass lanterns"],
    signatureItems: [
      "fir garlands wrapped around garden fencing",
      "warm white string lights draped through shrubs",
      "a festive wreath on a garden gate",
    ],
    lightingCharacter: "warm candlelight glow with festive string lights",
    moodKeywords: ["festive", "warm", "seasonal"],
    actionMode: "overlay",
    guidanceBand: "balanced",
    references: placeholderRefs("christmas-garden"),
  },

  [GardenStyle.french]: {
    coreAesthetic: "formal French parterre with clipped geometry",
    colorPalette: ["boxwood green", "gravel beige", "classical cream", "soft lavender"],
    materials: [
      "pea gravel pathways",
      "limestone edging",
      "wrought iron furniture",
    ],
    signatureItems: [
      "clipped boxwood parterres in geometric patterns",
      "a central stone fountain or urn",
      "symmetrical gravel pathways",
    ],
    lightingCharacter: "bright even Provençal daylight",
    moodKeywords: ["formal", "refined", "symmetrical"],
    actionMode: "transform",
    guidanceBand: "faithful",
    references: placeholderRefs("french-parterre"),
  },

  [GardenStyle.tropical]: {
    coreAesthetic: "lush tropical garden with dense foliage layers",
    colorPalette: ["deep jungle green", "coral bloom", "bamboo tan", "hibiscus pink"],
    materials: ["bamboo edging", "smooth river stones", "teak decking"],
    signatureItems: [
      "large monstera and banana leaf plants",
      "a winding path through dense tropical foliage",
      "a tropical flowering hibiscus or bird-of-paradise cluster",
    ],
    lightingCharacter: "bright filtered tropical daylight through leaf canopy",
    moodKeywords: ["lush", "vibrant", "resort"],
    actionMode: "transform",
    guidanceBand: "creative",
    references: placeholderRefs("tropical-garden"),
  },

  [GardenStyle.japanese]: {
    coreAesthetic: "serene Japanese garden with moss, stone, and restraint",
    colorPalette: ["moss green", "stone gray", "bamboo tan", "maple crimson"],
    materials: [
      "raked gravel",
      "natural boulders",
      "moss ground cover",
      "bamboo fencing",
    ],
    signatureItems: [
      "a Japanese maple as a focal specimen",
      "a raked gravel area with placed boulders",
      "a stone lantern beside a moss-covered path",
    ],
    lightingCharacter: "soft diffused morning light through maple canopy",
    moodKeywords: ["serene", "restrained", "contemplative"],
    actionMode: "transform",
    guidanceBand: "faithful",
    references: placeholderRefs("japanese-garden"),
  },

  [GardenStyle.mediterranean]: {
    coreAesthetic: "sun-drenched Mediterranean garden with drought-tolerant planting",
    colorPalette: ["olive green", "terracotta", "lavender purple", "sun-bleached cream"],
    materials: ["terracotta pots", "limestone pavers", "aged timber pergola"],
    signatureItems: [
      "olive trees and lavender borders",
      "terracotta pots planted with rosemary and thyme",
      "a gravel courtyard under a timber pergola",
    ],
    lightingCharacter: "bright golden Mediterranean afternoon light",
    moodKeywords: ["sun-drenched", "aromatic", "relaxed"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("mediterranean-garden"),
  },

  [GardenStyle.modern]: {
    coreAesthetic: "clean-lined modern garden with architectural planting",
    colorPalette: ["deep green", "warm gray", "matte black", "white stone"],
    materials: [
      "concrete pavers",
      "corten steel edging",
      "black basalt gravel",
      "smooth hardwood decking",
    ],
    signatureItems: [
      "architectural ornamental grasses in grid plantings",
      "a linear water feature set in concrete",
      "sculptural hardwood seating",
    ],
    lightingCharacter: "clean even daylight with sharp directional shadows",
    moodKeywords: ["minimal", "architectural", "intentional"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("modern-garden"),
  },

  [GardenStyle.rustic]: {
    coreAesthetic: "rugged rustic garden with natural materials and wildness",
    colorPalette: ["moss green", "stone gray", "warm rust", "weathered timber"],
    materials: [
      "stacked dry stone walls",
      "weathered timber",
      "natural gravel",
      "aged wrought iron",
    ],
    signatureItems: [
      "a dry stone wall border",
      "a weathered timber bench near a wildflower bed",
      "rustic metal garden accents",
    ],
    lightingCharacter: "warm late-afternoon sun through scattered trees",
    moodKeywords: ["natural", "rugged", "grounded"],
    actionMode: "transform",
    guidanceBand: "balanced",
    references: placeholderRefs("rustic-garden"),
  },

  [GardenStyle.wildflower]: {
    coreAesthetic: "naturalistic wildflower meadow with loose native planting",
    colorPalette: ["meadow green", "poppy red", "cornflower blue", "buttercup yellow"],
    materials: ["mulched natural paths", "weathered timber", "native stone"],
    signatureItems: [
      "a loose wildflower meadow with mixed native perennials",
      "a simple mulch path winding through the meadow",
      "a low timber bench facing the flowers",
    ],
    lightingCharacter: "bright open meadow daylight with a light breeze",
    moodKeywords: ["naturalistic", "free", "abundant"],
    actionMode: "transform",
    guidanceBand: "creative",
    references: placeholderRefs("wildflower-meadow"),
  },
};
