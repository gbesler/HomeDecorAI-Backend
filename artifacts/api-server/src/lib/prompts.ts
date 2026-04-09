import type { RoomType, DesignStyle } from "@workspace/api-zod";

/**
 * Convert camelCase enum values to human-readable strings.
 * e.g. "livingRoom" -> "living room", "artDeco" -> "art deco", "midCentury" -> "mid-century"
 */
function humanize(camelCase: RoomType | DesignStyle): string {
  const specialCases: Partial<Record<RoomType | DesignStyle, string>> = {
    midCentury: "mid-century modern",
    artDeco: "art deco",
    homeOffice: "home office",
    underStairSpace: "under-stair space",
    studyRoom: "study room",
    gamingRoom: "gaming room",
    diningRoom: "dining room",
  };

  if (specialCases[camelCase]) {
    return specialCases[camelCase];
  }

  return camelCase
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim();
}

export function buildInteriorDesignPrompt(
  roomType: RoomType,
  designStyle: DesignStyle,
): string {
  const room = humanize(roomType);
  const style = humanize(designStyle);

  return (
    `Redesign this ${room} in a ${style} style. ` +
    `Keep the room's structural elements (walls, windows, doors) intact. ` +
    `Replace all furniture, decor, and accessories with items that match the ${style} aesthetic. ` +
    `Maintain the room's dimensions and layout while completely transforming the interior design. ` +
    `Photorealistic, high quality interior design photograph.`
  );
}
