/**
 * Per-room Christmas decor recipes for the whitelist rooms (livingRoom,
 * diningRoom, entryway, bedroom) — R9.
 *
 * Only these four rooms receive the full "Preserve the existing style and
 * add [recipe]" overlay. Non-whitelist rooms (bathroom, kitchen, gamingRoom,
 * stairway, etc.) use the F4 verb-split fallback: "Add subtle festive
 * accents to this [room]" with the shared CHRISTMAS_FALLBACK_ACCENTS list
 * applied to the room's normal dialect.
 */

import { RoomType } from "../../../schemas/generated/types/roomType.js";
import type { ChristmasRecipesDict } from "../types.js";

// ─── Whitelist recipes ─────────────────────────────────────────────────────

export const christmasRecipes: ChristmasRecipesDict = {
  [RoomType.livingRoom]: {
    decor:
      "a full Christmas tree with warm white string lights and classic red and gold ornaments, garland draped along the mantel and any shelving, wrapped gifts stacked beneath the tree, seasonal knit throws on the sofa, pillar candles on the coffee table",
  },
  [RoomType.diningRoom]: {
    decor:
      "a festive tablescape with a greenery runner, pillar candles, gold chargers under plates, sprigs of holly at each place setting, garland draped along the backs of the dining chairs, a small Christmas centerpiece of pinecones and berries",
  },
  [RoomType.entryway]: {
    decor:
      "a full wreath with red ribbon on the inside of the front door, garland draped along the banister if stairs are visible, a welcome runner in seasonal tones, a small arrangement of pinecones and candles on the console table",
  },
  [RoomType.bedroom]: {
    decor:
      "a small decorative Christmas tree in the corner, a warm plaid or red-and-white knit throw on the bed, a garland draped along the headboard, a bedside candle and a small wrapped gift on the nightstand",
  },
};

// ─── Non-whitelist fallback (F4 verb-split) ────────────────────────────────

/**
 * Minimal festive accents applied to non-whitelist rooms. The builder
 * composes these with the room's normal `focusSlots` dialect using the
 * "Add subtle festive accents to this [room]" verb variant.
 *
 * No Christmas trees, no wrapped gifts, nothing that would visually clash
 * with utilitarian rooms (bathroom, kitchen, gaming room, stairway, etc.).
 */
export const CHRISTMAS_FALLBACK_ACCENTS =
  "a small wreath, subtle warm white string lights as an accent, a small sprig of greenery with red berries, a seasonal accent in cranberry or evergreen tones";
