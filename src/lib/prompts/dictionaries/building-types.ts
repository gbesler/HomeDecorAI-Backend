/**
 * Building types dictionary — 12 entries covering the iOS `BuildingType`
 * enum. Feeds the exterior builder's action directive and focus layer with
 * type-specific massing vocabulary.
 *
 * Per-entry shape:
 * - `label`: human-readable noun used in the action directive
 * - `massingDescriptor`: one short phrase describing the typical mass/scale
 * - `signatureFeatures`: 2-3 features that define the type visually
 */

import { BuildingType } from "../../../schemas/generated/types/buildingType.js";
import type { BuildingTypesDict } from "../types.js";

export const buildingTypes: BuildingTypesDict = {
  [BuildingType.house]: {
    label: "single-family house",
    massingDescriptor: "compact two-story mass with a pitched roof",
    signatureFeatures: [
      "a front door with a porch or stoop",
      "symmetrical window placement",
      "a welcoming front path",
    ],
  },

  [BuildingType.apartment]: {
    label: "apartment building",
    massingDescriptor: "multi-story block with stacked balconies",
    signatureFeatures: [
      "repeating window bays on each floor",
      "a shared ground-floor entrance",
      "balcony railings aligned vertically",
    ],
  },

  [BuildingType.townhouse]: {
    label: "townhouse",
    massingDescriptor: "narrow multi-story terrace mass with shared walls",
    signatureFeatures: [
      "a tall narrow front facade",
      "a raised entry stoop",
      "stacked windows on three or more levels",
    ],
  },

  [BuildingType.villa]: {
    label: "villa",
    massingDescriptor: "low-slung Mediterranean mass with generous eaves",
    signatureFeatures: [
      "arched entryway or loggia",
      "terracotta or tile roof",
      "landscaped forecourt",
    ],
  },

  [BuildingType.cottage]: {
    label: "cottage",
    massingDescriptor: "small single-story mass with a steeply pitched gable",
    signatureFeatures: [
      "a cozy front door with flanking windows",
      "a charming garden-facing facade",
      "a chimney on the roof line",
    ],
  },

  [BuildingType.cabin]: {
    label: "cabin",
    massingDescriptor: "compact wooden mass with a gable roof",
    signatureFeatures: [
      "log or plank siding",
      "a covered porch with wood railings",
      "a stone chimney",
    ],
  },

  [BuildingType.farmhouse]: {
    label: "farmhouse",
    massingDescriptor: "wide two-story rectangular mass with a deep porch",
    signatureFeatures: [
      "a wrap-around or deep front porch",
      "a metal or shingle gabled roof",
      "large paned windows",
    ],
  },

  [BuildingType.bungalow]: {
    label: "bungalow",
    massingDescriptor: "low single-story mass with a low-pitched roof",
    signatureFeatures: [
      "a deep front porch with tapered columns",
      "exposed roof rafters",
      "wide eaves",
    ],
  },

  [BuildingType.mansion]: {
    label: "mansion",
    massingDescriptor: "grand multi-wing mass with formal symmetry",
    signatureFeatures: [
      "a columned entry portico",
      "tall symmetrical windows",
      "an imposing central doorway",
    ],
  },

  [BuildingType.commercial]: {
    label: "commercial building",
    massingDescriptor: "rectilinear storefront mass with street-level glazing",
    signatureFeatures: [
      "large ground-floor display windows",
      "a signage band above the entrance",
      "a flat or parapet roof line",
    ],
  },

  [BuildingType.warehouse]: {
    label: "warehouse",
    massingDescriptor: "tall single-volume rectangular mass",
    signatureFeatures: [
      "banded industrial windows",
      "a large roll-up door",
      "exposed structural columns or pilasters",
    ],
  },

  [BuildingType.garage]: {
    label: "garage",
    massingDescriptor: "low single-bay or double-bay rectangular mass",
    signatureFeatures: [
      "a wide overhead door",
      "a pedestrian side entry",
      "a simple gable or flat roof",
    ],
  },
};
