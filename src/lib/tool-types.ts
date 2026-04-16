import type { FastifySchema } from "fastify";
import { type z } from "zod";
import { env } from "./env.js";
import { buildInteriorPromptLegacy } from "./prompts/legacy.js";
import {
  buildExteriorPrompt,
  type ExteriorParams,
} from "./prompts/tools/exterior-design.js";
import {
  buildGardenPrompt,
  type GardenParams,
} from "./prompts/tools/garden-design.js";
import {
  buildPatioPrompt,
  type PatioParams,
} from "./prompts/tools/patio-design.js";
import {
  buildPoolPrompt,
  type PoolParams,
} from "./prompts/tools/pool-design.js";
import {
  buildInteriorPrompt,
  type InteriorParams,
} from "./prompts/tools/interior-design.js";
import {
  buildFloorRestylePrompt,
  type FloorRestyleParams,
} from "./prompts/tools/floor-restyle.js";
import {
  buildPaintWallsPrompt,
  type PaintWallsParams,
} from "./prompts/tools/paint-walls.js";
import {
  buildReferenceStylePrompt,
  type ReferenceStyleParams,
} from "./prompts/tools/reference-style.js";
import {
  buildVirtualStagingPrompt,
  type VirtualStagingParams,
} from "./prompts/tools/virtual-staging.js";
import type { PromptResult } from "./prompts/types.js";
import {
  CreateExteriorDesignBody,
  CreateFloorRestyleBody,
  CreateGardenDesignBody,
  CreateInteriorDesignBody,
  CreatePaintWallsBody,
  CreatePatioDesignBody,
  CreatePoolDesignBody,
  CreateReferenceStyleBody,
  CreateVirtualStagingBody,
} from "../schemas/generated/api.js";

export type {
  InteriorParams,
  ExteriorParams,
  GardenParams,
  PatioParams,
  PoolParams,
  ReferenceStyleParams,
  PaintWallsParams,
  FloorRestyleParams,
  VirtualStagingParams,
};

// ─── ToolTypeConfig ─────────────────────────────────────────────────────────

/**
 * Registry entry shape. Each tool is a self-describing declarative record:
 * routing, validation, rate limiting, persistence round-trip, and prompt
 * building all live in one place. The generic controller factory and route
 * loop consume this shape exclusively, so adding a new tool means adding a
 * single entry — no new route or controller file.
 *
 * Generic parameters:
 * - `TParams`: the validated body shape for this tool (derived from `bodySchema`).
 * - `TResult`: the prompt builder result (extends `PromptResult`).
 *
 * Persistence contract:
 * - `toToolParams(params)`: project the validated body into the opaque
 *   `toolParams` blob that lives on the Firestore document.
 * - `fromToolParams(raw)`: re-validate that blob back into `TParams` inside
 *   the processor. Uses zod so the processor never trusts the storage layer.
 */
export interface ToolTypeConfig<
  TParams = unknown,
  TResult extends PromptResult = PromptResult,
