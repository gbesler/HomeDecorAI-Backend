/**
 * Hand-edited — NOT produced by orval.
 *
 * WallTexture enum for the paint-walls design tool. Mirrors the iOS
 * `WallTexture.id` values in HomeDecorAI/Features/Wizard/Models/WallStyle.swift.
 * Five categories × 3-4 textures = 18 ids total.
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type WallTexture = (typeof WallTexture)[keyof typeof WallTexture];

export const WallTexture = {
  // Paint finishes
  matte: "matte",
  satin: "satin",
  glossy: "glossy",
  eggshell: "eggshell",
  // Plaster
  venetianPlaster: "venetianPlaster",
  limewash: "limewash",
  stucco: "stucco",
  concrete: "concrete",
  // Stone / brick
  brick: "brick",
  naturalStone: "naturalStone",
  marble: "marble",
  slate: "slate",
  // Wood
  woodPaneling: "woodPaneling",
  shiplap: "shiplap",
  reclaimedWood: "reclaimedWood",
  // Decorative
  wallpaper: "wallpaper",
  geometric: "geometric",
  textured: "textured",
} as const;
