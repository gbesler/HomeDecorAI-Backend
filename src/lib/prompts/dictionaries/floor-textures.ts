/**
 * Floor textures dictionary — 16 entries covering every value in the iOS
 * `FloorTexture.id` constant set. Fed to the floor-restyle prompt builder
 * when `floorStyleMode === "texture"`.
 *
 * Descriptions are short because the prompt is composed with structural
 * preservation + photography quality primitives on top — each entry only
 * needs to describe the finish itself, not how to light or frame it.
 */

import { FloorTexture } from "../../../schemas/generated/types/floorTexture.js";
import type { FloorTexturesDict } from "../types.js";

export const floorTextures: FloorTexturesDict = {
  // ─── Wood ───────────────────────────────────────────────────────────────
  [FloorTexture.oakWood]: {
    category: "wood",
    label: "natural oak herringbone parquet",
    description:
      "Wide natural oak planks laid in a classic herringbone pattern with a warm honey tone, prominent grain, visible knots, and a matte satin finish.",
    descriptors: ["wide oak planks", "herringbone layout", "honey tone with prominent knots"],
    lightingCharacter:
      "Warm ambient daylight; the grain reads as a gentle rhythm across the floor.",
  },
  [FloorTexture.walnut]: {
    category: "wood",
    label: "walnut hardwood flooring",
    description:
      "Rich walnut planks with deep chocolate tones, fine sweeping grain, and a polished high-gloss lacquered finish.",
    descriptors: ["deep chocolate", "sweeping grain", "polished high gloss"],
    lightingCharacter:
      "Warm directional daylight; crisp specular highlights run along the polished planks.",
  },
  [FloorTexture.bamboo]: {
    category: "wood",
    label: "bamboo flooring",
    description:
      "Vertical-grain bamboo planks with a light blonde tone, fine pinstripe lines along each plank, and a smooth low-luster finish.",
    descriptors: ["pale blonde", "vertical pinstripe grain", "smooth low-luster"],
    lightingCharacter:
      "Soft even daylight; the pale surface brightens the room uniformly.",
  },
  [FloorTexture.cherry]: {
    category: "wood",
    label: "cherry hardwood flooring",
    description:
      "Cherry wood planks with reddish-brown warmth, swirling figured grain, and a glossy lacquered finish that reflects light richly.",
    descriptors: ["reddish-brown warmth", "figured swirl grain", "glossy lacquer"],
    lightingCharacter:
      "Warm indirect daylight; bright specular reflections highlight the polished cherry surface.",
  },

  // ─── Marble ─────────────────────────────────────────────────────────────
  [FloorTexture.whiteMarble]: {
    category: "marble",
    label: "polished white marble flooring",
    description:
      "Polished white marble tiles in a regular square grid with bold gray veining and a mirror finish.",
    descriptors: ["bold gray veining", "polished", "square-tile grid"],
    lightingCharacter:
      "Bright even daylight; veining and reflections remain crisp.",
  },
  [FloorTexture.travertine]: {
    category: "marble",
    label: "travertine stone flooring",
    description:
      "Honed travertine tiles with creamy beige tones, natural pitting, and a subtle matte finish.",
    descriptors: ["creamy beige", "natural pitting", "honed matte"],
    lightingCharacter:
      "Soft directional daylight; the porous texture catches gentle side light.",
  },
  [FloorTexture.greenMarble]: {
    category: "marble",
    label: "green marble flooring",
    description:
      "Polished green marble slabs with dramatic white veining and a rich emerald undertone.",
    descriptors: ["emerald undertone", "dramatic veining", "polished"],
    lightingCharacter:
      "Cool even daylight; the green tone deepens away from direct sun.",
  },
  [FloorTexture.beigeMarble]: {
    category: "marble",
    label: "beige marble flooring",
    description:
      "Polished beige marble slabs with warm cream-sand tones and distinctive warm gold veining threading across the surface.",
    descriptors: ["warm cream-sand tone", "warm gold veining", "polished"],
    lightingCharacter:
      "Warm indirect daylight; the gold veining catches gentle highlights against the cream slabs.",
  },

  // ─── Porcelain ──────────────────────────────────────────────────────────
  [FloorTexture.patternTile]: {
    category: "porcelain",
    label: "patterned porcelain tile flooring",
    description:
      "Porcelain tile flooring laid in a checkerboard arrangement of plain cream tiles alternating with ornate gray damask-patterned tiles, crisp grout lines, matte glaze.",
    descriptors: ["checkerboard layout", "alternating plain and damask tiles", "matte glaze"],
    lightingCharacter:
      "Soft diffused daylight; the pattern reads clearly without glare.",
  },
  [FloorTexture.checkerboard]: {
    category: "porcelain",
    label: "black-and-white checkerboard tile flooring",
    description:
      "Classic black-and-white checkerboard tiles laid on a diagonal with a semi-gloss finish.",
    descriptors: ["high contrast", "diagonal grid", "semi-gloss"],
    lightingCharacter:
      "Bright balanced daylight; the contrast between tiles stays sharp.",
  },
  [FloorTexture.hexagon]: {
    category: "porcelain",
    label: "hexagonal porcelain tile flooring",
    description:
      "Hexagonal porcelain tiles in a tight honeycomb layout, mixing cream, warm beige, and pale gray tones, with thin grout lines and a matte finish.",
    descriptors: ["honeycomb layout", "cream-beige-gray mix", "matte"],
    lightingCharacter:
      "Soft even daylight; the hexagonal grid reads as a calm repeating rhythm.",
  },
  [FloorTexture.terracotta]: {
    category: "porcelain",
    label: "terracotta tile flooring",
    description:
      "Hand-finished terracotta tiles with warm burnt-orange tones, slight tonal variation, and a rustic matte surface.",
    descriptors: ["burnt-orange warmth", "tonal variation", "rustic matte"],
    lightingCharacter:
      "Warm directional daylight; the earthy tones deepen toward the corners.",
  },

  // ─── Planks ─────────────────────────────────────────────────────────────
  [FloorTexture.naturalPlank]: {
    category: "planks",
    label: "natural-finish plank flooring",
    description:
      "Narrow to medium-width wood planks in mixed lengths with a natural clear finish, visible knots, warm honey tone, and a soft matte sheen.",
    descriptors: ["narrow-to-medium planks", "mixed lengths", "natural clear finish with knots"],
    lightingCharacter:
      "Warm ambient daylight; the grain reads evenly across the planks.",
  },
  [FloorTexture.whitewashedPlank]: {
    category: "planks",
    label: "whitewashed wide-plank flooring",
    description:
      "Wide wood planks with a whitewashed limed finish that reveals the grain through a soft white veil.",
    descriptors: ["limed whitewash", "veiled grain", "chalky matte"],
    lightingCharacter:
      "Soft diffused daylight; the pale surface brightens the room with minimal glare.",
  },
  [FloorTexture.darkPlank]: {
    category: "planks",
    label: "dark-stained wide-plank flooring",
    description:
      "Wide wood planks with a deep ebony stain, tight grain, and a low-sheen finish.",
    descriptors: ["ebony stain", "tight grain", "low sheen"],
    lightingCharacter:
      "Warm directional daylight; the dark surface anchors the room without specular highlights.",
  },
  [FloorTexture.herringbone]: {
    category: "planks",
    label: "herringbone parquet flooring",
    description:
      "Oak herringbone parquet laid in a tight chevron pattern with a warm mid-tone stain and a satin finish.",
    descriptors: ["chevron pattern", "warm mid-tone", "satin finish"],
    lightingCharacter:
      "Warm indirect daylight; the herringbone geometry reads as a crisp repeating rhythm.",
  },
};