> {
  /** Unique key: also the `toolType` field written to Firestore. */
  toolKey: string;
  /** HTTP path fragment under `/api/design`. Must start with a slash. */
  routePath: string;
  /** Rate limiter key — must also exist in `config/rate-limits.ts`. */
  rateLimitKey: string;
  /** AI provider model IDs for the router. */
  models: {
    replicate: `${string}/${string}`;
    falai: string;
  };
  /** Zod body schema (without `language` — the controller factory adds it). */
  bodySchema: z.ZodType<TParams>;
  /** Fastify/OpenAPI body JSON schema for docs. */
  bodyJsonSchema: NonNullable<FastifySchema["body"]>;
  /** Human-readable route summary for Swagger. */
  summary: string;
  /** Human-readable route description for Swagger. */
  description: string;
  /** Prompt builder. */
  buildPrompt: (params: TParams) => TResult;
  /** Project validated body into the Firestore `toolParams` blob. */
  toToolParams: (params: TParams) => Record<string, unknown>;
  /** Re-validate the Firestore `toolParams` blob into typed params. */
  fromToolParams: (raw: Record<string, unknown>) => TParams;
  /**
   * Body fields that carry image URLs. Every entry is validated against the
   * http/https scheme allowlist by the controller. The FIRST entry is the
   * canonical "input image" written to `GenerationDoc.inputImageUrl` — other
   * entries live in `toolParams` and are forwarded to the provider as the
   * `referenceImageUrl` slot (e.g. reference-style tool).
   *
   * Type constraint: a non-empty tuple of body field names. Constraining to
   * `keyof TParams` means a typo'd field name is caught at compile time
   * rather than at runtime as a 400 with the wrong field in the error
   * message. The non-empty tuple shape (`[K, ...K[]]`) also lets the
   * controller index `[0]` without a defensiveness check for an empty array.
   */
  imageUrlFields: readonly [
    keyof TParams & string,
    ...(keyof TParams & string)[],
  ];
  /**
   * Body fields that MAY carry image URLs but are not always present
   * (e.g. paint-walls `referenceImageUrl` — only set in customStyle mode).
   * Each entry is validated against the http/https scheme allowlist only
   * when the field is defined on the request. Used by the processor to
   * resolve a secondary reference image when `imageUrlFields` does not
   * include one.
   */
  optionalImageUrlFields?: readonly (keyof TParams & string)[];
}

// ─── Interior prompt dispatch (legacy safety valve) ─────────────────────────

function buildInteriorPromptDispatch(params: InteriorParams): PromptResult {
  if (env.PROMPT_BUILDER_VERSION === "legacy") {
    return buildInteriorPromptLegacy(params);
  }
  return buildInteriorPrompt(params);
}

// ─── Shared primitives for JSON schemas ────────────────────────────────────

const DESIGN_STYLES = [
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

const ROOM_TYPES = [
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

const BUILDING_TYPES = [
  "house",
  "apartment",
  "townhouse",
  "villa",
  "cottage",
  "cabin",
  "farmhouse",
  "bungalow",
  "mansion",
  "commercial",
  "warehouse",
  "garage",
] as const;

const GARDEN_STYLES = [
  "cozy",
  "englishCottage",
  "christmas",
  "french",
  "tropical",
  "japanese",
  "mediterranean",
  "modern",
  "rustic",
  "wildflower",
] as const;

const PATIO_STYLES = [
  "outdoorDining",
  "lounge",
  "bistro",
  "sundeck",
  "firePit",
  "pergola",
  "zenDeck",
  "coastal",
] as const;

const POOL_STYLES = [
  "poolSpa",
  "resort",
  "waterfall",
  "infinity",
] as const;

const GARDEN_ITEMS_LIST = [
  "surpriseMe",
  "furniture",
  "swimmingPool",
  "gazebo",
  "hedge",
  "firePit",
  "fountain",
  "pathway",
  "pergola",
  "flowerBed",
] as const;

const EXTERIOR_PALETTES = [
  "surpriseMe",
  "laidBackBlues",
  "highContrast",
  "warmTones",
  "pastelBreeze",
  "peachyMeadow",
  "earthyNeutrals",
  "forestGreens",
  "sunsetGlow",
  "oceanBreeze",
  "monochromeElegance",
  "desertSand",
] as const;

const FLOOR_TEXTURES = [
  "oakWood",
  "walnut",
  "bamboo",
  "cherry",
  "whiteMarble",
  "travertine",
  "greenMarble",
  "beigeMarble",
  "patternTile",
  "checkerboard",
  "hexagon",
  "terracotta",
  "naturalPlank",
  "whitewashedPlank",
  "darkPlank",
  "herringbone",
] as const;

const WALL_TEXTURES = [
  "matte",
  "satin",
  "glossy",
  "eggshell",
  "venetianPlaster",
  "limewash",
  "stucco",
  "concrete",
  "brick",
  "naturalStone",
  "marble",
  "slate",
  "woodPaneling",
  "shiplap",
  "reclaimedWood",
  "wallpaper",
  "geometric",
  "textured",
] as const;

const GARDEN_PALETTES = [
  "surpriseMe",
  "forestGreens",
  "earthyNeutrals",
  "wildflowerMeadow",
  "zenGarden",
  "tropicalParadise",
  "lavenderFields",
  "mossyStone",
  "autumnHarvest",
  "springBloom",
  "succulentGreen",
  "terracottaGarden",
] as const;

// ─── JSON schemas for Swagger ──────────────────────────────────────────────

const interiorBodyJsonSchema = {
  type: "object" as const,
  required: ["imageUrl", "roomType", "designStyle"] as const,
  properties: {
    imageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the room photo to redesign (must use http or https scheme)",
    },
    roomType: {
      type: "string" as const,
      enum: ROOM_TYPES,
      description: "Type of room in the photo",
    },
    designStyle: {
      type: "string" as const,
      enum: DESIGN_STYLES,
      description: "Target design style for the transformation",
    },
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications. If omitted, backend falls back to Accept-Language header, then `en`.",
    },
  },
};

