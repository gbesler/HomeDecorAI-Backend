/**
 * Convert a camelCase iOS room id (e.g. "livingRoom", "homeOffice") into a
 * lowercase human phrase suitable for inlining into prompt action
 * directives (e.g. "living room", "home office").
 *
 * Shared by the interior-design and virtual-staging builders. New tools
 * that take a roomType id should import this rather than re-implementing
 * the case table.
 */

const SPECIAL_CASES: Record<string, string> = {
  livingRoom: "living room",
  diningRoom: "dining room",
  gamingRoom: "gaming room",
  studyRoom: "study room",
  homeOffice: "home office",
  underStairSpace: "under-stair space",
};

export function humanizeRoomType(camelCase: string): string {
  if (SPECIAL_CASES[camelCase]) return SPECIAL_CASES[camelCase];
  return camelCase
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim();
}
