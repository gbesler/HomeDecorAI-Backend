/**
 * Hand-edited — NOT produced by orval.
 *
 * BuildingType enum for the exterior design tool. Mirrors the iOS
 * `BuildingType` enum (HomeDecorAI/Features/Wizard/Models/BuildingType.swift).
 * Kept in the `generated/types/` directory next to the orval-produced enums
 * so the validator and tool registry find every enum in one place.
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type BuildingType = (typeof BuildingType)[keyof typeof BuildingType];

export const BuildingType = {
  house: "house",
  apartment: "apartment",
  townhouse: "townhouse",
  villa: "villa",
  cottage: "cottage",
  cabin: "cabin",
  farmhouse: "farmhouse",
  bungalow: "bungalow",
  mansion: "mansion",
  commercial: "commercial",
  warehouse: "warehouse",
  garage: "garage",
} as const;
