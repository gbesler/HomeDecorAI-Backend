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
  // Envelope fields (iOS plan 2026-05-12-001). Surfaced via the REST DTO
  // so an admin/agent that writes via POST /inspirations can verify the
  // round-trip — missing for legacy flat-shape docs.
  /** Asset-kind discriminator. `null` when the field is absent on the doc. */
  kind: string | null;
  /** Pixel width captured at upload time; drives iOS masonry layout. */
  imageWidth: number | null;
  /** Pixel height captured at upload time. */
  imageHeight: number | null;
  /** MIME of the uploaded image (e.g. `"image/jpeg"`). */
  imageMime: string | null;
  /** Generation prompt used to produce the image, if available. */
  prompt: string | null;
  /** Envelope schema version. `null` for pre-envelope flat docs. */
  schemaVersion: number | null;
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
  kind: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  imageMime: string | null;
  prompt: string | null;
  schemaVersion: number | null;
}

/** Allowed RoomType strings, mirrors iOS `RoomType` enum. */
export const ROOM_TYPE_VALUES = [
  "livingRoom",
  "bedroom",
  "kidRoom",
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

// MARK: - Envelope schema (iOS plan 2026-05-12-001)
//
// New Firestore document shape introduced by the remote-inspiration-catalog
// migration. Mirrors the iOS `Inspiration` envelope (see
// `HomeDecorAI/Features/Explore/Models/Inspiration.swift`). The legacy flat
// `Inspiration` interface above is preserved for the `/explore` REST
// controller; new docs are written by `POST /explore/inspirations`
// (see `src/routes/explore.ts` and `src/lib/inspiration/firestore.ts`),
// and the iOS app reads them directly via the Firestore SDK.
//
// Forward-compat: the iOS decoder is tolerant of unknown extra fields and
// unknown `kind` raw values (filtered out at catalog assembly time), so
// schema growth here is purely additive.

/**
 * Discriminator for the kind of asset an inspiration represents. New kinds
 * (`videoTour`, `moodboard`, ...) can be added without breaking existing iOS
 * builds — unknown values decode to `null` on the client and the row is
 * filtered out before it reaches any view.
 */
export const INSPIRATION_KIND_VALUES = ["roomPhoto"] as const;
export type InspirationKind = (typeof INSPIRATION_KIND_VALUES)[number];

/**
 * Per-tool taxonomy block. Every per-tool axis is optional so non-interior
 * rows decode cleanly when `roomType` is absent and exterior/garden rows
 * populate only their own axis. Strings are kept loose (`string`) rather
 * than the narrowed `*Value` types so the iOS app can ship a new axis
 * raw-value before the backend's narrowing catches up.
 */
export interface InspirationTaxonomy {
  toolType: ToolTypeValue;
  designStyle: DesignStyleValue;
  tags: string[];
  /** Interior tools — one of `ROOM_TYPE_VALUES`. */
  roomType?: string | null;
  /** Exterior tools — building taxonomy. */
  buildingType?: string | null;
  /** Garden tool — style taxonomy. */
  gardenStyle?: string | null;
  /** Patio tool — style taxonomy. */
  patioStyle?: string | null;
  /** Pool tool — style taxonomy. */
  poolStyle?: string | null;
  /** Outdoor lighting tool — style taxonomy. */
  outdoorLightingStyle?: string | null;
  /** Color-palette id resolved by the consuming wizard's per-tool list. */
  colorPaletteId?: string | null;
}

/**
 * Firestore document envelope written by the seeder and read by the iOS
 * Firestore SDK listener. One JPEG per inspiration today — variants are
 * intentionally out of scope until a real need lands.
 */
export interface InspirationDoc {
  /** Bump on breaking shape changes. Today's value is `1`. */
  schemaVersion: number;
  /** Asset-kind discriminator. Today only `"roomPhoto"`. */
  kind: InspirationKind;
  taxonomy: InspirationTaxonomy;
  /** Bucket-relative storage path (folder + filename), no scheme/host. The
   *  full URL is composed at read time from a trusted base. Always present.
   *  See `PathSchema` in lib/storage/inspiration-path.ts. */
  path: string;
  /** Pixel width captured at upload time via `sharp`'s metadata. */
  imageWidth: number;
  /** Pixel height captured at upload time via `sharp`'s metadata. */
  imageHeight: number;
  /** MIME type. Today always `"image/jpeg"`; reserved for future WebP/AVIF. */
  imageMime: string;
  /**
   * Generation prompt used to produce the image. Optional — non-AI-sourced
   * rows (partner content, the iOS bundled fallback) may omit it. iOS reads
   * it verbatim; no length cap is applied client-side.
   */
  prompt?: string | null;
  /** Editorial flag for "featured" surfaces. */
  featured: boolean;
  /** Server-managed timestamp set on first write. */
  createdAt: admin.firestore.Timestamp;
  /** Server-managed timestamp updated on every re-seed. */
  updatedAt: admin.firestore.Timestamp;
}
