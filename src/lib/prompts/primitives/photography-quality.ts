/**
 * Photography quality primitive — R5.
 *
 * Tool-agnostic: accepts a `subject` parameter. Uses BFL-documented camera
 * tokens (lens + aperture) and the community-validated editorial anchor.
 *
 * @see https://docs.bfl.ml/guides/prompting_guide_flux2
 */

type Subject = "interior" | "exterior" | "garden" | "facade";

/**
 * Produce the photography quality clause for a given subject.
 *
 * Example output (interior):
 * "Shot as professional editorial architectural interior photography,
 *  35mm lens at f/4, soft indirect daylight, balanced composition,
 *  realistic materials, subtle reflections on polished surfaces."
 */
export function buildPhotographyQuality(subject: Subject): string {
  switch (subject) {
    case "interior":
      // v2 phrasing — input-anchored. The earlier "35mm lens at f/4" literal
      // was a positive lens directive on an image-to-image edit, which
      // competed with the source photograph's actual focal length and was a
      // primary contributor to camera-angle drift. The new phrasing tells the
      // model to match the source image's framing rather than enforcing a
      // fixed lens, while keeping the editorial-photography quality anchor.
      return (
        "Match the source image's framing, lens, focal length, field of view, " +
        "and exposure. Shot as professional editorial architectural interior " +
        "photography with realistic materials and subtle reflections on " +
        "polished surfaces."
      );

    case "exterior":
      return (
        "Shot as professional architectural exterior photography, " +
        "24mm lens at f/8, golden hour natural light, balanced composition, " +
        "realistic materials."
      );

    case "garden":
      return (
        "Shot as professional landscape photography, 35mm lens at f/5.6, " +
        "soft natural daylight, balanced composition, realistic foliage textures."
      );

    case "facade":
      return (
        "Shot as professional architectural photography, 24mm lens at f/8, " +
        "even natural light, straight-on perspective, realistic materials."
      );
  }
}
