/**
 * Garden items dictionary — 10 entries covering the iOS `GardenItem` enum.
 * Feeds the garden builder's items layer (multi-select).
 *
 * `surpriseMe` is a sentinel with an empty phrase — the builder short-circuits
 * the items layer when it appears in the selection, letting the style entry's
 * signatureItems drive the composition instead.
 */

import { GardenItem } from "../../../schemas/generated/types/gardenItem.js";
import type { GardenItemsDict } from "../types.js";

export const gardenItems: GardenItemsDict = {
  [GardenItem.surpriseMe]: {
    phrase: "",
  },

  [GardenItem.furniture]: {
    phrase: "outdoor lounge furniture",
    placementHint: "arranged in a social seating cluster",
  },

  [GardenItem.swimmingPool]: {
    phrase: "a rectangular swimming pool with a clean stone coping",
    placementHint: "positioned as a focal feature of the garden",
  },

  [GardenItem.gazebo]: {
    phrase: "a garden gazebo with a hipped roof",
    placementHint: "placed on a stone pad as a shaded gathering spot",
  },

  [GardenItem.hedge]: {
    phrase: "clipped evergreen hedges",
    placementHint: "forming a clean boundary along the garden edge",
  },

  [GardenItem.firePit]: {
    phrase: "a circular stone fire pit",
    placementHint: "with seating arranged around a gravel or stone pad",
  },

  [GardenItem.fountain]: {
    phrase: "a stone fountain with a gentle water feature",
    placementHint: "as a central focal point",
  },

  [GardenItem.pathway]: {
    phrase: "a curving natural-stone pathway",
    placementHint: "winding through the planting beds",
  },

  [GardenItem.pergola]: {
    phrase: "a timber pergola draped with climbing plants",
    placementHint: "shading a dining or seating area",
  },

  [GardenItem.flowerBed]: {
    phrase: "abundant flower beds in layered plantings",
    placementHint: "bordering pathways and seating areas",
  },
};
