// Deterministic TL;DR assembler for the post-spec approval gate. Builds a human-readable approval
// summary from existing artifacts without any model call. Stop-and-report if the TL;DR cannot be
// assembled from what the pipeline has available.

import type { Assumption, BabyPrd } from "../domain/intake.ts";

/** Input for the deterministic approval TL;DR assembler. */
export interface TldrInput {
  readonly prd: BabyPrd;
  readonly specAssumptions: readonly string[];
  readonly totalPhases: number;
  readonly risky: readonly Assumption[];
  readonly defaulted: readonly Assumption[];
  readonly researchSkipped: boolean;
  readonly flaggedClaims: readonly string[];
  readonly reviewText: string;
}

/** Successful TL;DR or a stop-and-report message. */
export type TldrResult = { readonly lines: readonly string[] } | { readonly stop: string };

/**
 * Assembles a deterministic approval TL;DR from existing artifacts. Returns either a set of lines
 * ready to show to the person before approval, or a plain-language reason to stop instead (the
 * pipeline converts that into a STAGE_FAILED exit with no model call).
 *
 * Pure function: same input → same output.
 */
export function buildApprovalTldr(input: TldrInput): TldrResult {
  // Validate the inputs we need.
  if (input.prd.tldr.length === 0 || input.prd.tldr[0]?.trim() === "") {
    return { stop: "Cannot assemble the approval TL;DR: the PRD has no goal text." };
  }
  if (input.prd.scope === undefined || (input.prd.scope !== "narrow" && input.prd.scope !== "broad")) {
    return { stop: "Cannot assemble the approval TL;DR: the PRD has no valid scope." };
  }

  const lines: string[] = [];

  // Header: show the goal.
  lines.push("## Ready to build?");
  lines.push("");
  lines.push("**What you're asking for:**");
  lines.push(input.prd.tldr[0]!);
  lines.push("");

  // Build plan.
  lines.push(`**Plan:** ${String(input.totalPhases)} build phase(s)`);
  lines.push("");

  // Assumptions summary: risky, defaulted, and flagged research items.
  const assumptionLines: string[] = [];
  if (input.risky.length > 0) {
    assumptionLines.push(`**Risky assumptions (${String(input.risky.length)}):**`);
    for (const a of input.risky) {
      assumptionLines.push(`  - ${a.text}`);
    }
  }
  if (input.defaulted.length > 0) {
    if (assumptionLines.length > 0) assumptionLines.push("");
    assumptionLines.push(`**Assumed defaults (${String(input.defaulted.length)}):**`);
    for (const a of input.defaulted) {
      assumptionLines.push(`  - ${a.text}`);
    }
  }
  if (input.flaggedClaims.length > 0) {
    if (assumptionLines.length > 0) assumptionLines.push("");
    assumptionLines.push("**Research could not fully confirm:**");
    for (const claim of input.flaggedClaims) {
      assumptionLines.push(`  - ${claim}`);
    }
  }
  if (input.researchSkipped) {
    if (assumptionLines.length > 0) assumptionLines.push("");
    assumptionLines.push("**Research:** skipped (disabled in the configuration)");
  }

  if (assumptionLines.length > 0) {
    lines.push(...assumptionLines);
    lines.push("");
  }

  // Spec decisions, with a note if any lack a risk tag.
  if (input.specAssumptions.length > 0) {
    const untaggedCount = input.specAssumptions.filter((d) => !d.includes("[") && !d.includes("]")).length;
    lines.push(`**Decisions:** ${String(input.specAssumptions.length)} decision(s) logged during spec writing${untaggedCount > 0 ? ` (${String(untaggedCount)} without an explicit risk tag)` : ""}`);
    lines.push("");
  }

  // Review independence.
  lines.push(`**Review:** ${input.reviewText}`);

  return { lines };
}