const exteriorBodyJsonSchema = {
  type: "object" as const,
  required: [
    "imageUrl",
    "buildingType",
    "designStyle",
    "colorMode",
    "colorPalette",
  ] as const,
  properties: {
    imageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the building photo to redesign (must use http or https scheme)",
    },
    buildingType: {
      type: "string" as const,
      enum: BUILDING_TYPES,
      description: "Type of building in the photo",
    },
    designStyle: {
      type: "string" as const,
      enum: DESIGN_STYLES,
      description: "Target design style for the transformation",
    },
    colorMode: {
      type: "string" as const,
      enum: ["structuralPreservation", "renovationDesign"] as const,
      description:
        "structuralPreservation: only restyle surface treatments. renovationDesign: full restyle of finishes and cladding.",
    },
    colorPalette: {
      type: "string" as const,
      enum: EXTERIOR_PALETTES,
      description:
        "Color palette id. `surpriseMe` lets the style drive the palette.",
    },
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications.",
    },
  },
};

const gardenBodyJsonSchema = {
  type: "object" as const,
  required: [
    "imageUrl",
    "gardenStyle",
    "colorMode",
    "colorPalette",
    "gardenItems",
  ] as const,
  properties: {
    imageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the garden photo to redesign (must use http or https scheme)",
    },
    gardenStyle: {
      type: "string" as const,
      enum: GARDEN_STYLES,
      description: "Target garden style for the transformation",
    },
    colorMode: {
      type: "string" as const,
      enum: ["landscapePreservation", "fullRedesign"] as const,
      description:
        "landscapePreservation: keep existing layout, refresh planting. fullRedesign: reimagine the whole garden.",
    },
    colorPalette: {
      type: "string" as const,
      enum: GARDEN_PALETTES,
      description:
        "Color palette id. `surpriseMe` lets the style drive the palette.",
    },
    gardenItems: {
      type: "array" as const,
      minItems: 1,
      items: {
        type: "string" as const,
        enum: GARDEN_ITEMS_LIST,
      },
      description:
        "Multi-select garden features. `surpriseMe` short-circuits the items layer.",
    },
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications.",
    },
  },
};

const patioBodyJsonSchema = {
  type: "object" as const,
  required: ["imageUrl", "patioStyle"] as const,
  properties: {
    imageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the patio photo to redesign (must use http or https scheme)",
    },
    patioStyle: {
      type: "string" as const,
      enum: PATIO_STYLES,
      description: "Target patio style for the transformation",
    },
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications.",
    },
  },
};

const poolBodyJsonSchema = {
  type: "object" as const,
  required: ["imageUrl", "poolStyle"] as const,
  properties: {
    imageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the pool photo to redesign (must use http or https scheme)",
    },
    poolStyle: {
      type: "string" as const,
      enum: POOL_STYLES,
      description: "Target pool style for the transformation",
    },
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications.",
    },
  },
};

