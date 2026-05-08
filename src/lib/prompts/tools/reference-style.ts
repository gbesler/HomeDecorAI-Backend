/**
 * Reference-style prompt builder.
 *
 * Unlike interior/exterior/garden, this tool has no dictionaries — the style
 * is carried entirely by the reference image. The prompt's job is to direct
 * the model to:
 *   1. Restyle the user's room photo to match the reference photo's aesthetic
 *   2. Preserve the room photo's geometry (walls, windows, layout)
 *   3. Adopt the reference photo's palette, materials, lighting, and mood
 *
 * Producers: primary is Replicate `google/nano-banana` (`image_input`
 * array, slot 0 = target room, slot 1 = style reference); fallback is fal
 * `fal-ai/flux-2/edit` (`image_urls` array, same [target, ref] ordering,
 * up to 4 entries supported by the model). The prompt phrasing
 * ("first photo", "second photo") matches this slot ordering — adapter
 * and prompt agree on which image carries which role.
 *
 * Model history: v1 shipped on `prunaai/p-image-edit` (primary) +
 * `fal-ai/flux-2/klein/9b/edit` (fallback). Pruna produced near-identity
 * output — a distilled sub-second edit model is not trained for cross-image
 * style transfer. An intermediate iteration moved primary to
 * `fal-ai/flux-pro/kontext/max/multi`; that model was retired in favor of
 * Nano Banana (cheaper, semantic cross-image reasoning), with Flux 2 Edit
 * replacing it on the fallback side (~9× cost reduction vs Kontext Max
 * Multi). Do not re-introduce Pruna here as primary; the failure mode is
 * documented.
 *
 * v2.1 — phrasing and layer changes after observing a near-identity failure
 * mode in production where the output came back essentially unchanged from
 * the room photo:
 *
 * 1. Indexed labels ("image 1 / image 2") were unreliable on Nano Banana.
 *    Gemini 2.5 Flash Image binds image references via content cues more
 *    reliably than ordinal indices in prompt text. v2.1 uses ordinal +
 *    descriptive phrasing ("the room shown in the first photo", "the
 *    aesthetic of the second photo") so the model has a content handle in
 *    addition to position.
 *
 * 2. The shared `positive-avoidance` primitive injects "natural color
 *    balance" and "natural daylight direction consistent with input" — both
 *    phrases that actively counter cross-image style transfer. They are
 *    correct anchors for single-image tools (interior/exterior/garden)
 *    where "input" unambiguously means "the room" and the goal is to keep
 *    the room's lighting truthful, but here they pull the model back toward
 *    the room photo's palette and lighting and undo the transfer. Dropped
 *    for this tool only; primitives are unchanged so the other tools that
 *    rely on them still get the correct anchors.
 *
 * 3. The shared `photography-quality` primitive prescribes "soft indirect
 *    daylight" for interior. That contradicts adopting the reference's
 *    lighting mood (which may be dramatic, warm, evening, etc.). Replaced
 *    with a lighting-neutral quality clause for this tool.
 *
 * 4. Transfer directive is bookended (start AND end of prompt) to outweigh
 *    the structural-preservation layer in between. Earlier composition had
 *    3 of 5 layers reinforce preservation, biasing the model toward
 *    near-identity output.
 *
 * Phrasing rule: Flux-2 and Kontext models are not trained to interpret
 * negative instructions ("do not", "avoid", "without") — those bias the
 * model toward the negated content. Every directive in this builder is
 * positively framed.
 */

import {
  KLEIN_GUIDANCE_BANDS,
  PROVIDER_CAPABILITIES,
} from "../../ai-providers/capabilities.js";
import { logger } from "../../logger.js";
import { buildStructuralPreservation } from "../primitives/structural-preservation.js";
import { trimLayersToBudget, type PromptLayer } from "../token-budget.js";
import type { z } from "zod";
import type { PromptResult } from "../types.js";
import type { CreateReferenceStyleBody } from "../../../schemas/generated/api.js";

const PROMPT_VERSION = "referenceStyle/v2.1";

const PRIMARY_MODEL = "google/nano-banana";
const PRIMARY_MAX_TOKENS =
  PROVIDER_CAPABILITIES[PRIMARY_MODEL]?.maxPromptTokens ?? 512;

/**
 * The full validated body shape — declared as the single source of truth for
 * `TParams` so the registry's type contract matches what `fromToolParams`
 * actually returns at runtime. The prompt builder destructures only
 * `spaceType`, but downstream code (processor, tests) sees the full shape.
 */
export type ReferenceStyleParams = z.infer<typeof CreateReferenceStyleBody>;

