/**
 * Structural preservation primitive — R4.
 *
 * Tool-agnostic: accepts a `subject` parameter so future tools (exterior,
 * garden, facade) can reuse the same clause with different vocabulary.
 *
 * Phrasing follows the BFL Kontext I2I prompting guide canonical pattern:
 * "[change instruction] while [preservation instruction]".
 *
 * @see https://docs.bfl.ml/guides/prompting_guide_kontext_i2i
 */

type Subject =
  | "interior"
  | "exterior"
  | "garden"
  | "facade"
  | "pool"
  | "patio";

/**
 * Produce the structural preservation clause for a given subject.
 *
 * Example output (interior):
 * "while preserving the exact wall positions, window count, ceiling height,
 *  door placements, floor plan, camera angle, lens perspective, and vanishing
 *  points. Maintain identical room geometry."
 */
export function buildStructuralPreservation(subject: Subject): string {
  switch (subject) {
    case "interior":
      return (
        "Maintain identical wall positions, window count, window shapes, " +
        "ceiling height, door placements, floor plan, camera angle, lens perspective, " +
        "and vanishing points. Keep the room geometry exactly as it is."
      );

    case "exterior":
      return (
        "Maintain identical building massing, roof line, window count, " +
        "window placements, door placements, and camera angle. " +
        "Keep the structural geometry exactly as it is."
      );

    case "garden":
      return (
        "Maintain identical hardscape layout, paths, boundaries, " +
        "existing mature trees, and camera angle. Keep the " +
        "plot shape and proportions exactly as they are."
      );

    case "facade":
      return (
        "Maintain identical facade geometry, window and door positions, " +
        "architectural details, and camera angle. Keep the building proportions exactly as they are."
      );

    case "pool":
      return (
        "Maintain identical pool shape, pool edges, coping line, waterline level, " +
        "pool depth proportions, surround footprint, and camera angle. " +
        "Keep the pool geometry and its position in the frame exactly as they are."
      );

    case "patio":
      return (
        "Maintain identical plot footprint, surrounding wall and railing positions, " +
        "adjoining building edges, and camera angle. " +
        "Keep the patio's shape and proportions exactly as they are."
      );
  }
}