const paintWallsBodyJsonSchema = {
  type: "object" as const,
  required: ["imageUrl", "wallStyleMode"] as const,
  properties: {
    imageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the room photo whose walls should be restyled (http or https)",
    },
    wallStyleMode: {
      type: "string" as const,
      enum: ["texture", "customStyle"] as const,
      description:
        "Two modes: `texture` picks from an 18-item preset list (textureId required); `customStyle` uses a freeform user prompt (customPrompt required) and an optional reference image.",
    },
    textureId: {
      type: "string" as const,
      enum: WALL_TEXTURES,
      description:
        "Required when wallStyleMode is 'texture'. One of the 18 preset finishes.",
    },
    customPrompt: {
      type: "string" as const,
      minLength: 1,
      maxLength: 500,
      description:
        "Required when wallStyleMode is 'customStyle'. Freeform description of the desired wall finish.",
    },
    referenceImageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Optional; only accepted in customStyle mode. Public URL of a reference image whose wall finish should be emulated.",
    },
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications.",
    },
  },
};

const floorRestyleBodyJsonSchema = {
  type: "object" as const,
  required: ["imageUrl", "floorStyleMode"] as const,
  properties: {
    imageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the room photo whose flooring should be restyled (http or https)",
    },
    floorStyleMode: {
      type: "string" as const,
      enum: ["texture", "customStyle"] as const,
      description:
        "Two modes: `texture` picks from a 16-item preset list (textureId required); `customStyle` uses a freeform user prompt (customPrompt required) and an optional reference image.",
    },
    textureId: {
      type: "string" as const,
      enum: FLOOR_TEXTURES,
      description:
        "Required when floorStyleMode is 'texture'. One of the 16 preset floor finishes.",
    },
    customPrompt: {
      type: "string" as const,
      minLength: 1,
      maxLength: 500,
      description:
        "Required when floorStyleMode is 'customStyle'. Freeform description of the desired floor finish.",
    },
    referenceImageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Optional; only accepted in customStyle mode. Public URL of a reference image whose floor finish should be emulated.",
    },
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications.",
    },
  },
};

const referenceStyleBodyJsonSchema = {
  type: "object" as const,
  required: ["roomImageUrl", "referenceImageUrl", "spaceType"] as const,
  properties: {
    roomImageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the user's room photo to restyle (must use http or https scheme)",
    },
    referenceImageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the reference photo whose aesthetic should be applied (must use http or https scheme)",
    },
    spaceType: {
      type: "string" as const,
      enum: ["interior", "exterior"] as const,
      description: "Whether the user's photo is an interior room or exterior building",
    },
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications.",
    },
  },
};

const STAGING_PALETTES = [
  "surpriseMe",
  "warmTones",
  "earthyNeutrals",
  "pastelBreeze",
  "monochromeElegance",
  "laidBackBlues",
  "forestGreens",
  "oceanBreeze",
  "sunsetGlow",
  "peachyMeadow",
  "highContrast",
  "desertSand",
] as const;

const virtualStagingBodyJsonSchema = {
  type: "object" as const,
  required: [
    "imageUrl",
    "roomType",
    "designStyle",
    "colorPalette",
    "stagingMode",
  ] as const,
  properties: {
    imageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the room photo to stage (must use http or https scheme)",
    },
    roomType: {
      type: "string" as const,
      enum: ROOM_TYPES,
      description: "Type of room in the photo",
    },
    designStyle: {
      type: "string" as const,
      enum: DESIGN_STYLES,
      description: "Target design style for the staging",
    },
    colorPalette: {
      type: "string" as const,
      enum: STAGING_PALETTES,
      description:
        "Color palette id. `surpriseMe` lets the style drive the palette.",
    },
    stagingMode: {
      type: "string" as const,
      enum: ["keepLayout", "fullStaging"] as const,
      description:
        "keepLayout: preserve any existing furniture, add complementary pieces. fullStaging: stage as if the room were empty.",
    },
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications.",
    },
  },
};

// ─── Tool registry ─────────────────────────────────────────────────────────

