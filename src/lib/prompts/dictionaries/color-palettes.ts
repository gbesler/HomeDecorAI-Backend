/**
 * Color palette catalogs — shared by exterior + garden tools.
 *
 * Each entry is a concrete swatch (3-4 color names) plus a short mood word
 * that the prompt builder injects alongside the palette string.
 *
 * `surpriseMe` is a sentinel with an empty swatch — the builder skips the
 * palette override and lets the style entry's native palette drive the
 * composition.
 */

import { ExteriorColorPalette } from "../../../schemas/generated/types/exteriorColorPalette.js";
import { GardenColorPalette } from "../../../schemas/generated/types/gardenColorPalette.js";
import type {
  ExteriorColorPalettesDict,
  GardenColorPalettesDict,
} from "../types.js";

// ─── Exterior palettes ─────────────────────────────────────────────────────

export const exteriorPalettes: ExteriorColorPalettesDict = {
  [ExteriorColorPalette.surpriseMe]: { swatch: [], mood: "" },

  [ExteriorColorPalette.laidBackBlues]: {
    swatch: ["dusty slate blue", "soft chambray", "weathered denim", "cool gray"],
    mood: "calm",
  },

  [ExteriorColorPalette.highContrast]: {
    swatch: ["matte charcoal", "crisp white trim", "black window frames", "warm oak accents"],
    mood: "bold",
  },

  [ExteriorColorPalette.warmTones]: {
    swatch: ["warm terracotta", "toasted almond", "honey oak", "burnt sienna"],
    mood: "welcoming",
  },

  [ExteriorColorPalette.pastelBreeze]: {
    swatch: ["soft mint", "powder blue", "pale butter", "blush cream"],
    mood: "airy",
  },

  [ExteriorColorPalette.peachyMeadow]: {
    swatch: ["peach blossom", "soft coral", "cream", "muted sage"],
    mood: "soft",
  },

  [ExteriorColorPalette.earthyNeutrals]: {
    swatch: ["warm stone", "soft taupe", "oat beige", "driftwood brown"],
    mood: "grounded",
  },

  [ExteriorColorPalette.forestGreens]: {
    swatch: ["deep forest green", "moss", "pine needle", "warm oak trim"],
    mood: "natural",
  },

  [ExteriorColorPalette.sunsetGlow]: {
    swatch: ["burnt orange", "warm rose", "golden amber", "dusty plum"],
    mood: "warm",
  },

  [ExteriorColorPalette.oceanBreeze]: {
    swatch: ["seafoam", "sand white", "driftwood gray", "deep navy accent"],
    mood: "breezy",
  },

  [ExteriorColorPalette.monochromeElegance]: {
    swatch: ["warm white", "soft dove gray", "graphite", "matte black"],
    mood: "refined",
  },

  [ExteriorColorPalette.desertSand]: {
    swatch: ["sand beige", "warm clay", "bleached cream", "soft terracotta"],
    mood: "sunbaked",
  },
};

// ─── Staging palettes ──────────────────────────────────────────────────────
//
// Virtual staging reuses the 12 exterior palette IDs (the iOS wizard shares
// `ColorPalette.stagingPalettes` with `exteriorPalettes`), but the swatches
// and moods are re-authored here for interior contexts. Exterior swatches
// (e.g. "weathered denim" cladding, "deep forest green" facade) don't
// translate 1:1 to interior furnishings, so this dictionary provides
// staging-appropriate equivalents for furniture, textiles, walls, and decor.

