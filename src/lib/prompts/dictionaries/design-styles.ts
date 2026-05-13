/**
 * Design styles dictionary — 18 entries covering every value in the iOS
 * `DesignStyle` enum. Each entry provides the `StyleEntry` fields the
 * builder uses to compose R2 (style descriptor) and to branch on actionMode.
 *
 * Special entries:
 * - `christmas`: `actionMode: "overlay"` + `recipeRef: "christmas-recipes"`
 *   → per-room recipe lookup for whitelist rooms, F4 verb-split fallback
 *   for non-whitelist rooms.
 * - `airbnb`: `actionMode: "target"` + `slotOverrides` that neutralize
 *   personalization and ambient lighting for rental-ready staging.
 * - All other 16 styles: `actionMode: "transform"`.
 *
 * R25 editorial validation: `references` must have >= 3 entries per style.
 * These are starting-point URLs; replace with curated reference boards
 * during the first post-launch editorial review (6-monthly cadence).
 */

import { DesignStyle } from "../../../schemas/generated/types/designStyle.js";
import type { DesignStylesDict } from "../types.js";

/**
 * Generic 3-source reference set for a style keyword. Uses Pinterest,
 * Architectural Digest, and Dezeen public URLs as the starting reference
 * set. Replace with curated specific boards post-launch per R25.
 */
function placeholderRefs(keyword: string): string[] {
  const q = encodeURIComponent(keyword);
  return [
    `https://www.pinterest.com/search/pins/?q=${q}+interior+design`,
    `https://www.architecturaldigest.com/search?q=${q}`,
    `https://www.dezeen.com/search/${q}/`,
  ];
}

// ─── Styles dictionary ─────────────────────────────────────────────────────

