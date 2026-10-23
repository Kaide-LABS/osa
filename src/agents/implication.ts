// Implication agent (WS6.1). After the spec and before the build it asks: "if we build exactly this, what
// follows?" -- second-order consequences across data, security, performance, maintenance, cost and user
// impact -- and turns the MATERIAL ones into either acceptance criteria or explicit out-of-scope lines in the
// SPEC. It never touches the locked PRD. Applying its output is deterministic (no second model call).

import { NO_QUESTIONS } from "../osa/prompt-rules.ts";
import { z } from "zod";
import type { ProviderId } from "../domain/run.ts";
import type { TextCall } from "../ports/text-provider.ts";
import type { EventSink } from "../osa/events.ts";
import { extractJsonObject } from "../osa/intake.ts";

export const IMPLICATION_AREAS = ["data", "security", "performance", "maintenance", "cost", "user-impact"] as const;
export const IMPLICATION_ACTIONS = ["acceptance-criterion", "out-of-scope", "note"] as const;

const ConsequenceSchema = z.strictObject({
  area: z.enum(IMPLICATION_AREAS),
  consequence: z.string().trim().min(1).max(500),
  material: z.boolean(),
  action: z.enum(IMPLICATION_ACTIONS),
  /** The acceptance criterion (a falsifiable yes/no statement) or the out-of-scope line, or the note. */
  text: z.string().trim().min(1).max(500),
});

/** The agent's validated output. A material consequence MUST become a criterion or an out-of-scope line. */
export const ImplicationReportSchema = z
  .strictObject({ consequences: z.array(ConsequenceSchema).max(30) })
  .refine((r) => r.consequences.every((c) => !c.material || c.action !== "note"), {
    message: 'a material consequence must have action "acceptance-criterion" or "out-of-scope", never "note"',
    path: ["consequences"],
  });
export type ImplicationReport = z.infer<typeof ImplicationReportSchema>;
export type Consequence = z.infer<typeof ConsequenceSchema>;

/** Inputs of {@link runImplicationAgent}. */
export interface ImplicationInput {
  readonly prdMarkdown: string;
  readonly contextMarkdown: string;
  readonly specMarkdown: string;
  readonly provider: ProviderId;
  readonly textCall: TextCall;
  readonly events: EventSink;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly modelOverride?: string | null;
}

/** The result: the (possibly extended) spec text and what was added. `failure` is set when the agent could not run. */
export interface ImplicationResult {
  readonly ok: boolean;
  readonly specMarkdown: string;
  readonly consequences: readonly Consequence[];
  readonly acceptanceAdded: number;
  readonly outOfScopeAdded: number;
  readonly failure: string | null;
}

/** Builds the prompt. Pure. */
export function buildImplicationPrompt(i: Pick<ImplicationInput, "prdMarkdown" | "contextMarkdown" | "specMarkdown">, retryNote: string | null = null): string {
  const lines = [
    NO_QUESTIONS,
    "You are the implication reviewer for OSA (One-Shot Anything). The spec below will be built EXACTLY as written by coding agents,",
    "with nobody to ask. Think one step beyond it: if this is built as specified, what follows?",
    "",
    `Consider each area: ${IMPLICATION_AREAS.join(", ")}.`,
    "For each real consequence decide whether it is MATERIAL (it would hurt a user, leak or lose data, break at realistic scale,",
    "cost real money, or make the project hard to maintain if left unaddressed).",
    "- A material consequence MUST be turned into either an ACCEPTANCE CRITERION (a falsifiable yes/no statement a tester can check by",
    '  running the project) or an explicit OUT-OF-SCOPE line (something deliberately not handled, so nobody assumes it is). Use action "acceptance-criterion" or "out-of-scope".',
    '- A non-material consequence may be recorded with action "note".',
    "- Do not restate the existing acceptance criteria. Do not propose new features. Do not contradict the locked PRD: you may only ADD constraints to the spec.",
    "- Fewer, sharper items beat a long list. Zero consequences is allowed if the spec is genuinely tight.",
    "",
    "Reply with ONE JSON object and nothing else:",
    '{ "consequences": [ { "area": "data|security|performance|maintenance|cost|user-impact", "consequence": "what follows", "material": true, "action": "acceptance-criterion|out-of-scope|note", "text": "the criterion / out-of-scope line / note" } ] }',
    "",
    "=== LOCKED BABY PRD ===",
    i.prdMarkdown.trim(),
    "",
    "=== CONTEXT ===",
    i.contextMarkdown.trim(),
    "",
    "=== PHASE 1 SPEC ===",
    i.specMarkdown.trim(),
  ];
  if (retryNote !== null) lines.push("", "=== YOUR PREVIOUS REPLY WAS REJECTED ===", retryNote, "Reply again with the corrected JSON object only.");
  return lines.join("\n");
}

