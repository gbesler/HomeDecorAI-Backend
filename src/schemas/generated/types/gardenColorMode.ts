/**
 * Hand-edited — NOT produced by orval.
 *
 * GardenColorMode enum for the garden design tool. Mirrors the iOS
 * `GardenColorMode` enum (HomeDecorAI/Features/Wizard/Models/GardenColorMode.swift).
 *
 * - `landscapePreservation`: refresh planting / surfaces, keep layout.
 *   Prompt builder forces guidanceBand="faithful".
 * - `fullRedesign`: reimagine the garden as the target style.
 *   Prompt builder uses the style entry's native guidance band.
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type GardenColorMode =
  (typeof GardenColorMode)[keyof typeof GardenColorMode];

export const GardenColorMode = {
  landscapePreservation: "landscapePreservation",
  fullRedesign: "fullRedesign",
} as const;
