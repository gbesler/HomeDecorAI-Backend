import type { FastifySchema } from "fastify";
import type { z } from "zod";
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
  buildInteriorPrompt,
  type InteriorParams,
} from "./prompts/tools/interior-design.js";
import type { PromptResult } from "./prompts/types.js";
import {
  CreateExteriorDesignBody,
  CreateGardenDesignBody,
  CreateInteriorDesignBody,
} from "../schemas/generated/api.js";

export type { InteriorParams, ExteriorParams, GardenParams };

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
  } satisfies ToolTypeConfig<InteriorParams, PromptResult>,

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
  } satisfies ToolTypeConfig<ExteriorParams, PromptResult>,

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
  } satisfies ToolTypeConfig<GardenParams, PromptResult>,
} as const;

export type ToolTypeKey = keyof typeof TOOL_TYPES;
