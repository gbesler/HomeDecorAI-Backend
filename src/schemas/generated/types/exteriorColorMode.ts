/**
 * Hand-edited — NOT produced by orval.
 *
 * ExteriorColorMode enum for the exterior design tool. Mirrors the iOS
 * `ColorMode` enum (HomeDecorAI/Features/Wizard/Models/ColorMode.swift).
 *
 * - `structuralPreservation`: repaint / refinish only, keep geometry.
 *   Prompt builder forces guidanceBand="faithful".
 * - `renovationDesign`: full restyle of finishes, cladding, surfaces.
 *   Prompt builder uses the style entry's native guidance band.
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type ExteriorColorMode =
  (typeof ExteriorColorMode)[keyof typeof ExteriorColorMode];

export const ExteriorColorMode = {
  structuralPreservation: "structuralPreservation",
  renovationDesign: "renovationDesign",
} as const;
