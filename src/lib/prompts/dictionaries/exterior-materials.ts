/**
 * Exterior materials dictionary — 9 concrete facade materials consumed by
 * the exterior-painting tool. The 10th iOS id (`keepOriginal`) is a
 * sentinel handled inline in the builder: it skips the dictionary lookup
 * entirely and composes a paint-only directive.
 *
 * Entries are short because the prompt is composed with structural
 * preservation + photography quality primitives on top — each entry only
 * needs to describe the material surface itself, not how to light or
 * frame the building.
 */

import { ExteriorMaterial } from "../../../schemas/generated/types/exteriorMaterial.js";
import type { ExteriorMaterialsDict } from "../types.js";

export const exteriorMaterials: ExteriorMaterialsDict = {
  [ExteriorMaterial.texturedBrick]: {
    label: "textured brick facade",
    description:
      "Hand-laid textured brick cladding with visible mortar joints and warm tonal variation.",
    descriptors: ["hand-laid", "visible mortar joints", "warm variation"],
  },

  [ExteriorMaterial.vinylSiding]: {
    label: "vinyl siding",
    description:
      "Horizontal vinyl siding boards with clean overlap seams and a uniform low-sheen finish.",
    descriptors: ["horizontal boards", "clean seams", "uniform low sheen"],
  },

  [ExteriorMaterial.smoothStucco]: {
    label: "smooth stucco",
    description:
      "Seamless smooth stucco finish with soft trowel variation and a matte surface.",
    descriptors: ["seamless", "softly troweled", "matte"],
  },

  [ExteriorMaterial.naturalStone]: {
    label: "natural stone cladding",
    description:
      "Irregular natural stone cladding with varied shapes, warm mineral tones, and tactile texture.",
    descriptors: ["irregular shapes", "mineral tones", "tactile"],
  },

  [ExteriorMaterial.woodCladding]: {
    label: "wood cladding",
    description:
      "Vertical wood plank cladding with visible grain, warm tones, and tight reveal lines.",
    descriptors: ["vertical planks", "visible grain", "warm tones"],
  },

  [ExteriorMaterial.metalPanel]: {
    label: "metal panel cladding",
    description:
      "Matte standing-seam metal panels with crisp edges and uniform paint-grade finish.",
    descriptors: ["standing-seam", "crisp edges", "matte finish"],
  },

  [ExteriorMaterial.fiberCement]: {
    label: "fiber cement siding",
    description:
      "Matte fiber cement boards with subtle shadow lines and a clean, even surface.",
    descriptors: ["subtle shadow lines", "matte", "even surface"],
  },

  [ExteriorMaterial.limestoneFacade]: {
    label: "limestone facade",
    description:
      "Cut limestone panels with soft cream tones, fine grain, and precise joint lines.",
    descriptors: ["cream-toned", "fine grain", "precise joints"],
  },

  [ExteriorMaterial.concreteFacade]: {
    label: "concrete facade",
    description:
      "Exposed board-formed concrete with restrained texture and cool neutral tones.",
    descriptors: ["board-formed", "restrained texture", "cool neutrals"],
  },
};