export function buildReferenceStylePrompt(
  params: ReferenceStyleParams,
): PromptResult {
  const { spaceType } = params;

  const subjectNoun = spaceType === "interior" ? "room" : "building";
  const targetPhrase = `the ${subjectNoun} shown in the first photo`;

  // Opening directive: ordinal + descriptive content references. "First
  // photo" and "second photo" anchor positionally, while "the room" / "the
  // aesthetic" give the model a semantic handle Gemini can match against
  // image content even if positional binding wavers.
  const openingDirective =
    `Restyle ${targetPhrase} so that its full visual aesthetic — color palette, materials, ` +
    `surface finishes, and lighting mood — comes from the second photo. The second photo is a style ` +
    `reference: take its palette, materials, and atmosphere and apply them to ${targetPhrase}. ` +
    `Produce a photograph of the same ${subjectNoun}, redecorated and relit in the second photo's style.`;

  // Focus directive: enumerate exactly which surfaces carry the transfer and
  // which elements stay locked. Action and focus must agree on what
  // transfers vs what is preserved — earlier wording said "adopt textures"
  // in one place but "preserve furniture shapes" in another, which the
  // model received as contradictory instructions.
  const focusDirective =
    spaceType === "interior"
      ? `Replace the first photo's wall finishes, flooring materials, textile colors, lighting fixtures, ` +
        `and accent decor with counterparts drawn from the second photo's visual language. Keep the first ` +
        `photo's furniture shapes and placement; reskin their upholstery, wood tones, and metals to ` +
        `match the second photo.`
      : `Replace the first photo's facade materials, cladding treatment, trim colors, window frame ` +
        `finishes, and roofing character with counterparts drawn from the second photo. Keep the first ` +
        `photo's building silhouette, opening positions, and hardscape layout; reskin only the surfaces.`;

  // Lighting-neutral quality clause. The shared photography-quality
  // primitive hardcodes "soft indirect daylight" for interior, which
  // contradicts adopting the reference's lighting mood. We retain the
  // editorial-photography framing and the camera tokens but drop the
  // lighting prescription — lighting is supplied by the reference.
  const qualityClause =
    spaceType === "interior"
      ? `Shot as professional editorial architectural interior photography, 35mm lens at f/4, ` +
        `balanced composition, realistic materials, subtle reflections on polished surfaces.`
      : `Shot as professional architectural exterior photography, 24mm lens at f/8, ` +
        `balanced composition, realistic materials.`;

  // Closing directive: re-state the transfer. Bookending pushes back against
  // the structural-preservation layer in the middle, which would otherwise
  // bias the model toward near-identity output.
  const closingDirective =
    `The output must read as the second photo's aesthetic applied to ${targetPhrase}. ` +
    `Geometry from the first photo, style from the second photo.`;

  // Priority ordering note: `trimLayersToBudget` drops from the tail (highest
  // priority number) first when over budget. The bookended transfer
  // (opening + closing) is the v2.1 fix's load-bearing structure — without
  // closing-transfer, the structural-preservation layer is no longer
  // counter-weighted and the near-identity failure mode returns. So
  // `photography-quality` is tail-most (priority 5) and is sacrificed
  // first; `closing-transfer` sits at priority 4 and survives until only
  // opening + focus + structural would remain. Today the composed prompt
  // is well under budget (~250 tokens vs 512 cap), but if a future
  // expansion pushes over, we want the cosmetic clause dropped — not the
  // bookend.
  const layers: PromptLayer[] = [
    { name: "opening-transfer", priority: 1, text: openingDirective },
    { name: "focus", priority: 2, text: focusDirective },
    {
      name: "structural-preservation",
      priority: 3,
      text: buildStructuralPreservation(spaceType),
    },
    { name: "closing-transfer", priority: 4, text: closingDirective },
    { name: "photography-quality", priority: 5, text: qualityClause },
  ];

  const trimResult = trimLayersToBudget(layers, PRIMARY_MAX_TOKENS);

  if (trimResult.droppedLayers.length > 0) {
    logger.warn(
      {
        event: "prompt.token_truncation",
        tool: "referenceStyle",
        spaceType,
        droppedLayers: trimResult.droppedLayers,
        finalTokens: trimResult.finalTokens,
        budget: PRIMARY_MAX_TOKENS,
        overBudget: trimResult.overBudget,
      },
      `Reference-style prompt trimmed to fit token budget (${trimResult.droppedLayers.length} layer(s) dropped)`,
    );
  }

  return {
    prompt: trimResult.composed,
    // `positiveAvoidance` is a required string on PromptResult (see
    // types.ts) used for telemetry — typically a mirror of the R7
    // avoidance tail composed into `prompt`. For this tool we deliberately
    // emit no avoidance clause: the shared primitive's "natural color
    // balance" and "daylight consistent with input" tokens directly
    // counter cross-image style transfer. The empty string is the
    // intentional sentinel meaning "this builder opted out of R7" and
    // matches the convention already used by `legacy.ts`,
    // `clean-organize.ts`, `remove-objects.ts`, and `replace-add-object.ts`.
    positiveAvoidance: "",
    // `balanced` (3.0) gives style transfer enough headroom to diverge from
    // the room's surface appearance while the structural-preservation layer
    // handles geometry. The primary (Nano Banana) advertises
    // supportsGuidanceScale=false and the replicate adapter drops this
    // field for Gemini; the value is still forwarded so the
    // fal-ai/flux-2/edit fallback — which does expose guidance_scale —
    // receives a calibrated setting.
    guidanceScale: KLEIN_GUIDANCE_BANDS.balanced,
    actionMode: "transform",
    guidanceBand: "balanced",
    promptVersion: PROMPT_VERSION,
  };
}
