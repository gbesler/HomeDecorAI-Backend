/**
 * Hand-edited — NOT produced by orval.
 *
 * ExteriorColorPalette enum for the exterior design tool. Mirrors the iOS
 * `ColorPalette.exteriorPalettes` static list
 * (HomeDecorAI/Features/Wizard/Models/ColorPalette.swift).
 *
 * `surpriseMe` is a sentinel — the prompt builder emits no palette override
 * when this value is selected, letting the style entry's native palette
 * drive the composition.
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type ExteriorColorPalette =
  (typeof ExteriorColorPalette)[keyof typeof ExteriorColorPalette];

export const ExteriorColorPalette = {
  surpriseMe: "surpriseMe",
  laidBackBlues: "laidBackBlues",
  highContrast: "highContrast",
  warmTones: "warmTones",
  pastelBreeze: "pastelBreeze",
  peachyMeadow: "peachyMeadow",
  earthyNeutrals: "earthyNeutrals",
  forestGreens: "forestGreens",
  sunsetGlow: "sunsetGlow",
  oceanBreeze: "oceanBreeze",
  monochromeElegance: "monochromeElegance",
  desertSand: "desertSand",
} as const;
