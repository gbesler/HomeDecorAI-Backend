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

type Subject = "interior" | "exterior" | "garden" | "facade";

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
        "while preserving the exact wall positions, window count, window shapes, " +
        "ceiling height, door placements, floor plan, camera angle, lens perspective, " +
        "and vanishing points. Maintain identical room geometry. " +
        "Do not add or remove walls, windows, or doors."
      );

    case "exterior":
      return (
        "while preserving the exact building massing, roof line, window count, " +
        "window placements, door placements, and camera angle. " +
        "Maintain identical structural geometry."
      );

    case "garden":
      return (
        "while preserving the exact hardscape layout, paths, boundaries, " +
        "existing mature trees, and camera angle. Maintain the identical " +
        "plot shape and proportions."
      );

    case "facade":
      return (
        "while preserving the exact facade geometry, window and door positions, " +
        "architectural details, and camera angle. Maintain identical building proportions."
      );
  }
}
