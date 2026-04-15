/**
 * Hand-edited — NOT produced by orval.
 *
 * GardenColorPalette enum for the garden design tool. Mirrors the iOS
 * `ColorPalette.gardenPalettes` static list
 * (HomeDecorAI/Features/Wizard/Models/ColorPalette.swift).
 *
 * `surpriseMe` is a sentinel — the prompt builder emits no palette override
 * when this value is selected.
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type GardenColorPalette =
  (typeof GardenColorPalette)[keyof typeof GardenColorPalette];

export const GardenColorPalette = {
  surpriseMe: "surpriseMe",
  forestGreens: "forestGreens",
  earthyNeutrals: "earthyNeutrals",
  wildflowerMeadow: "wildflowerMeadow",
  zenGarden: "zenGarden",
  tropicalParadise: "tropicalParadise",
  lavenderFields: "lavenderFields",
  mossyStone: "mossyStone",
  autumnHarvest: "autumnHarvest",
  springBloom: "springBloom",
  succulentGreen: "succulentGreen",
  terracottaGarden: "terracottaGarden",
} as const;
