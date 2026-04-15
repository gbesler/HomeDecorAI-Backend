/**
 * Hand-edited — NOT produced by orval.
 *
 * SpaceType enum for the reference-style design tool. Mirrors the iOS
 * `SpaceType` enum (HomeDecorAI/Features/Wizard/Models/SpaceType.swift).
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type SpaceType = (typeof SpaceType)[keyof typeof SpaceType];

export const SpaceType = {
  interior: "interior",
  exterior: "exterior",
} as const;
