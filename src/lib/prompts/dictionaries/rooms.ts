/**
 * Rooms dictionary — 12 entries covering every value in the iOS `RoomType`
 * enum. Each entry provides the per-room `focusSlots` that the builder uses
 * to compose the R3 room-focus layer.
 *
 * R13: bathroom and kitchen use fixture-focused dialect ("replace all
 *      furniture" is explicitly in `avoidAdditions`).
 * R14: stairway, entryway, underStairSpace use non-furniture dialect.
 * R15: gamingRoom uses setup-character dialect.
 *
 * The `office` / `homeOffice` / `studyRoom` triplet is intentionally
 * differentiated — they are distinct enum values in iOS and should produce
 * distinct outputs.
 */

import { RoomType } from "../../../schemas/generated/types/roomType.js";
import type { RoomsDict } from "../types.js";

// ─── Rooms dictionary ──────────────────────────────────────────────────────

export const rooms: RoomsDict = {
  [RoomType.livingRoom]: {
    focusSlots: {
      furnitureDialect:
        "central seating arrangement with a statement sofa, accent chairs around a coffee table, media wall or fireplace focal point, side tables with lamps",
      lightingDialect:
        "layered lighting with a statement overhead fixture, floor lamps near seating, and warm accent lighting",
      personalization:
        "curated shelf objects, framed art on the main wall, a thoughtful throw blanket and cushions",
    },
    preservationHint:
      "If a sofa, accent chairs, coffee table, side tables, lamps, or a media wall are visible in the source, restyle them in place and preserve every primary furniture piece in its original position.",
  },

  [RoomType.bedroom]: {
    focusSlots: {
      furnitureDialect:
        "bed as the dominant element with matching bedside tables, a dresser or wardrobe, an accent reading chair if space allows",
      lightingDialect:
        "warm ambient ceiling light, bedside reading lamps, dimmable for nighttime",
      personalization:
        "layered bedding, a textured throw, a small stack of books on the nightstand",
    },
    preservationHint:
      "If a bed, bedside tables, dresser, wardrobe, reading chair, or other primary bedroom furniture are visible, restyle them in place — keep their footprint and the bed's orientation exactly as in the source.",
  },

  [RoomType.kitchen]: {
    focusSlots: {
      furnitureDialect:
        "cabinetry, countertop material, backsplash pattern, hardware finishes, kitchen island, integrated appliances, pendant lighting over the island",
      lightingDialect:
        "bright task lighting under cabinets, pendant lights over the island, natural daylight through windows",
      materialDialect:
        "cabinet door style, countertop stone or surface, backsplash tile, hardware metal finish",
      avoidAdditions: ["replace all furniture"],
    },
    preservationHint:
      "Keep the existing cabinetry layout, island position, appliance locations, sink position, and window placements exactly as in the source — only restyle the finishes, hardware, countertops, backsplash, and visible decor.",
  },

  [RoomType.underStairSpace]: {
    focusSlots: {
      furnitureDialect:
        "built-in storage or shelving fitted to the angled ceiling, a compact bench or reading nook, wall-mounted art, a runner rug along any path",
      lightingDialect:
        "recessed ceiling lights, a small pendant or wall sconce, warm accent lighting",
      avoidAdditions: [
        "replace all furniture",
        "add sofa",
        "add bed",
        "add dining table",
      ],
    },
    preservationHint:
      "Keep the staircase geometry, angled ceiling line, and any visible built-ins exactly as in the source. Only restyle the finishes, decor, and any small accent pieces that fit the narrow under-stair footprint.",
  },

  [RoomType.diningRoom]: {
    focusSlots: {
      furnitureDialect:
        "dining table as the central element with matching chairs, a sideboard or buffet, a statement chandelier above the table, a wall mirror or art piece",
      lightingDialect:
        "statement chandelier or pendant over the table, warm ambient wall sconces, candlelight accents",
      personalization:
        "a considered tablescape, a rug anchoring the table, seasonal centerpiece",
    },
    preservationHint:
      "If a dining table, chairs, sideboard, buffet, or overhead pendant/chandelier are visible, restyle them in place — keep the table's position, the chair count, and any visible doorway or window placements exactly as in the source.",
  },

  [RoomType.bathroom]: {
    focusSlots: {
      furnitureDialect:
        "vanity configuration, mirror framing, fixtures, tile pattern on walls and floor, shower or bath enclosure, vanity hardware, towel storage",
      lightingDialect:
        "vanity lighting flanking the mirror, overhead task light, subtle accent lighting in the shower",
      materialDialect:
        "tile pattern, vanity countertop stone, metal finishes on faucets and hardware, grout color",
      avoidAdditions: ["replace all furniture"],
    },
    preservationHint:
      "Keep the vanity, sink count, mirror position, shower or bath enclosure, toilet position, and tile layout exactly as in the source — only restyle the finishes, hardware, tile pattern, grout color, and visible decor.",
  },

  [RoomType.entryway]: {
    focusSlots: {
      furnitureDialect:
        "a narrow console table or built-in bench, a wall-mounted mirror, coat hooks or a compact coat rack, a statement runner rug, a small tray for keys",
      lightingDialect:
        "a welcoming pendant or flush-mount ceiling light, a table lamp on the console, warm ambient tone",
      avoidAdditions: [
        "replace all furniture",
        "add sofa",
        "add bed",
        "add dining table",
      ],
    },
    preservationHint:
      "Keep the entryway's corridor geometry and every visible front door, side door, doorframe, threshold, coat closet, and stair foot in place. Only restyle finishes, the console or bench, hardware, and accents that fit the entry footprint.",
  },

  [RoomType.stairway]: {
    focusSlots: {
      furnitureDialect:
        "handrail and banister finish, step runner rug, a wall gallery of framed art ascending alongside the steps, built-in wall sconces at landing heights",
      lightingDialect:
        "wall-mounted sconces at each landing, natural light from any window on the landing, subtle step lighting",
      avoidAdditions: [
        "replace all furniture",
        "add sofa",
        "add bed",
        "add dining table",
      ],
    },
    preservationHint:
      "Keep the stair run, step count, landing positions, banister geometry, and any visible doorway or window exactly as in the source. Only restyle the railing finish, runner, wall art, sconces, and surface treatments.",
  },

  [RoomType.office]: {
    focusSlots: {
      furnitureDialect:
        "an executive desk with an ergonomic chair, filing storage behind or beside the desk, a small meeting or guest seating area, neutral wall art",
      lightingDialect:
        "bright overhead task lighting, a focused desk lamp, natural daylight preferred",
      personalization:
        "minimal personal items, professional books, a single plant or considered desk object",
    },
    preservationHint:
      "If a desk, chair, filing storage, or guest seating are visible, restyle them in place — keep the desk's position and orientation, the chair count, and any visible doorway or window placements exactly as in the source.",
  },

  [RoomType.homeOffice]: {
    focusSlots: {
      furnitureDialect:
        "a writing or computer desk integrated into a residential space, a comfortable task chair, a bookshelf or storage cabinet, soft textiles softening the workspace",
      lightingDialect:
        "a warm desk lamp, ambient room lighting, daylight through nearby windows",
      personalization:
        "framed personal photos, a plant, a few books, a small decorative object on the desk",
    },
    preservationHint:
      "If a desk, task chair, bookshelf, or storage cabinet are visible, restyle them in place. Keep the desk's position, any visible doorway, window, and the surrounding residential context exactly as in the source.",
  },

  [RoomType.studyRoom]: {
    focusSlots: {
      furnitureDialect:
        "wall-to-wall bookshelves holding a substantial book collection, a classic reading chair with ottoman, a writing desk, a rolling library ladder if ceilings allow",
      lightingDialect:
        "a focused reading floor lamp beside the chair, a warm desk lamp, ambient overhead light kept low and warm",
      personalization:
        "stacked books, a reading lamp, a throw blanket on the chair, scholarly objects",
    },
    preservationHint:
      "If bookshelves, a reading chair, ottoman, or writing desk are visible, restyle them in place. Keep the shelf footprint, the reading chair position, and any visible doorway, window, or ceiling feature exactly as in the source.",
  },

  [RoomType.gamingRoom]: {
    focusSlots: {
      furnitureDialect:
        "ergonomic gaming chair, a wide or multi-monitor desk setup, cable management behind the desk, speakers or headphones at the desk",
      lightingDialect:
        "ambient RGB accent lighting behind the desk and along the wall, a warm focused task light on the desk, dimmable overhead",
      setupCharacter:
        "multi-monitor array, mechanical keyboard, gaming headset stand, acoustic paneling on at least one wall, minimal window glare",
      avoidAdditions: ["replace ergonomic setup"],
    },
    preservationHint:
      "Keep the desk position, monitor arrangement, gaming chair, and any speakers, peripherals, or wall-mounted gear exactly as in the source. Only restyle the desk surface finish, accent lighting color, wall treatments, and decor.",
  },
};
