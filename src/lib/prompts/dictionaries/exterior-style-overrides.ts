/**
 * Exterior-specific overrides for `designStyles`.
 *
 * The `designStyles` dictionary is authored for interior contexts: its
 * `materials` slot lists fabrics/furniture finishes (wool rug, linen, brushed
 * brass) and `colorPalette` is tuned to indoor rooms. When the exterior
 * builder reuses the same style entry, those materials and (on `surpriseMe`
 * palette) colors bleed into the prompt and the model either picks absurd
 * cladding or produces an under-powered redesign.
 *
 * This dictionary provides a per-style exterior vocabulary: facade/cladding
 * materials and an optional palette hint used only when the user selects
 * `surpriseMe` and the exterior palette dictionary therefore produces no
 * override. Styles not listed here fall back to the interior values.
 */

import { DesignStyle } from "../../../schemas/generated/types/designStyle.js";

export interface ExteriorStyleOverride {
  /** 3-5 exterior cladding / facade materials to drive the prompt. */
  materials: string[];
  /**
   * Optional exterior-appropriate palette. Used only as the `surpriseMe`
   * fallback; a concrete `exteriorPalettes` entry still wins when the user
   * picks one.
   */
  colorPalette?: string[];
}

export const exteriorStyleOverrides: Partial<
  Record<DesignStyle, ExteriorStyleOverride>
> = {
  [DesignStyle.modern]: {
    materials: [
      "smooth stucco render",
      "dark fiber-cement panels",
      "standing-seam metal roof",
      "large black-frame glazing",
    ],
    colorPalette: ["warm gray stucco", "matte black trim", "smoked oak accents", "off-white"],
  },

  [DesignStyle.minimalist]: {
    materials: [
      "white lime-wash stucco",
      "smooth render",
      "concealed flashing",
      "flat parapet roof",
    ],
    colorPalette: ["chalk white", "pale concrete gray", "matte black trim"],
  },

  [DesignStyle.scandinavian]: {
    materials: [
      "vertical pale wood cladding",
      "white painted timber",
      "dark metal roof",
      "black window frames",
    ],
    colorPalette: ["pale birch cladding", "chalk white render", "muted sage trim", "black frames"],
  },

  [DesignStyle.industrial]: {
    materials: [
      "exposed red brick facade",
      "blackened steel window frames",
      "weathered corten cladding",
      "concrete lintels",
    ],
    colorPalette: ["raw red brick", "charcoal trim", "rust corten", "smoked glass"],
  },

  [DesignStyle.bohemian]: {
    materials: [
      "hand-troweled warm stucco",
      "terracotta tile roof",
      "carved timber accents",
      "mosaic tile inlays",
    ],
    colorPalette: ["terracotta", "deep teal shutters", "mustard trim", "burnt orange accents"],
  },

  [DesignStyle.contemporary]: {
    materials: [
      "smooth painted render",
      "horizontal timber cladding",
      "aluminum composite panels",
      "slim-frame glazing",
    ],
    colorPalette: ["soft taupe render", "warm ivory trim", "matte black accents", "muted sage"],
  },

  [DesignStyle.midCentury]: {
    materials: [
      "horizontal timber cladding",
      "painted board-and-batten",
      "brick accent wall",
      "low-slope overhanging roof",
    ],
    colorPalette: ["warm walnut cladding", "olive green trim", "mustard accents", "cream stucco"],
  },

  [DesignStyle.coastal]: {
    materials: [
      "white painted shingle siding",
      "board-and-batten",
      "weathered cedar",
      "bright white trim",
    ],
    colorPalette: ["crisp white siding", "soft seafoam trim", "driftwood gray", "pale sand"],
  },

  [DesignStyle.farmhouse]: {
    materials: [
      "white painted horizontal siding",
      "black standing-seam metal roof",
      "painted board-and-batten",
      "deep porch timber",
    ],
    colorPalette: ["crisp white siding", "matte black trim", "warm oak porch", "sage accents"],
  },

  [DesignStyle.japandi]: {
    materials: [
      "charred shou-sugi-ban timber",
      "smooth gray stucco",
      "dark standing-seam roof",
      "minimal timber trim",
    ],
    colorPalette: ["charred black timber", "warm oat stucco", "soft bamboo tan", "matte black"],
  },

  [DesignStyle.artDeco]: {
    materials: [
      "smooth limestone cladding",
      "polished metal trim",
      "geometric tile inlays",
      "ornamental stepped parapet",
    ],
    colorPalette: ["cream limestone", "polished brass trim", "deep navy accents", "jade details"],
  },

  [DesignStyle.traditional]: {
    materials: [
      "red brick masonry",
      "painted timber trim",
      "slate or shingle roof",
      "white six-over-six windows",
    ],
    colorPalette: ["warm red brick", "crisp white trim", "forest green shutters", "black accents"],
  },

  [DesignStyle.tropical]: {
    materials: [
      "whitewashed stucco",
      "natural teak cladding",
      "terracotta or thatched roof",
      "wide timber louvers",
    ],
    colorPalette: ["whitewashed stucco", "warm teak cladding", "terracotta tile", "deep palm green trim"],
  },

  [DesignStyle.rustic]: {
    materials: [
      "rough stone masonry base",
      "reclaimed timber cladding",
      "weathered metal roof",
      "timber-framed windows",
    ],
    colorPalette: ["weathered stone", "warm reclaimed timber", "rust-red metal roof", "aged iron trim"],
  },

  [DesignStyle.luxury]: {
    materials: [
      "polished travertine cladding",
      "honed limestone",
      "bronze window frames",
      "standing-seam metal or slate roof",
    ],
    colorPalette: ["warm cream limestone", "bronze trim", "deep walnut accents", "charcoal slate"],
  },

  [DesignStyle.cozy]: {
    materials: [
      "warm painted horizontal siding",
      "stone base skirt",
      "timber porch columns",
      "shingle roof",
    ],
    colorPalette: ["warm butter cream siding", "stone base", "warm oak porch", "sage trim"],
  },

  [DesignStyle.christmas]: {
    materials: [
      "existing facade kept intact",
      "evergreen garlands on eaves",
      "warm white string lights",
      "wreaths on doors and windows",
    ],
    colorPalette: ["deep evergreen", "warm white lights", "crimson ribbon accents", "soft snow white"],
  },

  [DesignStyle.airbnb]: {
    materials: [
      "smooth painted render",
      "neutral horizontal cladding",
      "clean trim lines",
      "broadly appealing roof finish",
    ],
    colorPalette: ["warm off-white", "soft sand trim", "matte black accents", "muted sage"],
  },
};