export const TOOL_TYPES = {
  interiorDesign: {
    toolKey: "interiorDesign",
    routePath: "/interior",
    rateLimitKey: "interiorDesign",
    models: {
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    bodySchema: CreateInteriorDesignBody,
    bodyJsonSchema: interiorBodyJsonSchema,
    summary: "Enqueue an interior design transformation",
    description:
      "Accepts a room photo URL, room type, and design style. Creates a generation record and enqueues an async Cloud Tasks job that generates the design with Replicate (primary) or fal.ai (fallback), uploads to S3, and notifies the client via Firestore listener + FCM push. Returns 202 with a generationId; the client subscribes to `generations/{generationId}` for status updates.",
    buildPrompt: buildInteriorPromptDispatch,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreateInteriorDesignBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreateInteriorDesignBody>,
    PromptResult
  >,

  exteriorDesign: {
    toolKey: "exteriorDesign",
    routePath: "/exterior",
    rateLimitKey: "exteriorDesign",
    models: {
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    bodySchema: CreateExteriorDesignBody,
    bodyJsonSchema: exteriorBodyJsonSchema,
    summary: "Enqueue an exterior design transformation",
    description:
      "Accepts a building photo URL, building type, design style, color mode, and palette. Creates a generation record and enqueues an async Cloud Tasks job with the same async pipeline and FCM notification as interior. Returns 202 with a generationId.",
    buildPrompt: buildExteriorPrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreateExteriorDesignBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreateExteriorDesignBody>,
    PromptResult
  >,

  gardenDesign: {
    toolKey: "gardenDesign",
    routePath: "/garden",
    rateLimitKey: "gardenDesign",
    models: {
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    bodySchema: CreateGardenDesignBody,
    bodyJsonSchema: gardenBodyJsonSchema,
    summary: "Enqueue a garden design transformation",
    description:
      "Accepts a garden photo URL, garden style, color mode, palette, and multi-select garden items. Creates a generation record and enqueues an async Cloud Tasks job with the same async pipeline and FCM notification as interior. Returns 202 with a generationId.",
    buildPrompt: buildGardenPrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreateGardenDesignBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreateGardenDesignBody>,
    PromptResult
  >,

  patioDesign: {
    toolKey: "patioDesign",
    routePath: "/patio",
    rateLimitKey: "patioDesign",
    models: {
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    bodySchema: CreatePatioDesignBody,
    bodyJsonSchema: patioBodyJsonSchema,
    summary: "Enqueue a patio design transformation",
    description:
      "Accepts a patio photo URL and a patio style. Creates a generation record and enqueues an async Cloud Tasks job with the same async pipeline and FCM notification as interior. Returns 202 with a generationId.",
    buildPrompt: buildPatioPrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreatePatioDesignBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreatePatioDesignBody>,
    PromptResult
  >,

  poolDesign: {
    toolKey: "poolDesign",
    routePath: "/pool",
    rateLimitKey: "poolDesign",
    models: {
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    bodySchema: CreatePoolDesignBody,
    bodyJsonSchema: poolBodyJsonSchema,
    summary: "Enqueue a pool design transformation",
    description:
      "Accepts a pool photo URL and a pool style. Creates a generation record and enqueues an async Cloud Tasks job with the same async pipeline and FCM notification as interior. Returns 202 with a generationId.",
    buildPrompt: buildPoolPrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreatePoolDesignBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreatePoolDesignBody>,
    PromptResult
  >,

  paintWalls: {
    toolKey: "paintWalls",
    routePath: "/paint-walls",
    rateLimitKey: "paintWalls",
    models: {
      // Pruna primary — Pruna's `images[]` + `reference_image` schema makes
      // the customStyle-with-reference path a multi-image call without any
      // new provider code. Texture mode and customStyle-without-reference
      // degrade cleanly to single-image input.
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    bodySchema: CreatePaintWallsBody,
    bodyJsonSchema: paintWallsBodyJsonSchema,
    summary: "Enqueue a paint-walls transformation",
    description:
      "Restyles only the wall surfaces of a room while preserving furniture, flooring, ceiling, fixtures, and decor. Two modes: `texture` picks from 18 presets (matte, satin, glossy, eggshell, Venetian plaster, limewash, stucco, concrete, brick, natural stone, marble, slate, wood paneling, shiplap, reclaimed wood, wallpaper, geometric, textured). `customStyle` accepts a freeform prompt plus an optional reference image whose wall finish the AI should emulate. Creates a generation record and enqueues an async Cloud Tasks job; returns 202 with a generationId.",
    buildPrompt: buildPaintWallsPrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreatePaintWallsBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
    optionalImageUrlFields: ["referenceImageUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreatePaintWallsBody>,
    PromptResult
  >,

  floorRestyle: {
    toolKey: "floorRestyle",
    routePath: "/floor-restyle",
    rateLimitKey: "floorRestyle",
    models: {
      // Same stack as paint-walls: Pruna primary (multi-image `images[]` +
      // `reference_image` for customStyle with reference), Klein 9B fallback.
      // Floor surfaces are planar like walls; the same guidance profile
      // (faithful) + structural-preservation primitive apply.
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    bodySchema: CreateFloorRestyleBody,
    bodyJsonSchema: floorRestyleBodyJsonSchema,
    summary: "Enqueue a floor-restyle transformation",
    description:
      "Restyles only the flooring of a room while preserving furniture, walls, ceiling, fixtures, and decor. Two modes: `texture` picks from 16 presets across four categories (wood: oakWood/walnut/bamboo/cherry; marble: whiteMarble/travertine/greenMarble/beigeMarble; porcelain: patternTile/checkerboard/hexagon/terracotta; planks: naturalPlank/whitewashedPlank/darkPlank/herringbone). `customStyle` accepts a freeform prompt plus an optional reference image whose floor finish the AI should emulate. Creates a generation record and enqueues an async Cloud Tasks job; returns 202 with a generationId.",
    buildPrompt: buildFloorRestylePrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreateFloorRestyleBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
    optionalImageUrlFields: ["referenceImageUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreateFloorRestyleBody>,
    PromptResult
  >,

  referenceStyle: {
    toolKey: "referenceStyle",
    routePath: "/reference-style",
    rateLimitKey: "referenceStyle",
    models: {
      // Pruna native multi-image support: images[]=[room, ref] + reference_image="2".
      replicate: "prunaai/p-image-edit" as const,
      // Klein 9B Edit accepts `image_urls` as an array; we send both target
      // and reference here. Quality vs purpose-built multi-ref editors should
      // be A/B tested in production.
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    bodySchema: CreateReferenceStyleBody,
    bodyJsonSchema: referenceStyleBodyJsonSchema,
    summary: "Enqueue a reference-style design transformation",
    description:
      "Accepts a user room/building photo URL plus a reference photo URL whose aesthetic to apply. Style is conveyed entirely by the reference image — no style or palette enums. Creates a generation record and enqueues an async Cloud Tasks job; the provider call passes both images and asks the model to restyle image 1 to match image 2 while preserving image 1's geometry. Returns 202 with a generationId. Note: this endpoint uses `roomImageUrl` (not `imageUrl`) and `referenceImageUrl` to match the iOS contract; both must be distinct http/https URLs.",
    buildPrompt: buildReferenceStylePrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreateReferenceStyleBody.parse(raw),
    imageUrlFields: ["roomImageUrl", "referenceImageUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreateReferenceStyleBody>,
    PromptResult
  >,

  virtualStaging: {
    toolKey: "virtualStaging",
    routePath: "/virtual-staging",
    rateLimitKey: "virtualStaging",
    models: {
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    bodySchema: CreateVirtualStagingBody,
    bodyJsonSchema: virtualStagingBodyJsonSchema,
    summary: "Enqueue a virtual staging transformation",
    description:
      "Stages empty or sparsely furnished rooms with furniture and decor. Unlike Interior Design which transforms existing furnishings, this tool adds furniture to empty spaces. Supports two modes: `keepLayout` preserves existing furniture and adds complementary pieces; `fullStaging` stages the room as if empty. Creates a generation record and enqueues an async Cloud Tasks job; returns 202 with a generationId.",
    buildPrompt: buildVirtualStagingPrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreateVirtualStagingBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreateVirtualStagingBody>,
    PromptResult
  >,
} as const;

export type ToolTypeKey = keyof typeof TOOL_TYPES;
