/**
 * Hand-edited — NOT produced by orval.
 *
 * FloorTexture enum for the floor-restyle design tool. Mirrors the iOS
 * `FloorTexture.id` values in HomeDecorAI/Features/Wizard/Models/FloorStyle.swift.
 * Four categories × 4 textures = 16 ids total.
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type FloorTexture = (typeof FloorTexture)[keyof typeof FloorTexture];

export const FloorTexture = {
  // Wood
  oakWood: "oakWood",
  walnut: "walnut",
  bamboo: "bamboo",
  cherry: "cherry",
  // Marble
  whiteMarble: "whiteMarble",
  travertine: "travertine",
  greenMarble: "greenMarble",
  beigeMarble: "beigeMarble",
  // Porcelain
  patternTile: "patternTile",
  checkerboard: "checkerboard",
  hexagon: "hexagon",
  terracotta: "terracotta",
  // Planks
  naturalPlank: "naturalPlank",
  whitewashedPlank: "whitewashedPlank",
  darkPlank: "darkPlank",
  herringbone: "herringbone",
} as const;
