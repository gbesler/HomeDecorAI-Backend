/**
 * Hand-edited — NOT produced by orval.
 *
 * GardenItem enum for the garden design tool. Mirrors the iOS
 * `GardenItem` enum (HomeDecorAI/Features/Wizard/Models/GardenItem.swift).
 *
 * Multi-select on the client — the API accepts an array of these values.
 * `surpriseMe` is a sentinel that short-circuits the items layer in the
 * prompt builder (no explicit item list).
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type GardenItem = (typeof GardenItem)[keyof typeof GardenItem];

export const GardenItem = {
  surpriseMe: "surpriseMe",
  furniture: "furniture",
  swimmingPool: "swimmingPool",
  gazebo: "gazebo",
  hedge: "hedge",
  firePit: "firePit",
  fountain: "fountain",
  pathway: "pathway",
  pergola: "pergola",
  flowerBed: "flowerBed",
} as const;
