/**
 * Virtual Staging mode enum — matches iOS StagingColorMode.
 *
 * - `keepLayout`: preserve any existing furniture and add complementary pieces
 * - `fullStaging`: stage the room as if empty with new furniture
 */
export const StagingMode = {
  keepLayout: "keepLayout",
  fullStaging: "fullStaging",
} as const;

export type StagingMode = (typeof StagingMode)[keyof typeof StagingMode];
