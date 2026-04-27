import type admin from "firebase-admin";

/**
 * Inspiration domain type. Curated AI-generated room images used by the iOS
 * Explore tab. Documents are written by admins (or later, an admin pipeline)
 * — there is no user-facing write path.
 *
 * Stored at: `inspirations/{id}` (root collection, public-read).
 *
 * `roomType`, `designStyle`, and `toolType` strings are kept in lockstep with
 * the iOS RoomType / DesignStyle enums + the tool registry in
 * `src/lib/tool-types.ts`. Filters on the iOS side rely on exact-string match,
 * so any new value must be added to both sides simultaneously.
 */
export interface Inspiration {
  id: string;
  roomType: string;
  designStyle: string;
  /** ToolType key from src/lib/tool-types.ts (e.g. "interiorDesign"). */
  toolType: string;
  tags: string[];
  imageUrl: string;
  cdnUrl: string | null;
  /** Optional editorial flag for "featured" surfaces. */
  featured: boolean;
  /** Set when an inspiration is curated from a real generation. */
  sourceGenerationId: string | null;
  createdAt: admin.firestore.Timestamp;
}

/** Wire-format inspiration returned by the REST API. Timestamps are ISO. */
export interface InspirationDTO {
  id: string;
  roomType: string;
  designStyle: string;
  toolType: string;
  tags: string[];
  imageUrl: string;
  cdnUrl: string | null;
  featured: boolean;
  sourceGenerationId: string | null;
  createdAt: string;
}

/** Allowed RoomType strings, mirrors iOS `RoomType` enum. */
export const ROOM_TYPE_VALUES = [
  "livingRoom",
  "bedroom",
  "kitchen",
  "underStairSpace",
  "diningRoom",
  "bathroom",
  "entryway",
  "stairway",
  "office",
  "homeOffice",
  "studyRoom",
  "gamingRoom",
] as const;

/** Allowed DesignStyle strings, mirrors iOS `DesignStyle` enum. */
export const DESIGN_STYLE_VALUES = [
  "modern",
  "minimalist",
  "scandinavian",
  "industrial",
  "bohemian",
  "contemporary",
  "midCentury",
  "coastal",
  "farmhouse",
  "japandi",
  "artDeco",
  "traditional",
  "tropical",
  "rustic",
  "luxury",
  "cozy",
  "christmas",
  "airbnb",
] as const;

/** Allowed ToolType keys for inspirations. Mirrors the iOS
 *  `InspirationToolType` enum — every tool surfaced on the Home grid is
 *  filterable in Explore. */
export const TOOL_TYPE_VALUES = [
  "interiorDesign",
  "exteriorDesign",
  "gardenDesign",
  "patioDesign",
  "poolDesign",
  "referenceStyle",
  "replaceAddObject",
  "paintWalls",
  "floorRestyle",
  "virtualStaging",
  "cleanOrganize",
  "removeObjects",
  "exteriorPainting",
  "outdoorLightingDesign",
] as const;

export type RoomTypeValue = (typeof ROOM_TYPE_VALUES)[number];
export type DesignStyleValue = (typeof DESIGN_STYLE_VALUES)[number];
export type ToolTypeValue = (typeof TOOL_TYPE_VALUES)[number];

/** Caps for pagination. */
export const EXPLORE_DEFAULT_LIMIT = 20;
export const EXPLORE_MAX_LIMIT = 50;