export const designStyles: DesignStylesDict = {
  [DesignStyle.modern]: {
    coreAesthetic: "clean, intentional, architecturally honest",
    colorPalette: ["warm gray", "off-white", "matte black", "brass"],
    materials: ["brushed steel", "smoked oak", "smoked glass", "wool rug"],
    signatureItems: [
      "low-profile sectional sofa",
      "sculptural pendant light",
      "minimalist open shelving",
    ],
    lightingCharacter: "bright even daylight with a warm ambient accent",
    moodKeywords: ["sophisticated", "intentional", "architectural"],
    actionMode: "transform",
    guidanceBand: "balanced",
    changeBudget: "furniture-restyle",
    references: placeholderRefs("modern"),
  },

  [DesignStyle.minimalist]: {
    coreAesthetic: "reductive, serene, negative-space forward",
    colorPalette: ["chalk white", "pale birch", "soft dove gray", "matte black"],
    materials: ["solid wood", "painted steel", "natural linen", "raw concrete"],
    signatureItems: [
      "low platform bed or sofa",
      "single statement pendant",
      "hidden integrated storage",
    ],
    lightingCharacter: "soft diffused daylight, minimal artificial accent",
    moodKeywords: ["calm", "uncluttered", "serene"],
    actionMode: "transform",
    guidanceBand: "faithful",
    changeBudget: "furniture-restyle",
    references: placeholderRefs("minimalist"),
  },

  [DesignStyle.scandinavian]: {
    coreAesthetic: "light-filled, practical, hygge-forward",
    colorPalette: ["pale birch", "chalk white", "dove gray", "muted sage"],
    materials: ["bleached oak", "natural linen", "boucle wool", "white ceramic"],
    signatureItems: [
      "light wood dining table",
      "chunky knit throw blanket",
      "paper or rice globe pendant",
    ],
    lightingCharacter: "bright overcast morning light, evenly diffused",
    moodKeywords: ["cozy", "practical", "airy"],
    actionMode: "transform",
    guidanceBand: "faithful",
    changeBudget: "furniture-restyle",
    references: placeholderRefs("scandinavian"),
  },

  [DesignStyle.industrial]: {
    coreAesthetic: "raw, urban, warehouse-converted",
    colorPalette: ["rust brown", "charcoal", "gunmetal gray", "aged copper"],
    materials: [
      "reclaimed wood beams",
      "black steel framing",
      "exposed brick",
      "polished concrete",
    ],
    signatureItems: [
      "leather chesterfield sofa",
      "Edison bulb pendant cluster",
      "metal-framed open shelving",
    ],
    lightingCharacter: "late afternoon with long directional window shadows",
    moodKeywords: ["raw", "masculine", "urban"],
    actionMode: "transform",
    guidanceBand: "balanced",
    changeBudget: "furniture-swap",
    references: placeholderRefs("industrial"),
  },

  [DesignStyle.bohemian]: {
    coreAesthetic: "layered, collected, unapologetically eclectic",
    colorPalette: ["terracotta", "deep teal", "mustard yellow", "burnt orange"],
    materials: ["rattan", "macrame textile", "vintage kilim", "aged brass"],
    signatureItems: [
      "low floor cushions around a coffee table",
      "hanging plants cascading from the ceiling",
      "layered patterned rugs",
    ],
    lightingCharacter: "warm golden afternoon with string-light accents",
    moodKeywords: ["eclectic", "collected", "artistic"],
    actionMode: "transform",
    guidanceBand: "creative",
    changeBudget: "furniture-swap",
    references: placeholderRefs("bohemian"),
  },

  [DesignStyle.contemporary]: {
    coreAesthetic: "current, refined, gently trend-aware",
    colorPalette: ["soft taupe", "warm ivory", "matte black", "muted sage"],
    materials: [
      "velvet upholstery",
      "brushed brass",
      "natural stone surfaces",
      "smoked oak",
    ],
    signatureItems: [
      "curved-back sofa",
      "organic sculptural floor lamp",
      "large statement wall art",
    ],
    // Fixture-room overrides: the style's defaults are upholstery- and
    // free-standing-furniture-led ("curved-back sofa") which produce a
    // sofa-in-the-kitchen failure mode. These per-room lists keep the
    // contemporary aesthetic but spell it out in cabinetry / fixture
    // terms instead, so the model has nothing furniture-shaped to insert.
    signatureItemsByRoom: {
      kitchen: [
        "handleless flat-front cabinetry in smoked oak with matte black reveals",
        "waterfall-edge stone island with a brushed brass tap",
        "linear pendant cluster suspended over the island",
      ],
      bathroom: [
        "floating smoked oak vanity with an integrated stone basin",
        "frameless mirror with backlit warm glow",
        "matte black brushware with brushed brass accents",
      ],
    },
    materialsByRoom: {
      kitchen: [
        "smoked oak cabinetry",
        "honed natural stone countertops",
        "brushed brass hardware",
        "matte black accents",
      ],
      bathroom: [
        "honed natural stone surfaces",
        "smoked oak vanity wood",
        "brushed brass fixtures",
        "large-format matte porcelain tile",
      ],
    },
    lightingCharacter: "warm balanced ambient with daylight through large windows",
    moodKeywords: ["current", "refined", "approachable"],
    actionMode: "transform",
    guidanceBand: "balanced",
    changeBudget: "furniture-restyle",
    references: placeholderRefs("contemporary"),
  },

  [DesignStyle.midCentury]: {
    coreAesthetic: "mid-century modern with 1950s-60s lines",
    colorPalette: [
      "walnut brown",
      "mustard yellow",
      "avocado green",
      "burnt orange",
    ],
    materials: ["solid walnut", "tweed upholstery", "brass accents", "teak veneer"],
    signatureItems: [
      "Eames-style lounge chair and ottoman",
      "teak sideboard with tapered legs",
      "sputnik chandelier",
    ],
    lightingCharacter: "warm filtered afternoon sun through sheer curtains",
    moodKeywords: ["retro", "optimistic", "crafted"],
    actionMode: "transform",
    guidanceBand: "balanced",
    changeBudget: "furniture-restyle",
    references: placeholderRefs("mid-century-modern"),
  },

  [DesignStyle.coastal]: {
    coreAesthetic: "breezy, beach-inspired, light-filled",
    colorPalette: ["seafoam green", "driftwood gray", "sand white", "navy blue"],
    materials: [
      "whitewashed oak",
      "natural rattan",
      "linen slipcover",
      "jute rope accents",
    ],
    signatureItems: [
      "slipcovered linen sofa",
      "rope-wrapped pendant light",
      "driftwood accent pieces",
    ],
    lightingCharacter: "bright seaside daylight with a cool tone",
    moodKeywords: ["relaxed", "breezy", "fresh"],
    actionMode: "transform",
    guidanceBand: "balanced",
    changeBudget: "furniture-restyle",
    references: placeholderRefs("coastal"),
  },

  [DesignStyle.farmhouse]: {
    coreAesthetic: "rustic, warm, utilitarian with country charm",
    colorPalette: ["barn white", "weathered wood", "soft cream", "muted sage"],
    materials: [
      "shiplap wall paneling",
      "reclaimed pine",
      "wrought iron hardware",
      "glazed ceramic",
    ],
    signatureItems: [
      "long farmhouse dining table with bench",
      "mason jar chandelier",
      "slipcovered sofa in natural linen",
    ],
    lightingCharacter: "warm golden morning light through paned windows",
    moodKeywords: ["warm", "hospitable", "simple"],
    actionMode: "transform",
    guidanceBand: "balanced",
    changeBudget: "furniture-restyle",
    references: placeholderRefs("farmhouse"),
  },

  [DesignStyle.japandi]: {
    coreAesthetic: "Japanese-Scandinavian fusion, low, grounded, reverent",
    colorPalette: ["warm oak", "soft clay", "muted sage", "off-white"],
    materials: [
      "light oak",
      "natural linen",
      "washi paper",
      "hand-thrown stoneware",
    ],
    signatureItems: [
      "low platform bed or sofa close to the floor",
      "rice paper floor lantern",
      "wabi-sabi ceramic vessels",
    ],
    lightingCharacter:
      "soft diffused natural light, deliberately low artificial brightness",
    moodKeywords: ["serene", "grounded", "intentional"],
    actionMode: "transform",
    guidanceBand: "faithful",
    changeBudget: "furniture-restyle",
    references: placeholderRefs("japandi"),
  },

  [DesignStyle.artDeco]: {
    coreAesthetic: "glamorous, geometric, 1920s luxe",
    colorPalette: ["deep emerald", "polished gold", "black lacquer", "cream"],
    materials: [
      "polished brass",
      "black marble",
      "emerald velvet",
      "lacquered rosewood",
    ],
    signatureItems: [
      "fluted cabinetry with brass inlay",
      "fan-back velvet armchair",
      "starburst or sunburst mirror",
    ],
    lightingCharacter:
      "dramatic golden hour with warm interior glow from multiple sources",
    moodKeywords: ["glamorous", "bold", "sophisticated"],
    actionMode: "transform",
    guidanceBand: "creative",
    changeBudget: "furniture-swap",
    references: placeholderRefs("art-deco"),
  },

  [DesignStyle.traditional]: {
    coreAesthetic: "classic, symmetrical, refined Old-World",
    colorPalette: ["deep burgundy", "antique gold", "cream", "forest green"],
    materials: [
      "polished mahogany",
      "damask upholstery",
      "polished brass",
      "Persian wool rug",
    ],
    signatureItems: [
      "camelback sofa in tufted fabric",
      "crystal chandelier",
      "wingback armchair with ottoman",
    ],
    lightingCharacter: "warm ambient evening with candle-style wall sconces",
    moodKeywords: ["timeless", "refined", "established"],
    actionMode: "transform",
    guidanceBand: "balanced",
    changeBudget: "furniture-restyle",
    references: placeholderRefs("traditional-interior"),
  },

  [DesignStyle.tropical]: {
    coreAesthetic: "lush, resort-inspired, vividly alive",
    colorPalette: [
      "deep jungle green",
      "bamboo tan",
      "coral pink",
      "cream white",
    ],
    materials: [
      "woven rattan",
      "bamboo",
      "banana-leaf printed fabric",
      "teak wood",
    ],
    signatureItems: [
      "peacock rattan chair",
      "large monstera and palm plants",
      "bamboo ceiling fan with wooden blades",
    ],
    lightingCharacter:
      "bright tropical daylight filtered through louvered window shutters",
    moodKeywords: ["vibrant", "lush", "resort"],
    actionMode: "transform",
    guidanceBand: "creative",
    changeBudget: "furniture-swap",
    references: placeholderRefs("tropical-interior"),
  },

  [DesignStyle.rustic]: {
    coreAesthetic: "mountain lodge, rugged, earthy",
    colorPalette: [
      "rich chestnut brown",
      "moss green",
      "stone gray",
      "warm rust",
    ],
    materials: [
      "exposed log beams",
      "stacked stone",
      "hand-forged wrought iron",
      "aged leather",
    ],
    signatureItems: [
      "stone fireplace as focal point",
      "reclaimed beam ceiling",
      "leather club chair near the hearth",
    ],
    lightingCharacter: "warm golden lamplight with flickering firelight accents",
    moodKeywords: ["cozy", "natural", "grounding"],
    actionMode: "transform",
    guidanceBand: "balanced",
    changeBudget: "furniture-swap",
    references: placeholderRefs("rustic-lodge"),
  },

  [DesignStyle.luxury]: {
    coreAesthetic: "high-end, polished, statement-driven",
    colorPalette: ["champagne gold", "deep navy", "calacatta marble white", "ebony"],
    materials: [
      "calacatta marble",
      "polished brass",
      "silk velvet",
      "smoked glass",
    ],
    signatureItems: [
      "tufted chesterfield sofa",
      "oversized crystal chandelier",
      "brass inlay coffee table",
    ],
    lightingCharacter: "golden hour with warm interior glow and layered accents",
    moodKeywords: ["opulent", "refined", "established"],
    actionMode: "transform",
    guidanceBand: "balanced",
    changeBudget: "furniture-swap",
    references: placeholderRefs("luxury-interior"),
  },

  [DesignStyle.cozy]: {
    coreAesthetic: "warm, inviting, layered with soft textures",
    colorPalette: [
      "warm terracotta",
      "cream",
      "caramel brown",
      "forest green",
    ],
    materials: [
      "chunky knit wool",
      "aged leather",
      "warm oak",
      "sheepskin throw",
    ],
    signatureItems: [
      "oversized armchair with ottoman",
      "layered knit throws",
      "candle grouping on a side table",
    ],
    lightingCharacter: "warm golden lamplight with multiple small sources",
    moodKeywords: ["warm", "inviting", "nostalgic"],
    actionMode: "transform",
    guidanceBand: "balanced",
    changeBudget: "furniture-restyle",
    references: placeholderRefs("cozy-interior"),
  },

  // ─── Special cases ─────────────────────────────────────────────────────

  [DesignStyle.christmas]: {
    coreAesthetic: "festive holiday layered decor",
    colorPalette: [
      "deep evergreen",
      "warm cranberry",
      "polished brass",
      "candlelight amber",
    ],
    materials: [
      "fir garland",
      "red velvet ribbon",
      "brass candlesticks",
      "white linen",
    ],
    signatureItems: [
      "Christmas tree with classic ornaments",
      "fir garland",
      "warm white string lights",
    ],
    lightingCharacter:
      "warm candlelit glow with festive string lights throughout",
    moodKeywords: ["festive", "warm", "seasonal"],
    actionMode: "overlay",
    guidanceBand: "balanced",
    changeBudget: "overlay",
    recipeRef: "christmas-recipes",
    references: placeholderRefs("christmas-interior-decor"),
  },

  [DesignStyle.airbnb]: {
    coreAesthetic: "broadly appealing rental-ready, photogenic, hotel-inspired",
    colorPalette: [
      "warm white",
      "light oak",
      "soft gray",
      "subtle navy accent",
    ],
    materials: [
      "durable performance fabric",
      "porcelain tile",
      "brushed brass",
      "engineered oak flooring",
    ],
    signatureItems: [
      "hotel-style layered bedding",
      "cohesive neutral art",
      "coordinated throw pillows",
    ],
    lightingCharacter: "bright neutral LED task lighting with warm accent",
    moodKeywords: ["inviting", "photogenic", "broadly appealing"],
    actionMode: "target",
    guidanceBand: "balanced",
    changeBudget: "furniture-restyle",
    // Positively framed staging description. The earlier copy used negation
    // tokens ("no family photos, no keepsakes", "no dim mood lighting") that
    // violated the positive-avoidance invariant — Flux family models bias
    // toward the negated content. Replaced with positive equivalents that
    // describe the rental-ready staging directly.
    slotOverrides: {
      personalization:
        "neutralized styling with minimal generic accents, broadly appealing styling, a single tasteful plant or art piece",
      lightingDialect:
        "bright neutral LED task lighting with warm accent fills throughout the room",
    },
    references: placeholderRefs("airbnb-rental-staging"),
  },
};
