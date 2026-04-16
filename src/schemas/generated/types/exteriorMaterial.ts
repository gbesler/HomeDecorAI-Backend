/**
 * Hand-edited — NOT produced by orval.
 *
 * ExteriorMaterial enum for the exterior-painting tool. Mirrors the iOS
 * `ExteriorMaterial.id` values in
 * HomeDecorAI/Features/Wizard/Models/ExteriorMaterial.swift.
 *
 * The `keepOriginal` sentinel tells the prompt builder to repaint the
 * existing exterior without swapping the cladding material. The other 9
 * values select a concrete facade material for the swap.
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type ExteriorMaterial =
  (typeof ExteriorMaterial)[keyof typeof ExteriorMaterial];

export const ExteriorMaterial = {
  keepOriginal: "keepOriginal",
  texturedBrick: "texturedBrick",
  vinylSiding: "vinylSiding",
  smoothStucco: "smoothStucco",
  naturalStone: "naturalStone",
  woodCladding: "woodCladding",
  metalPanel: "metalPanel",
  fiberCement: "fiberCement",
  limestoneFacade: "limestoneFacade",
  concreteFacade: "concreteFacade",
} as const;