export const stagingPalettes: ExteriorColorPalettesDict = {
  [ExteriorColorPalette.surpriseMe]: { swatch: [], mood: "" },

  [ExteriorColorPalette.laidBackBlues]: {
    swatch: ["dusty blue upholstery", "soft chambray textiles", "cool gray walls", "warm oak accents"],
    mood: "calm",
  },

  [ExteriorColorPalette.highContrast]: {
    swatch: ["matte black accents", "crisp white walls", "charcoal upholstery", "warm oak floors"],
    mood: "bold",
  },

  [ExteriorColorPalette.warmTones]: {
    swatch: ["terracotta textiles", "toasted almond walls", "honey oak furniture", "warm brass accents"],
    mood: "welcoming",
  },

  [ExteriorColorPalette.pastelBreeze]: {
    swatch: ["soft mint accents", "powder blue textiles", "pale butter walls", "blush cream upholstery"],
    mood: "airy",
  },

  [ExteriorColorPalette.peachyMeadow]: {
    swatch: ["peach blush upholstery", "soft coral textiles", "cream walls", "muted sage greenery"],
    mood: "soft",
  },

  [ExteriorColorPalette.earthyNeutrals]: {
    swatch: ["warm stone walls", "soft taupe upholstery", "oat beige textiles", "driftwood wood tones"],
    mood: "grounded",
  },

  [ExteriorColorPalette.forestGreens]: {
    swatch: ["deep forest green upholstery", "moss cushions", "warm oak furniture", "cream walls"],
    mood: "natural",
  },

  [ExteriorColorPalette.sunsetGlow]: {
    swatch: ["burnt orange accents", "warm rose textiles", "golden amber lighting", "dusty plum cushions"],
    mood: "warm",
  },

  [ExteriorColorPalette.oceanBreeze]: {
    swatch: ["seafoam accents", "sand white walls", "driftwood furniture", "deep navy cushions"],
    mood: "breezy",
  },

  [ExteriorColorPalette.monochromeElegance]: {
    swatch: ["warm white walls", "soft dove gray upholstery", "graphite accents", "matte black details"],
    mood: "refined",
  },

  [ExteriorColorPalette.desertSand]: {
    swatch: ["sand beige walls", "warm clay textiles", "bleached cream cushions", "soft terracotta accents"],
    mood: "sunbaked",
  },
};

// ─── Garden palettes ───────────────────────────────────────────────────────

export const gardenPalettes: GardenColorPalettesDict = {
  [GardenColorPalette.surpriseMe]: { swatch: [], mood: "" },

  [GardenColorPalette.forestGreens]: {
    swatch: ["deep forest green", "moss", "fern", "pine needle"],
    mood: "natural",
  },

  [GardenColorPalette.earthyNeutrals]: {
    swatch: ["warm stone", "oat beige", "driftwood brown", "soft taupe"],
    mood: "grounded",
  },

  [GardenColorPalette.wildflowerMeadow]: {
    swatch: ["poppy red", "cornflower blue", "buttercup yellow", "meadow green"],
    mood: "abundant",
  },

  [GardenColorPalette.zenGarden]: {
    swatch: ["moss green", "river stone gray", "bamboo tan", "white gravel"],
    mood: "serene",
  },

  [GardenColorPalette.tropicalParadise]: {
    swatch: ["deep jungle green", "hibiscus pink", "coral", "banana yellow"],
    mood: "lush",
  },

  [GardenColorPalette.lavenderFields]: {
    swatch: ["deep lavender", "sage", "soft cream", "pale blue"],
    mood: "fragrant",
  },

  [GardenColorPalette.mossyStone]: {
    swatch: ["moss green", "weathered stone gray", "fern", "aged timber brown"],
    mood: "weathered",
  },

  [GardenColorPalette.autumnHarvest]: {
    swatch: ["burnt orange", "russet red", "warm ochre", "deep plum"],
    mood: "harvest",
  },

  [GardenColorPalette.springBloom]: {
    swatch: ["cherry blossom pink", "fresh green", "cream white", "soft yellow"],
    mood: "fresh",
  },

  [GardenColorPalette.succulentGreen]: {
    swatch: ["sage", "dusty jade", "chalky green", "terracotta accent"],
    mood: "arid",
  },

  [GardenColorPalette.terracottaGarden]: {
    swatch: ["terracotta", "warm clay", "olive green", "cream white"],
    mood: "warm",
  },
};
