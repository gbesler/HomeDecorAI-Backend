/**
 * Token budget heuristic + layer trimming helper — R29.
 *
 * Used by the builder to stay under the provider's maxPromptTokens when
 * composing the 7-layer prompt. If the composition overflows, layers are
 * dropped from the tail (lowest priority) until the total fits.
 *
 * Accuracy note: `countTokensApprox` uses a simple `words × 1.33` heuristic
 * that is conservative for English. If provider truncation ever surprises us
 * in production, swap to a real T5 tokenizer (tiktoken with custom encoding
 * or a local SentencePiece load). The heuristic is documented in the plan
 * Open Questions → Deferred to Implementation.
 */

// ─── Token counting ────────────────────────────────────────────────────────

/**
 * Approximate token count for English text.
 *
 * T5 SentencePiece averages ~1.3 tokens per English word; we round up to 1.33
 * and take the ceiling for a conservative (over-counting) estimate.
 */
export function countTokensApprox(text: string): number {
  if (text.length === 0) return 0;
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  return Math.ceil(words.length * 1.33);
}

// ─── Layer trimming ────────────────────────────────────────────────────────

/**
 * A labeled chunk of prompt text that can be dropped as a unit.
 * Priority 1 = highest (head, must survive); larger numbers = tail.
 */
export interface PromptLayer {
  name: string;
  priority: number;
  text: string;
}

export interface TrimResult {
  composed: string;
  droppedLayers: string[];
  finalTokens: number;
  overBudget: boolean;
}

/**
 * Compose layers in priority order (head first) and drop from the tail
 * until the total token count fits the budget.
 *
 * Semantics:
 * - Layers are concatenated in ascending priority order with a single
 *   space between each layer's text.
 * - If the combined text exceeds `maxTokens`, the highest-priority-number
 *   (tail) layer is dropped and recounted, repeating until fit OR only the
 *   head layer remains.
 * - If the head layer alone still exceeds budget, returns the head layer
 *   with `overBudget: true` so the caller can log and decide whether to
 *   proceed. Never returns an empty string.
 */
export function trimLayersToBudget(
  layers: readonly PromptLayer[],
  maxTokens: number,
): TrimResult {
  if (layers.length === 0) {
    return { composed: "", droppedLayers: [], finalTokens: 0, overBudget: false };
  }

  // Sort a copy in ascending priority order (head first).
  const sorted = [...layers].sort((a, b) => a.priority - b.priority);
  const active = sorted.map((layer) => ({ ...layer, dropped: false }));

  function compose(): string {
    return active
      .filter((l) => !l.dropped)
      .map((l) => l.text)
      .join(" ");
  }

  let composed = compose();
  let tokens = countTokensApprox(composed);

  while (tokens > maxTokens) {
    // Find the highest-priority-number (tail-most) still-active layer.
    let tailIndex = -1;
    for (let i = active.length - 1; i >= 0; i--) {
      if (!active[i]!.dropped) {
        tailIndex = i;
        break;
      }
    }
    if (tailIndex <= 0) {
      // Only the head layer (index 0) remains active. Cannot trim further.
      break;
    }
    active[tailIndex]!.dropped = true;
    composed = compose();
    tokens = countTokensApprox(composed);
  }

  const droppedLayers = active
    .filter((l) => l.dropped)
    .map((l) => l.name);

  return {
    composed,
    droppedLayers,
    finalTokens: tokens,
    overBudget: tokens > maxTokens,
  };
}
