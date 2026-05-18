import type { FastifySchema } from "fastify";
import { type z } from "zod";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { getActiveObjectInspirationOrNull } from "./objectInspiration/firestore.js";
import { validatePublicImageUrl } from "./storage/url-validation.js";
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
  buildOutdoorLightingPrompt,
  type OutdoorLightingParams,
} from "./prompts/tools/outdoor-lighting-design.js";
import {
  buildInteriorPrompt,
  type InteriorParams,
} from "./prompts/tools/interior-design.js";
import { buildInteriorPromptV2 } from "./prompts/tools/interior-design-v2.js";
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
import {
  buildCleanOrganizePrompt,
  type CleanOrganizeParams,
} from "./prompts/tools/clean-organize.js";
import {
  buildRemoveObjectsPrompt,
  type RemoveObjectsParams,
} from "./prompts/tools/remove-objects.js";
import {
  buildReplaceAddObjectPrompt,
  type ReplaceAddObjectParams,
} from "./prompts/tools/replace-add-object.js";
import {
  buildExteriorPaintingPrompt,
  type ExteriorPaintingParams,
} from "./prompts/tools/exterior-painting.js";
import type { PromptResult } from "./prompts/types.js";
import {
  CreateCleanOrganizeBody,
  CreateRemoveObjectsBody,
  CreateReplaceAddObjectBody,
  CreateExteriorDesignBody,
  CreateExteriorPaintingBody,
  CreateFloorRestyleBody,
  CreateGardenDesignBody,
  CreateInteriorDesignBody,
  CreatePaintWallsBody,
  CreatePatioDesignBody,
  CreatePoolDesignBody,
  CreateOutdoorLightingDesignBody,
  CreateReferenceStyleBody,
  CreateVirtualStagingBody,
} from "../schemas/generated/api.js";

