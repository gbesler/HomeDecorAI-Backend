/**
 * Hand-edited — NOT produced by orval.
 *
 * OutdoorLightingStyle enum for the outdoor lighting design tool. Mirrors
 * the iOS `OutdoorLightingStyle` enum
 * (HomeDecorAI/Features/Wizard/Models/OutdoorLightingStyle.swift).
 *
 * Must be propagated to the upstream OpenAPI spec in a follow-up.
 */

export type OutdoorLightingStyle =
  (typeof OutdoorLightingStyle)[keyof typeof OutdoorLightingStyle];

export const OutdoorLightingStyle = {
  warmAmbient: "warmAmbient",
  stringLights: "stringLights",
  pathwayLighting: "pathwayLighting",
  uplighting: "uplighting",
  lantern: "lantern",
  modernArchitectural: "modernArchitectural",
  moody: "moody",
  festiveHoliday: "festiveHoliday",
  poolside: "poolside",
  torchlight: "torchlight",
} as const;
