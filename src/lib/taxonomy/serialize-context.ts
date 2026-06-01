import {
  TAXONOMY_REGISTRY,
  getAxes,
  type TaxonomyAxis,
} from "./registry.js";

/**
 * Serializes the taxonomy registry into an "allowed-values context" artifact
 * for a seed generator (or an LLM prompt). This is the Phase-1 deliverable of
 * the hybrid generator approach: the system's closed sets are emitted in a
 * machine-readable (JSON) and human/LLM-readable (Markdown) form, so a
 * generation step can be instructed to pick ONLY from these values.
 *
 * Object categories are not derivable from a static enum (they live in
 * Firestore / the full manifest), so the caller supplies them — keeping this
 * function pure and env-free (and therefore unit-testable without Firebase).
 */

const INSTRUCTION =
  "Choose values ONLY from the allowed sets below. Never invent a value that " +
  "is not present in these lists. Object inspirations have no material/style/" +
  "object-type taxonomy — do not invent those fields.";

/** Axes that belong to the Explore / design surface (everything except the
 *  object-specific `objectToolType`, which is reported under `objectInspiration`). */
function exploreAxisKeys(): TaxonomyAxis[] {
  return getAxes().filter((axis): axis is TaxonomyAxis => axis !== "objectToolType");
}

export interface TaxonomyContextInput {
  /** Existing object category ids — the closed reference set for objects. */
  readonly objectCategoryIds: readonly string[];
}

export interface TaxonomyContextAxis {
  readonly axis: string;
  readonly label: string;
  readonly source: string;
  readonly values: readonly string[];
}

export interface TaxonomyContextJson {
  readonly purpose: "inspiration-seed-generator-allowed-values";
  readonly instruction: string;
  readonly exploreAxes: readonly TaxonomyContextAxis[];
  readonly objectInspiration: {
    readonly toolTypes: readonly string[];
    readonly categories: readonly string[];
    readonly note: string;
  };
}

/** Build the structured context object (pure data, no formatting). */
export function buildTaxonomyContext(
  input: TaxonomyContextInput,
): TaxonomyContextJson {
  const exploreAxes: TaxonomyContextAxis[] = exploreAxisKeys().map((axis) => {
    const def = TAXONOMY_REGISTRY[axis];
    return {
      axis: def.axis,
      label: def.label,
      source: def.source,
      values: def.values,
    };
  });

  return {
    purpose: "inspiration-seed-generator-allowed-values",
    instruction: INSTRUCTION,
    exploreAxes,
    objectInspiration: {
      toolTypes: TAXONOMY_REGISTRY.objectToolType.values,
      categories: [...input.objectCategoryIds],
      note:
        "Objects are constrained to these toolTypes (closed enum) and the " +
        "existing categories above. There is no material/style/object-type " +
        "enum — do not generate those fields.",
    },
  };
}

/** Pretty-printed JSON form. */
export function serializeTaxonomyContextJson(ctx: TaxonomyContextJson): string {
  return JSON.stringify(ctx, null, 2);
}

/** Markdown form, suitable for pasting into an LLM prompt. */
export function serializeTaxonomyContextMarkdown(
  ctx: TaxonomyContextJson,
): string {
  const lines: string[] = [];
  lines.push("# Allowed taxonomy values — inspiration seed generation");
  lines.push("");
  lines.push(`> ${ctx.instruction}`);
  lines.push("");
  lines.push("## Explore inspiration axes");
  lines.push("");
  for (const axis of ctx.exploreAxes) {
    lines.push(`### ${axis.label} (\`${axis.axis}\`)`);
    lines.push(`Source: \`${axis.source}\``);
    lines.push("");
    for (const value of axis.values) {
      lines.push(`- \`${value}\``);
    }
    lines.push("");
  }
  lines.push("## Object inspiration");
  lines.push("");
  lines.push("Tool types (closed enum):");
  for (const t of ctx.objectInspiration.toolTypes) {
    lines.push(`- \`${t}\``);
  }
  lines.push("");
  lines.push(
    `Categories (${ctx.objectInspiration.categories.length} existing — pick only from these):`,
  );
  if (ctx.objectInspiration.categories.length === 0) {
    lines.push("- _(none provided)_");
  } else {
    for (const c of ctx.objectInspiration.categories) {
      lines.push(`- \`${c}\``);
    }
  }
  lines.push("");
  lines.push(`> ${ctx.objectInspiration.note}`);
  lines.push("");
  return lines.join("\n");
}

/** Convenience: build + serialize to both forms in one call. */
export function serializeTaxonomyContext(input: TaxonomyContextInput): {
  data: TaxonomyContextJson;
  json: string;
  markdown: string;
} {
  const data = buildTaxonomyContext(input);
  return {
    data,
    json: serializeTaxonomyContextJson(data),
    markdown: serializeTaxonomyContextMarkdown(data),
  };
}