export type {
  InteriorParams,
  ExteriorParams,
  GardenParams,
  PatioParams,
  PoolParams,
  OutdoorLightingParams,
  ReferenceStyleParams,
  PaintWallsParams,
  FloorRestyleParams,
  VirtualStagingParams,
  CleanOrganizeParams,
  ExteriorPaintingParams,
  RemoveObjectsParams,
  ReplaceAddObjectParams,
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
  /**
   * Pipeline mode. Controls which router function the processor dispatches to.
   *
   * - `"edit"` (default):      single-step i2i via `callDesignGeneration`.
   *                            Model slugs come from `models.replicate`/`falai`.
   * - `"segment-remove"`:      SAM 3 → persist mask → LaMa. Builder must
   *                            return `segmentTextPrompt` (concept noun
   *                            phrase). `prompt` is ignored.
   * - `"remove-only"`:         LaMa with a caller-supplied mask URL.
   *                            Expects `maskUrl` in toolParams; no SAM call.
   *                            `prompt` is ignored (LaMa takes no prompt).
   * - `"multi-image-edit-with-mask"`:
   *                            Multi-image instructional edit with a
   *                            caller-supplied mask URL, used by the
   *                            Replace & Add Object tool on top of Nano
   *                            Banana (`google/nano-banana`). The
   *                            inspiration's reference photo is sent as
   *                            image 2 and the brush mask as image 3
   *                            via the provider adapters' multi-image
   *                            array. A composite post-process
   *                            (compositeMaskedResult) preserves
   *                            outside-mask pixels against the original.
   *                            Replaced the `"inpaint-with-prompt"` mode
   *                            (Flux Fill caption-fill) as of v4.0.
   *                            Model slugs are read from the tool's
   *                            `models` registry field — NOT env —
   *                            because this mode rides the `edit` role.
   *
   * Model slugs are sourced from env for the segment/remove roles
   * (`REPLICATE_SEGMENTATION_MODEL`, `REPLICATE_REMOVAL_MODEL`). The
   * `edit` and `multi-image-edit-with-mask` modes read directly from
   * the registry entry's `models` field so multi-image tools can
   * pin their provider choice independently of other edit tools.
   */
  mode?:
    | "edit"
    | "segment-remove"
    | "remove-only"
    | "multi-image-edit-with-mask";
  /** AI provider model IDs for the router. Consumed only when mode is "edit". */
  models: {
    replicate: `${string}/${string}`;
    falai: string;
  };
  /**
   * Zod body schema (without `language` — the controller factory adds it).
   *
   * The third `Input` type parameter is `unknown` rather than `TParams`
   * so schemas with `.default()` / `.transform()` (where the parsed
   * output type differs from the raw input type) satisfy this slot.
   * `replaceAddObject` uses `mode: zod.enum(...).optional().default("replace")`
   * to preserve backward compatibility with iOS clients that pre-date
   * the mode-aware split — the resulting input type allows `mode` to
   * be absent, but the output type still narrows to `"replace" | "add"`.
   */
  bodySchema: z.ZodType<TParams, z.ZodTypeDef, unknown>;
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
  /**
   * Fields whose URL MUST be a client-uploaded artifact hosted on one of the
   * project's own origins (S3 bucket or CloudFront). Enforced IN ADDITION to
   * `validateImageUrlScheme` by the controller. Use for tool inputs that
   * would otherwise let an attacker hand the provider an arbitrary URL —
   * most notably Remove Objects' `maskUrl`. Leave unset for tools whose
   * image URLs may legitimately come from any HTTPS origin the user
   * controls (none today, but the opt-in shape keeps it that way).
   */
  clientUploadFields?: readonly (keyof TParams & string)[];
  /**
   * Optional async pre-enqueue gate. Runs after body validation + image-URL
   * checks but before `createQueuedGeneration`. Use it to re-validate
   * mutable server-side state (e.g. that an `inspirationId` is still
   * `active==true`) and to substitute server-authoritative values into the
   * params blob (e.g. swap the client-supplied `prompt` for the canonical
   * Firestore prompt). On `ok: false`, the controller returns the
   * specified status code with `{ error: code, message }`.
   *
   * Introduced by the object-inspirations migration (plan Unit 3 / R6):
   * the AI generation endpoint MUST honour admin deactivations between
   * snapshot and submit. Without this hook, deactivated content reaches
   * the AI provider.
   */
  preEnqueueValidate?: (
    params: TParams,
  ) => Promise<PreEnqueueValidateResult<TParams>>;
}

/** Outcome of `ToolTypeConfig.preEnqueueValidate`. */
export type PreEnqueueValidateResult<TParams> =
  | {
      ok: true;
      /** Substituted params (e.g. server-authoritative prompt). When omitted,
       *  the original params are used unchanged. */
      params?: TParams;
    }
  | {
      ok: false;
      status: 400 | 404 | 409;
      code: string;
      message: string;
    };

// ─── Interior prompt dispatch ──────────────────────────────────────────────
//
// Three-way switch driven by PROMPT_BUILDER_VERSION:
//   - "legacy" → buildInteriorPromptLegacy (D17 F2 escape hatch)
//   - "v1"     → buildInteriorPrompt       (current default)
//   - "v2"     → buildInteriorPromptV2     (head-layer preservation,
//                                            preservationHint, changeBudget)
//
// Flip at runtime to roll forward to v2 after staging burn-in, or back to
// v1/legacy without a code deploy. See
// docs/runbooks/interior-prompt-version-rollout.md.

function buildInteriorPromptDispatch(params: InteriorParams): PromptResult {
  const version = env.PROMPT_BUILDER_VERSION;
  switch (version) {
    case "legacy":
      return buildInteriorPromptLegacy(params);
    case "v1":
      return buildInteriorPrompt(params);
    case "v2":
      return buildInteriorPromptV2(params);
  }
  // Exhaustiveness check — adding a new PROMPT_BUILDER_VERSION value to
  // env.ts without updating this switch fails compilation here rather
  // than silently routing to v1.
  const _exhaustive: never = version;
  throw new Error(`unreachable PROMPT_BUILDER_VERSION: ${_exhaustive as string}`);
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
  "mediterranean",
  "tropical",
  "rustic",
  "modern",
] as const;