/**
 * Appends the "Implications" section to the spec. Added acceptance criteria are numbered S1, S2, ... so they cannot be
 * confused with the PRD's own numbered criteria (the application agent checks both sets). Pure.
 */
export function applyImplications(specMd: string, consequences: readonly Consequence[]): { specMd: string; acceptanceAdded: number; outOfScopeAdded: number } {
  const criteria = consequences.filter((c) => c.action === "acceptance-criterion");
  const outOfScope = consequences.filter((c) => c.action === "out-of-scope");
  const notes = consequences.filter((c) => c.action === "note");
  if (consequences.length === 0) return { specMd, acceptanceAdded: 0, outOfScopeAdded: 0 };
  const L = ["## Implications", "", "Second-order consequences found by an independent review of this spec. This section only adds to the spec; the locked PRD is unchanged.", ""];
  if (criteria.length > 0) L.push("### Additional acceptance criteria", "", ...criteria.map((c, i) => `S${String(i + 1)}. ${c.text} _(${c.area}: ${c.consequence})_`), "");
  if (outOfScope.length > 0) L.push("### Explicitly out of scope", "", ...outOfScope.map((c) => `- ${c.text} _(${c.area})_`), "");
  if (notes.length > 0) L.push("### Noted, no action", "", ...notes.map((c) => `- ${c.text} _(${c.area})_`), "");
  return { specMd: `${specMd.trimEnd()}\n\n${L.join("\n").trimEnd()}\n`, acceptanceAdded: criteria.length, outOfScopeAdded: outOfScope.length };
}

/** Runs the agent (one retry on invalid output). Never throws for a model/provider problem: returns `ok: false` and logs. */
export async function runImplicationAgent(i: ImplicationInput): Promise<ImplicationResult> {
  let note: string | null = null;
  let last = "no attempt was made";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const call = await i.textCall(
      i.provider,
      { prompt: buildImplicationPrompt(i, note), cwd: i.cwd, timeoutMs: i.timeoutMs, tier: "verification-grade", webSearch: false, modelOverride: i.modelOverride ?? null },
      "implication",
    );
    if (!call.outcome.ok || call.outcome.text === null) {
      last = call.outcome.failure?.message ?? "the provider returned no text";
      note = null;
      continue;
    }
    try {
      const report = ImplicationReportSchema.parse(extractJsonObject(call.outcome.text));
      const applied = applyImplications(i.specMarkdown, report.consequences);
      await i.events.emit("implication_done", {
        provider: i.provider,
        consequences: report.consequences.length,
        material: report.consequences.filter((c) => c.material).length,
        acceptanceAdded: applied.acceptanceAdded,
        outOfScopeAdded: applied.outOfScopeAdded,
      });
      return { ok: true, specMarkdown: applied.specMd, consequences: report.consequences, acceptanceAdded: applied.acceptanceAdded, outOfScopeAdded: applied.outOfScopeAdded, failure: null };
    } catch (err) {
      last = err instanceof z.ZodError ? z.prettifyError(err) : err instanceof Error ? err.message : String(err);
      note = last;
    }
  }
  await i.events.emit("implication_done", { provider: i.provider, failed: true, reason: last });
  return { ok: false, specMarkdown: i.specMarkdown, consequences: [], acceptanceAdded: 0, outOfScopeAdded: 0, failure: last };
}

