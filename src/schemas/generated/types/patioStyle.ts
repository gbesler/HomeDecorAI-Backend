/**
 * Hand-edited — NOT produced by orval.
 *
 * PatioStyle enum for the patio design tool. Mirrors the iOS
 * `PatioStyle` enum (HomeDecorAI/Features/Wizard/Models/PatioStyle.swift).
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type PatioStyle = (typeof PatioStyle)[keyof typeof PatioStyle];

export const PatioStyle = {
  outdoorDining: "outdoorDining",
  lounge: "lounge",
  bistro: "bistro",
  sundeck: "sundeck",
  firePit: "firePit",
  pergola: "pergola",
  zenDeck: "zenDeck",
  coastal: "coastal",
  mediterranean: "mediterranean",
  tropical: "tropical",
  rustic: "rustic",
  modern: "modern",
} as const;