const POOL_STYLES = [
  "poolSpa",
  "resort",
  "waterfall",
  "infinity",
  "lagoon",
  "lapPool",
  "mediterranean",
  "grotto",
  "beachEntry",
  "mosaicTile",
] as const;

const OUTDOOR_LIGHTING_STYLES = [
  "warmAmbient",
  "stringLights",
  "pathwayLighting",
  "uplighting",
  "lantern",
  "modernArchitectural",
  "moody",
  "festiveHoliday",
  "poolside",
  "torchlight",
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

const outdoorLightingBodyJsonSchema = {
  type: "object" as const,
  required: ["imageUrl", "lightingStyle"] as const,
  properties: {
    imageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the outdoor photo to relight (must use http or https scheme)",
    },
    lightingStyle: {
      type: "string" as const,
      enum: OUTDOOR_LIGHTING_STYLES,
      description: "Target outdoor lighting style for the transformation",
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

const EXTERIOR_MATERIALS = [
  "keepOriginal",
  "texturedBrick",
  "vinylSiding",
  "smoothStucco",
  "naturalStone",
  "woodCladding",
  "metalPanel",
  "fiberCement",
  "limestoneFacade",
  "concreteFacade",
] as const;

const exteriorPaintingBodyJsonSchema = {
  type: "object" as const,
  required: ["imageUrl", "colorPalette", "material"] as const,
  properties: {
    imageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the building photo to repaint (must use http or https scheme)",
    },
    colorPalette: {
      type: "string" as const,
      enum: EXTERIOR_PALETTES,
      description:
        "Color palette id. `surpriseMe` lets the model pick a balanced palette.",
    },
    material: {
      type: "string" as const,
      enum: EXTERIOR_MATERIALS,
      description:
        "Exterior cladding material. `keepOriginal` repaints without swapping the material; any other value replaces the cladding with the named material.",
    },
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications.",
    },
  },
};

const DECLUTTER_LEVELS = ["full", "light"] as const;

const cleanOrganizeBodyJsonSchema = {
  type: "object" as const,
  required: ["imageUrl", "declutterLevel"] as const,
  properties: {
    imageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the room photo to declutter (must use http or https scheme)",
    },
    declutterLevel: {
      type: "string" as const,
      enum: DECLUTTER_LEVELS,
      description:
        "`full` performs a complete tidy-up; `light` leaves some lived-in character intact.",
    },
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications.",
    },
  },
};

const removeObjectsBodyJsonSchema = {
  type: "object" as const,
  required: ["imageUrl", "maskUrl"] as const,
  properties: {
    imageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the room photo (must use http or https scheme).",
    },
    maskUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the binary mask PNG (white pixels = remove, black = preserve). Must match the image dimensions and be hosted on an allowlisted host.",
    },
    prompt: {
      type: "string" as const,
      maxLength: 200,
      description:
        "Optional caption describing what should replace the removed area. Defaults to a surface-completion fill.",
    },
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications.",
    },
  },
};

