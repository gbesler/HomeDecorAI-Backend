/**
 * Wall textures dictionary — 18 entries covering every value in the iOS
 * `WallTexture.id` constant set. Fed to the paint-walls prompt builder
 * when `wallStyleMode === "texture"`.
 *
 * Descriptions are short because the prompt is composed with structural
 * preservation + photography quality primitives on top — each entry only
 * needs to describe the finish itself, not how to light or frame it.
 */

import { WallTexture } from "../../../schemas/generated/types/wallTexture.js";
import type { WallTexturesDict } from "../types.js";

export const wallTextures: WallTexturesDict = {
  // ─── Paint finishes ─────────────────────────────────────────────────────
  [WallTexture.matte]: {
    category: "paintFinish",
    label: "matte-finish paint",
    description:
      "Matte paint with a flat, non-reflective surface and uniform coverage.",
    descriptors: ["velvet-like", "non-reflective", "uniform"],
    lightingCharacter:
      "Soft even daylight; the surface absorbs light without specular highlights.",
  },
  [WallTexture.satin]: {
    category: "paintFinish",
    label: "satin-finish paint",
    description:
      "Satin paint with a subtle pearl-like sheen that catches soft indirect light.",
    descriptors: ["soft sheen", "pearl-like", "smooth"],
    lightingCharacter:
      "Soft diffused daylight; gentle reflections on the painted plane.",
  },
  [WallTexture.glossy]: {
    category: "paintFinish",
    label: "high-gloss lacquer paint",
    description:
      "High-gloss lacquer paint with a wet-look reflective sheen and visible soft brush-stroke texture catching light.",
    descriptors: ["wet-look sheen", "visible brush texture", "lacquered"],
    lightingCharacter:
      "Bright balanced daylight; bright specular reflections sweep across the lacquered surface.",
  },
  [WallTexture.eggshell]: {
    category: "paintFinish",
    label: "eggshell-finish paint",
    description:
      "Eggshell paint with a very subtle low-sheen surface between matte and satin.",
    descriptors: ["low-sheen", "subtle luster", "even coverage"],
    lightingCharacter:
      "Soft indirect daylight; a faint luster along edges.",
  },

  // ─── Plaster ────────────────────────────────────────────────────────────
  [WallTexture.venetianPlaster]: {
    category: "plaster",
    label: "Venetian plaster",
    description:
      "Polished Venetian plaster with layered depth and a marble-like sheen.",
    descriptors: ["polished", "layered depth", "marble-like"],
    lightingCharacter:
      "Warm directional daylight; highlights reveal the polished strata.",
  },
  [WallTexture.limewash]: {
    category: "plaster",
    label: "limewash-finish plaster",
    description:
      "Limewash plaster with soft tonal variation and a chalky matte surface.",
    descriptors: ["chalky", "tonal variation", "breathable"],
    lightingCharacter:
      "Soft diffused daylight; subtle cloudy variation across the wall.",
  },
  [WallTexture.stucco]: {
    category: "plaster",
    label: "textured stucco",
    description:
      "Hand-applied stucco with coarse organic texture and irregular trowel marks.",
    descriptors: ["coarse", "irregular trowel marks", "organic"],
    lightingCharacter:
      "Side-raking daylight; pronounced shadow play across the texture.",
  },
  [WallTexture.concrete]: {
    category: "plaster",
    label: "polished concrete finish",
    description:
      "Polished concrete wall with a smooth cool gray surface, fine surface pitting, and soft cloudy tonal variation.",
    descriptors: ["cool gray", "fine pitting", "softly mottled"],
    lightingCharacter:
      "Cool even daylight; soft gradient shadows emphasize the concrete's mass.",
  },

  // ─── Stone / brick ──────────────────────────────────────────────────────
  [WallTexture.brick]: {
    category: "stoneBrick",
    label: "exposed brick wall",
    description:
      "Exposed brick with irregular mortar joints and warm earth-tone variation.",
    descriptors: ["warm earth tones", "irregular mortar", "rustic"],
    lightingCharacter:
      "Warm directional daylight; shadows settle into the mortar lines.",
  },
  [WallTexture.naturalStone]: {
    category: "stoneBrick",
    label: "natural stone cladding",
    description:
      "Tightly packed rounded river-stone cladding in mixed cream, beige, and warm gray tones with smooth weathered faces.",
    descriptors: ["rounded river stones", "warm beige and gray tones", "smooth weathered"],
    lightingCharacter:
      "Side-raking natural light; the relief of each stone reads clearly.",
  },
  [WallTexture.marble]: {
    category: "stoneBrick",
    label: "polished marble slabs",
    description:
      "Book-matched polished marble slabs with dramatic veining and a mirror finish.",
    descriptors: ["veined", "polished", "book-matched"],
    lightingCharacter:
      "Bright even daylight; veining and reflections remain crisp.",
  },
  [WallTexture.slate]: {
    category: "stoneBrick",
    label: "slate stone cladding",
    description:
      "Cleft slate cladding with dark charcoal tones and a layered riven surface.",
    descriptors: ["charcoal", "cleft", "layered"],
    lightingCharacter:
      "Cool side-raking light; emphasizes the slate's natural ridges.",
  },

  // ─── Wood ───────────────────────────────────────────────────────────────
  [WallTexture.woodPaneling]: {
    category: "wood",
    label: "vertical wood paneling",
    description:
      "Vertical tongue-and-groove wood paneling with a warm stain and tight joints.",
    descriptors: ["warm stain", "tight joints", "vertical grain"],
    lightingCharacter:
      "Warm ambient light; the grain reads as a gentle rhythm.",
  },
  [WallTexture.shiplap]: {
    category: "wood",
    label: "painted shiplap",
    description:
      "Horizontal shiplap boards with visible seams and a painted matte finish.",
    descriptors: ["horizontal", "visible seams", "matte paint"],
    lightingCharacter:
      "Soft indirect daylight; the shadow lines between boards stay crisp.",
  },
  [WallTexture.reclaimedWood]: {
    category: "wood",
    label: "reclaimed wood planks",
    description:
      "Reclaimed wood planks with mixed tones, weathering, knots, and saw marks.",
    descriptors: ["mixed tones", "weathered", "knots and saw marks"],
    lightingCharacter:
      "Warm directional daylight; weathering and tool marks remain visible.",
  },

  // ─── Decorative ─────────────────────────────────────────────────────────
  [WallTexture.wallpaper]: {
    category: "decorative",
    label: "patterned wallpaper",
    description:
      "Patterned wallpaper with a clear repeating motif and fine print detail.",
    descriptors: ["repeating motif", "fine print", "paper finish"],
    lightingCharacter:
      "Soft diffused daylight; pattern reads crisply without glare.",
  },
  [WallTexture.geometric]: {
    category: "decorative",
    label: "geometric feature wall",
    description:
      "Geometric feature wall with three-dimensional relief panels and sharp edges.",
    descriptors: ["3D relief", "sharp edges", "repeating geometry"],
    lightingCharacter:
      "Side-raking daylight; sharp shadow play across the relief geometry.",
  },
  [WallTexture.textured]: {
    category: "decorative",
    label: "embossed damask feature wall",
    description:
      "Embossed feature wall with a repeating raised-relief damask floral motif on a soft cream matte surface.",
    descriptors: ["embossed damask motif", "raised floral relief", "soft cream matte"],
    lightingCharacter:
      "Soft directional daylight; gentle shadows accentuate the raised pattern.",
  },
};