const replaceAddObjectBodyJsonSchema = {
  type: "object" as const,
  // `mode` is intentionally NOT in `required` for one release cycle: any
  // older iOS binary that shipped before the mode-aware split (TestFlight,
  // App Store phased rollout, users with auto-update disabled) calls
  // this endpoint without a `mode` field. Making it required would
  // 400-reject all of them the moment the backend deploys. The Zod
  // schema in `schemas/generated/api.ts` defaults missing values to
  // `"replace"` server-side — that matches the iOS ViewModel default
  // and reproduces v1.3 behavior for the dominant path (paint over an
  // existing object). Tighten to required once telemetry confirms
  // old-client traffic on this endpoint has dropped to ~0.
  required: ["imageUrl", "maskUrl", "prompt", "categoryId", "inspirationId"] as const,
  properties: {
    imageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the room photo (must use http or https scheme).",
    },
    maskUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Public URL of the binary mask PNG (white = replace, black = preserve). Must be hosted on an allowlisted host.",
    },
    prompt: {
      type: "string" as const,
      minLength: 1,
      maxLength: 500,
      description:
        "Inspiration prompt describing what to place inside the masked region.",
    },
    categoryId: {
      type: "string" as const,
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-zA-Z0-9_-]+$",
      description:
        "Inspiration category id (analytics key — never reaches the AI provider).",
    },
    inspirationId: {
      type: "string" as const,
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-zA-Z0-9_-]+$",
      description: "Inspiration item id (analytics key).",
    },
    mode: {
      type: "string" as const,
      enum: ["replace", "add"] as const,
      description:
        "Optional during the rollout window — defaults to \"replace\" server-side when absent so older iOS clients that pre-date the mode-aware split continue to work. User intent for the masked region: \"replace\" = an existing object inside the mask should be removed and supplanted by the inspiration item; \"add\" = the masked area is empty and the inspiration item should be placed into it. Drives which instructional prompt template (Replace vs. Add) the v4.0 builder emits.",
    },
    // Server-internal fields populated by `preEnqueueValidate` (see
    // registry entry below). Declared here so the JSON schema published
    // to Swagger documents the wire-level shape, but iOS clients do not
    // set them and any client-supplied value is overwritten by the
    // Firestore lookup. Same pattern as the `prompt` / `categoryId`
    // server substitution.
    inspirationImageUrl: {
      type: "string" as const,
      format: "uri",
      description:
        "Server-resolved URL of the inspiration item's reference photo. Populated from `objectInspirations/{inspirationId}.imageUrl`; client-supplied values are ignored.",
    },
    inspirationTitle: {
      type: "string" as const,
      maxLength: 200,
      description:
        "Server-resolved English title of the inspiration item (from `objectInspirations/{inspirationId}.title.en`). Used as the noun phrase in the v4.0 instructional prompt. Client-supplied values are ignored.",
    },
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications.",
    },
  },
};

const virtualStagingBodyJsonSchema = {
  type: "object" as const,
  required: [
    "imageUrl",
    "roomType",
    "designStyle",
    "colorPalette",
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
    language: {
      type: "string" as const,
      enum: ["tr", "en"] as const,
      description:
        "Optional UI language snapshot for FCM push notifications.",
    },
  },
};

// ─── Helpers for the Replace & Add Object preEnqueueValidate hook ─────────

/**
 * Maximum length of the `{category}` noun phrase that interpolates into
 * the v4.0 instructional prompt. 80 chars covers every legitimate
 * catalog title (longest in the current seed manifest is "Hand-Knotted
 * Persian Wool Runner" at ~36 chars) with comfortable headroom, while
 * bounding the worst case if a future admin title runs long or contains
 * embedded instruction-following content.
 */
const INSPIRATION_TITLE_MAX_LENGTH = 80;

/**
 * Strip prompt-injection-weight characters from the inspiration title
 * before it interpolates into Gemini's instructional prompt. Removes
 * newlines, tabs, and other control characters that could let a
 * malicious admin escape the surrounding template context.
 */
const TITLE_STRIP_CHARS = /[\x00-\x1f\x7f]+/g;

/**
 * Prepare an inspiration's `title.en` for use as the `{category}` noun
 * phrase in the v4.0 multi-image-edit instructional prompt. Returns an
 * empty string when `title.en` is missing or empty — the builder treats
 * that as a signal to emit its `FALLBACK_CATEGORY` ("object").
 *
 * Why English-only (no `title.tr` or `doc.prompt` fallback): the
 * instructional template is in English ("replace the object ... with
 * the {category} shown in image 2"). Interpolating a Turkish noun or
 * the seed-template boilerplate ("A cactus suitable for interior
 * design placement.") produces grammatically broken / contradictory
 * prompts that confuse Gemini's instruction follower. When `title.en`
 * is genuinely empty for a catalog item, the FALLBACK_CATEGORY path
 * produces a sensible degraded prompt ("with the object shown in
 * image 2") that still conveys the user's mask + reference image
 * intent.
 */
function sanitizeInspirationTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const stripped = raw.replace(TITLE_STRIP_CHARS, " ").trim();
  if (stripped.length === 0) return "";
  if (stripped.length <= INSPIRATION_TITLE_MAX_LENGTH) return stripped;
  return stripped.slice(0, INSPIRATION_TITLE_MAX_LENGTH).trim();
}

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

  outdoorLightingDesign: {
    toolKey: "outdoorLightingDesign",
    routePath: "/outdoor-lighting",
    rateLimitKey: "outdoorLightingDesign",
    models: {
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    bodySchema: CreateOutdoorLightingDesignBody,
    bodyJsonSchema: outdoorLightingBodyJsonSchema,
    summary: "Enqueue an outdoor lighting transformation",
    description:
      "Accepts an outdoor photo URL and a lighting style. Creates a generation record and enqueues an async Cloud Tasks job with the same async pipeline and FCM notification as the other tools. Returns 202 with a generationId.",
    buildPrompt: buildOutdoorLightingPrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreateOutdoorLightingDesignBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreateOutdoorLightingDesignBody>,
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
      // Primary: Nano Banana on Replicate (Gemini 2.5 Flash Image). Semantic
      // multimodal reasoning genuinely handles "apply image 2's style to
      // image 1" rather than executing a distilled transform. Previous
      // primary (fal Kontext Max Multi, ~$0.11/MP) was dropped — Nano Banana
      // is producing the output users actually see.
      replicate: "google/nano-banana" as const,
      // Fallback: Flux 2 Edit on fal.ai (~$0.012/MP — roughly 9× cheaper
      // than Kontext Max Multi). Accepts up to 4 `image_urls`, which is
      // more than enough for the reference-style pair (room + style ref).
      // Provider diversity: Replicate ↔ fal, so a single-cloud outage keeps
      // the tool available.
      falai: "fal-ai/flux-2/edit",
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
      "Stages empty or sparsely furnished rooms with furniture and decor. Unlike Interior Design which transforms existing furnishings, this tool adds furniture to empty spaces, treating the room as if empty and furnishing it from scratch. Creates a generation record and enqueues an async Cloud Tasks job; returns 202 with a generationId.",
    buildPrompt: buildVirtualStagingPrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreateVirtualStagingBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreateVirtualStagingBody>,
    PromptResult
  >,

  exteriorPainting: {
    toolKey: "exteriorPainting",
    routePath: "/exterior-painting",
    rateLimitKey: "exteriorPainting",
    models: {
      // Surface-level edit: same Pruna/Klein stack as paint-walls and
      // floor-restyle. Pruna's faithful-band I2I preserves building massing
      // well for color-only and material-swap edits; Klein 9B is the
      // proven fallback with explicit guidance-scale support.
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    bodySchema: CreateExteriorPaintingBody,
    bodyJsonSchema: exteriorPaintingBodyJsonSchema,
    summary: "Enqueue an exterior painting transformation",
    description:
      "Repaints a building's exterior surfaces with a chosen color palette and optionally swaps the cladding material. Narrower than Exterior Design — no building type, no design style, no color mode. Two modes: `material: keepOriginal` repaints the existing material; any other material id replaces the cladding with the selected material finished in the chosen palette. Creates a generation record and enqueues an async Cloud Tasks job; returns 202 with a generationId.",
    buildPrompt: buildExteriorPaintingPrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreateExteriorPaintingBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreateExteriorPaintingBody>,
    PromptResult
  >,

  cleanOrganize: {
    toolKey: "cleanOrganize",
    routePath: "/clean-organize",
    rateLimitKey: "cleanOrganize",
    // Single-step instruction-driven edit (mode defaults to "edit"). Migrated
    // from the SAM 3 + LaMa segment-remove pipeline in v4.0 (May 2026):
    // SAM 3 returned all-zero masks for clutter-class concepts on real user
    // rooms regardless of prompt taxonomy, so the two-stage approach was
    // structurally untenable. Reuses the same instruction-edit models as the
    // design tools (interiorDesign, exteriorDesign, etc.) — both slugs are
    // already capability-registered with role="edit". See
    // ~/.claude/plans/bence-yol-b-yi-velvet-badger.md for migration notes.
    models: {
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/flux-2/klein/9b/edit",
    },
    bodySchema: CreateCleanOrganizeBody,
    bodyJsonSchema: cleanOrganizeBodyJsonSchema,
    summary: "Enqueue a clean & organize transformation",
    description:
      "Declutters and tidies a room while preserving every other aspect (geometry, furniture, materials, colors, style). Two levels: `full` performs a complete tidy-up with every surface cleared and items neatly organized; `light` reduces clutter moderately while keeping a lived-in feel. Creates a generation record and enqueues an async Cloud Tasks job; returns 202 with a generationId.",
    buildPrompt: buildCleanOrganizePrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreateCleanOrganizeBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreateCleanOrganizeBody>,
    PromptResult
  >,

  removeObjects: {
    toolKey: "removeObjects",
    routePath: "/remove-objects",
    rateLimitKey: "removeObjects",
    // Remove-only pipeline: the client supplies the brush mask directly, so
    // there is no segmentation call. LaMa removes + extends; fal.ai
    // object-removal is the fallback. `models` fields are decorative here
    // (router reads REPLICATE_REMOVAL_MODEL / FALAI_REMOVAL_MODEL from env)
    // but kept for documentation + rollback-to-edit parity.
    mode: "remove-only",
    models: {
      replicate: "prunaai/p-image-edit" as const,
      falai: "fal-ai/object-removal",
    },
    bodySchema: CreateRemoveObjectsBody,
    bodyJsonSchema: removeObjectsBodyJsonSchema,
    summary: "Enqueue an object removal",
    description:
      "Removes the region indicated by a client-drawn mask from a room photo and fills it with a surface-continuing completion. The mask PNG must already be uploaded (white = remove, black = preserve) and match the image dimensions. Optional `prompt` describes what should replace the removed area. Creates a generation record and enqueues an async Cloud Tasks job; returns 202 with a generationId.",
    buildPrompt: buildRemoveObjectsPrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreateRemoveObjectsBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
    // `maskUrl` is an image URL from the client's perspective, so the
    // controller factory validates it against the http/https allowlist the
    // same way it does `imageUrl`. Declared as optional here because the
    // processor reads it out of `toolParams` itself rather than forwarding
    // it as the provider's second image slot.
    optionalImageUrlFields: ["maskUrl"] as const,
    // Both URLs must have been produced by the iOS direct-upload flow —
    // see controllers/design.controller.ts:validateClientUploadHost. This
    // stops an attacker from submitting an arbitrary public URL that
    // Replicate's LaMa worker would then fetch on our behalf (SSRF
    // beacon + retry-storm amplification, surfaced in code review).
    clientUploadFields: ["imageUrl", "maskUrl"] as const,
  } satisfies ToolTypeConfig<
    z.infer<typeof CreateRemoveObjectsBody>,
    PromptResult
  >,

  replaceAddObject: {
    toolKey: "replaceAddObject",
    routePath: "/replace-add-object",
    rateLimitKey: "replaceAddObject",
    // Multi-image instructional edit pipeline (v4.0). Replaces the
    // earlier Flux Fill caption-fill path. The client supplies the
    // brush mask; `preEnqueueValidate` resolves the inspiration's
    // reference image and title from Firestore. The processor's
    // `multi-image-edit-with-mask` branch assembles a 3-image array
    // (room, inspiration, mask) and feeds it to Nano Banana
    // (`google/nano-banana`) with an instructional prompt. A
    // post-process composite step (compositeMaskedResult) enforces
    // outside-mask pixel preservation against the original room
    // image. Replicate primary, fal.ai (`fal-ai/flux-2/edit`) fallback
    // — both are multi-image-edit-capable per `capabilities.ts`.
    //
    // `models` fields are NOT decorative for this mode — the
    // `multi-image-edit-with-mask` branch reads them directly off the
    // registry entry (unlike segment/remove which read env vars).
    // Operators that want to flip between Nano Banana and a future
    // model do so by editing the registry entry, not env.
    mode: "multi-image-edit-with-mask",
    models: {
      replicate: "google/nano-banana" as const,
      falai: "fal-ai/flux-2/edit",
    },
    bodySchema: CreateReplaceAddObjectBody,
    bodyJsonSchema: replaceAddObjectBodyJsonSchema,
    summary: "Enqueue a replace-&-add-object multi-image edit",
    description:
      "Edits the region indicated by a client-drawn mask with the inspiration object the user picked, using a multi-image instructional model (Nano Banana / Gemini 2.5 Flash Image). Distinct from Remove Objects (LaMa, no prompt, surface extension): this tool generates a NEW object inside the masked region matching the inspiration's visual identity. The mask PNG must already be uploaded (white = modify, black = preserve) and match the image dimensions. `categoryId` + `inspirationId` are analytics keys from the 40×20 inspiration library; the server resolves the inspiration's reference photo from Firestore and feeds it to the model as image 2. Outside-mask pixels are preserved against the original by a backend composite step. Creates a generation record and enqueues an async Cloud Tasks job; returns 202 with a generationId.",
    buildPrompt: buildReplaceAddObjectPrompt,
    toToolParams: (params) => ({ ...params }),
    fromToolParams: (raw) => CreateReplaceAddObjectBody.parse(raw),
    imageUrlFields: ["imageUrl"] as const,
    // `maskUrl` is a client-uploaded artifact — same SSRF shape as
    // removeObjects. Declared as optional here because the processor reads
    // it out of `toolParams` itself rather than forwarding it as the
    // provider's second image slot.
    optionalImageUrlFields: ["maskUrl"] as const,
    // Both URLs must have been produced by the iOS direct-upload flow so a
    // rogue client cannot hand Flux Fill an arbitrary URL (SSRF beacon +
    // retry-storm amplification).
    clientUploadFields: ["imageUrl", "maskUrl"] as const,
    // Server-side moderation gate (plan R6). The client may have selected
    // an inspiration that the admin deactivated after the snapshot
    // listener cached it. Re-fetch from `objectInspirations/{id}` and
    // reject with 409 if it is missing or `active: false`. On success,
    // substitute the canonical `prompt` from Firestore so a jailbroken /
    // proxy-modified client cannot inject an arbitrary prompt while
    // still passing the curated `inspirationId`.
    //
    // `mode` is intentionally NOT substituted here. It represents the
    // user's stated intent for the painted region ("I painted over an
    // object" vs "I painted empty space"), which the server cannot
    // infer authoritatively from the mask alone. A jailbroken client
    // can mismatch `mode` against the actual mask content (e.g. send
    // `mode: "add"` while having painted over a sofa), but the worst
    // outcome is the wrong prompt/dilation/guidance for that single
    // generation — no security impact, no content-moderation gap. If a
    // future policy needs to gate `mode` (e.g. limit `"add"` to paid
    // tiers), this is the correct insertion point.
    preEnqueueValidate: async (params) => {
      const doc = await getActiveObjectInspirationOrNull(params.inspirationId);
      if (doc === null) {
        return {
          ok: false,
          status: 409,
          code: "CONTENT_UNAVAILABLE",
          message:
            "Selected inspiration is no longer available. Please pick another.",
        };
      }
      // Defense against a data-quality regression: an inspiration that
      // somehow shipped to Firestore without an `imageUrl` cannot drive
      // the v4.0 multi-image pipeline (the model needs the reference
      // photo to know which specific item the user picked). Treat it as
      // CONTENT_UNAVAILABLE so the user sees the same wizard-level
      // remediation as a deactivated inspiration, and surface a
      // structured log so the operator-side data-quality issue is
      // visible. Pre-v4.0 this defense was unnecessary because the
      // pipeline only consumed the prompt string.
      if (typeof doc.imageUrl !== "string" || doc.imageUrl.length === 0) {
        logger.warn(
          {
            event: "preEnqueueValidate.inspiration.image_url_missing",
            inspirationId: params.inspirationId,
          },
          "Inspiration doc missing imageUrl — data quality issue, refusing to dispatch",
        );
        return {
          ok: false,
          status: 409,
          code: "CONTENT_UNAVAILABLE",
          message:
            "Selected inspiration is missing required content. Please pick another.",
        };
      }
      // SSRF defense — the Firestore-resolved `imageUrl` is forwarded
      // to Replicate / fal.ai as image 2 in the multi-image array.
      // Admin-curated content is trusted at the auth layer but NOT at
      // the SSRF layer: a compromised or malicious admin who writes
      // `http://169.254.169.254/...` (AWS IMDS) or any RFC-1918 host
      // would otherwise have the provider worker fetch that URL from
      // its own (cloud datacenter) network namespace. Same private-host
      // regex the controller applies to client-supplied URLs.
      const urlCheck = validatePublicImageUrl(doc.imageUrl, "inspirationImageUrl");
      if (!urlCheck.ok) {
        logger.error(
          {
            event: "preEnqueueValidate.inspiration.url_unsafe",
            inspirationId: params.inspirationId,
            reason: urlCheck.message,
          },
          "Inspiration imageUrl failed SSRF/scheme validation — possible Firestore tampering or data-quality regression",
        );
        return {
          ok: false,
          status: 409,
          code: "CONTENT_UNAVAILABLE",
          message:
            "Selected inspiration is missing required content. Please pick another.",
        };
      }
      // Title sanitization for the {category} noun phrase that
      // interpolates into the v4.0 instructional prompt:
      //
      //   - English-only. The instructional template is in English, so
      //     interpolating `title.tr` (Turkish) or `doc.prompt` (seed-
      //     template boilerplate "A cactus suitable for interior
      //     design placement.") produces grammatically broken or
      //     contradictory prompts. We fall through to a fixed marker
      //     (the empty string) when `title.en` is empty; the builder
      //     emits its FALLBACK_CATEGORY ("object") in that case.
      //
      //   - Length capped at 80 chars. The instructional templates run
      //     ~120 chars; an unbounded title pushes the total prompt
      //     toward Gemini's instruction-following horizon and dilutes
      //     the structural signals (image 1 / image 2 / image 3
      //     references).
      //
      //   - Prompt-injection-weight characters stripped: newlines,
      //     control characters, em-dashes used to introduce sub-clauses.
      //     Periods are preserved (cataloged items like "F. Bossi") but
      //     can be hijacked by a malicious admin title like
      //     "Cactus. Ignore previous instructions." — the structural
      //     guard around the instruction's surrounding context (the
      //     template's "Match image 1's lighting direction..." clauses)
      //     makes this attack low-yield, but the explicit length cap
      //     bounds the worst case anyway.
      const sanitizedTitle = sanitizeInspirationTitle(doc.title.en);
      return {
        ok: true,
        params: {
          ...params,
          prompt: doc.prompt,
          categoryId: doc.categoryId,
          inspirationImageUrl: doc.imageUrl,
          inspirationTitle: sanitizedTitle,
        },
      };
    },
  } satisfies ToolTypeConfig<
    z.infer<typeof CreateReplaceAddObjectBody>,
    PromptResult
  >,
} as const;

export type ToolTypeKey = keyof typeof TOOL_TYPES;
