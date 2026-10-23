// One-shot intake (OSA_DIRECTIVE.md WS2.1): a single prompt in, a tagged TL;DR + baby PRD out. Never asks
// the operator anything -- missing information is *inferred* and recorded as a tagged assumption. The
// model call goes through the injected {@link TextCall}, so tests run with a fake and production uses the
// providers' own CLIs (BYOA, no API key handled here).

import { neutralizeInstructions, wrapUntrusted } from "./untrusted.ts";
import { z } from "zod";
import { IntakeError } from "../domain/errors.ts";
import { BabyPrdSchema, REQUEST_MAX_CHARS, RESEARCH_MODULES } from "../domain/intake.ts";
import type { BabyPrd } from "../domain/intake.ts";
import type { ProviderId } from "../domain/run.ts";
import type { TextCall } from "../ports/text-provider.ts";
import { applyRiskBackstop } from "./baby-prd.ts";
import type { EventSink } from "./events.ts";

/** A file the operator handed to intake (`--file`). */
export interface IntakeFile {
  readonly path: string;
  readonly content: string;
}

/** What intake works from. */
export interface IntakeInput {
  readonly prompt: string;
  readonly files: readonly IntakeFile[];
  /** Project memory block (WS8), or `null`. */
  readonly memory: string | null;
  /** Cap on research items (`research.maxItems`). */
  readonly maxItems: number;
  /** `intake.quoteStatedRules` (default false): ask for, verify and append the person's stated rules as acceptance criteria. */
  readonly quoteStatedRules?: boolean;
}

/** Collaborators of {@link runIntake}. */
export interface IntakeDeps {
  readonly textCall: TextCall;
  readonly provider: ProviderId;
  /** The model for the call; `null`/absent = the provider's default. */
  readonly model?: string | null;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly events: EventSink;
}

/** Hard cap on one file's inlined content, so a huge attachment cannot blow the prompt. */
const MAX_FILE_CHARS = 40_000;

const URL_RE = /\bhttps?:\/\/[^\s)>\]"']+/g;

/** The distinct URLs in `text`, in first-seen order. */
export function extractLinks(text: string): string[] {
  return [...new Set(text.match(URL_RE) ?? [])];
}

const STATED_REQUIREMENTS_LINE = `  "statedRequirements": ["a sentence or clause COPIED WORD FOR WORD from THE PERSON'S PROMPT that states a rule, format, number, name, option, edge case or error behaviour -- never a paraphrase; [] if the prompt states none"],
`;

/** The JSON shape shown to the model; the `statedRequirements` field only when `intake.quoteStatedRules` is on. */
function schemaDescription(quoteStatedRules: boolean): string {
  return SCHEMA_DESCRIPTION.replace(STATED_REQUIREMENTS_LINE, quoteStatedRules ? STATED_REQUIREMENTS_LINE : "");
}

const SCHEMA_DESCRIPTION = `{
  "tldr": ["3 to 5 short plain-language lines: what will be built and how the person will know it works"],
  "problem": "string",
  "users": "string -- who it is for",
  "inScope": ["string"],
  "outOfScope": ["string"],
  "acceptanceCriteria": ["falsifiable, checkable statements; each can be answered yes/no by running or inspecting the result"],
  "constraints": ["stack, deadlines, data rules"],
  "researchPlan": {
    "topic": "string",
    "timeRange": "e.g. last 3 years",
    "items": [{ "slug": "kebab-case", "title": "string", "question": "what must be learned for the build", "modules": [${RESEARCH_MODULES.map((m) => `"${m}"`).join(" | ")}] }],
    "docsTargets": ["every library, framework, API or service named or clearly implied -- NAMES ONLY, no URLs; each gets its official docs read"],
    "academicQueries": ["search strings for papers; [] if academic literature is not relevant"],
    "priorArtQueries": ["search strings for public repositories with reference implementations; [] if none"]
  },
${STATED_REQUIREMENTS_LINE}  "assumptions": [{ "text": "string", "risk": "safe | risky" }]
}`;

/** Builds the intake prompt. Pure. */
export function buildIntakePrompt(input: IntakeInput, retryNote: string | null = null): string {
  const links = extractLinks([input.prompt, ...input.files.map((f) => f.content)].join("\n"));
  const lines: string[] = [
    "You are the intake stage of OSA (One-Shot Anything). A person gave ONE prompt and will not answer follow-up questions.",
    "Turn it into a TL;DR and a baby PRD. Reply with a single JSON object and nothing else (no prose, no code fences).",
    "",
    "Rules:",
    "- NEVER ask a question. Where information is missing, infer a sensible answer and record it as an assumption.",
    "- Whatever the person stated explicitly is a REQUIREMENT, not an assumption: put it in the PRD exactly as stated (scope, rules, edge cases,",
    "  error behaviour, formats) and do NOT list it as an assumption. Never write an assumption that contradicts or narrows what they stated;",
    input.quoteStatedRules === true
      ? "  an assumption is only for what they left out. Copy each such stated rule, word for word, into \"statedRequirements\"."
      : "  an assumption is only for what they left out.",
    "- Every inference you made is an assumption. Tag each one:",
    '  "safe"  = reversible, low-impact, a conventional default;',
    '  "risky" = would change scope, architecture, data handling, cost, or security if wrong.',
    "- When unsure whether something is safe or risky, tag it risky.",
    "- The TL;DR is for a non-engineer: no jargon, 3 to 5 lines.",
    "- Acceptance criteria must be falsifiable (answerable yes/no by running or inspecting the result); avoid vague words like 'fast' or 'nice'.",
    "  Do NOT write numbers or bullets at the start of any list item: numbering is added for you.",
    `- Research plan: at most ${String(input.maxItems)} items. This plan is settled NOW; nothing will be asked later, so choose the outline,`,
    "  the time range and the modules yourself. Always list the official-docs targets for every named technology.",
    "- Links in the prompt that you cannot open are NOT to be guessed at: record an assumption saying so.",
    "",
    "JSON shape:",
    schemaDescription(input.quoteStatedRules === true),
    "",
    "=== THE PERSON'S PROMPT ===",
    input.prompt.trim(),
  ];
  for (const f of input.files) {
    const body = f.content.length > MAX_FILE_CHARS ? `${f.content.slice(0, MAX_FILE_CHARS)}\n...[truncated]` : f.content;
    lines.push("", `=== ATTACHED FILE: ${f.path} ===`, body);
  }
  if (links.length > 0) {
    lines.push("", "=== LINKS PROVIDED ===", ...links.map((l) => `- ${l}`));
  }
  if (input.memory !== null && input.memory.trim() !== "") {
    lines.push(
      "",
      "=== PROJECT MEMORY (decisions and conventions from earlier runs on this project; use them to choose assumptions) ===",
      wrapUntrusted({ kind: "project memory (facts written by earlier runs)", provenance: ".osa/memory", text: neutralizeInstructions(input.memory.trim(), { grow: false }).text }),
    );
  }
  if (retryNote !== null) {
    lines.push("", "=== YOUR PREVIOUS REPLY WAS REJECTED ===", retryNote, "Fix every problem and reply with the corrected JSON object only.");
  }
  return lines.join("\n");
}

/**
 * Extracts the first top-level JSON object from model output (tolerates code fences and surrounding prose). The whole reply is
 * tried first -- a valid object whose string values contain fenced code samples must not be cut at the first fence (found by the
 * Suite 2 red team) -- and only then each fenced block in turn.
 */
export function extractJsonObject(text: string): unknown {
  const attempt = (candidate: string): { ok: true; value: unknown } | { ok: false; error: string } => {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) return { ok: false, error: "no object" };
    try {
      return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) as unknown };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  const whole = attempt(text);
  if (whole.ok) return whole.value;
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const inner = attempt(m[1] ?? "");
    if (inner.ok) return inner.value;
  }
  if (text.indexOf("{") === -1 || text.lastIndexOf("}") <= text.indexOf("{")) {
    throw new IntakeError("The model reply contained no JSON object.");
  }
  throw new IntakeError(`The model reply was not valid JSON: ${whole.error}`);
}

/**
 * Puts the person's own request into the PRD, verbatim (capped), replacing anything the model put there. The PRD is a model's summary of the
 * request, and a summary drops or contradicts details; the locked PRD therefore carries the request itself and says it wins. Pure.
 */
export function withRequest(prd: BabyPrd, prompt: string): BabyPrd {
  const text = prompt.replace(/\r\n?/g, "\n").trim();
  const kept = text.length > REQUEST_MAX_CHARS ? `${text.slice(0, REQUEST_MAX_CHARS)}\n[... the rest of the request is not repeated here ...]` : text;
  return { ...prd, request: kept };
}

/** Parses and validates a model reply into a {@link BabyPrd}. Throws {@link IntakeError}. */
export function parseIntakeReply(text: string): BabyPrd {
  return parseIntakeReplyFull(text).prd;
}

/** Like {@link parseIntakeReply}, and also returns the quotes the model says it copied from the person's prompt (unchecked). */
export function parseIntakeReplyFull(text: string): { readonly prd: BabyPrd; readonly quotes: readonly string[] } {
  const json = extractJsonObject(text);
  const isObject = typeof json === "object" && json !== null && !Array.isArray(json);
  const { statedRequirements, ...rest } = (isObject ? json : {}) as Record<string, unknown>;
  const result = BabyPrdSchema.safeParse(isObject ? rest : json);
  if (!result.success) {
    throw new IntakeError(`The reply did not match the required shape:\n${z.prettifyError(result.error)}`);
  }
  return { prd: result.data, quotes: Array.isArray(statedRequirements) ? statedRequirements.filter((q): q is string => typeof q === "string") : [] };
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Keeps only the quotes that really are in the person's prompt (whitespace and case aside), each at least 12 characters and at most 600, without
 * repeats. A model "quote" that is a paraphrase is dropped: the point of a stated requirement is that it is the person's own words. Pure.
 */
export function verifiedQuotes(prompt: string, quotes: readonly string[]): string[] {
  const haystack = squash(prompt);
  const kept: string[] = [];
  for (const q of quotes) {
    const text = q.replace(/\s+/g, " ").trim();
    if (text.length < 12 || text.length > 600 || !haystack.includes(squash(text)) || kept.some((k) => squash(k) === squash(text))) continue;
    kept.push(text);
  }
  return kept;
}

/**
 * Appends each verified quote to the acceptance criteria as a requirement "exactly as stated" (capped at the criteria limit). The criteria are
 * what the spec must map to a concrete check and what the final application check exercises, so a rule the person wrote in so many words can no
 * longer be rewritten away by the model's summary without the final check noticing. Pure.
 */
export function withStatedRequirements(prd: BabyPrd, quotes: readonly string[]): BabyPrd {
  const room = Math.max(0, 40 - prd.acceptanceCriteria.length);
  const extra = quotes.slice(0, room).map((q) => `The finished project satisfies this requirement from the request, exactly as stated: "${q}"`);
  return extra.length === 0 ? prd : { ...prd, acceptanceCriteria: [...prd.acceptanceCriteria, ...extra] };
}

/** The result of {@link runIntake}. */
export interface IntakeResult {
  readonly prd: BabyPrd;
  /** Assumptions the model tagged `safe` that the deterministic backstop upgraded to `risky`. */
  readonly upgraded: readonly string[];
}

/** Leading "1.", "2)", "-", "*" markers a model may put on list items; numbering/bullets are rendered, never stored. */
const LEADING_MARKER = /^\s*(?:\d+[.)]|[-*•])\s+/;

/** Removes one leading list marker from `s`. */
export function stripListMarker(s: string): string {
  return s.replace(LEADING_MARKER, "").trim();
}

/** Makes slugs unique, strips stray list markers, and enforces the research-item cap (truncation becomes a safe assumption). */
function normalisePlan(raw: BabyPrd, maxItems: number): BabyPrd {
  const prd: BabyPrd = {
    ...raw,
    tldr: raw.tldr.map(stripListMarker),
    inScope: raw.inScope.map(stripListMarker),
    outOfScope: raw.outOfScope.map(stripListMarker),
    acceptanceCriteria: raw.acceptanceCriteria.map(stripListMarker),
    constraints: raw.constraints.map(stripListMarker),
  };
  const seen = new Set<string>();
  const items = prd.researchPlan.items.map((it) => {
    let slug = it.slug;
    let n = 2;
    while (seen.has(slug)) slug = `${it.slug}-${String(n++)}`;
    seen.add(slug);
    return { ...it, slug };
  });
  if (items.length <= maxItems) return { ...prd, researchPlan: { ...prd.researchPlan, items } };
  return {
    ...prd,
    researchPlan: { ...prd.researchPlan, items: items.slice(0, maxItems) },
    assumptions: [
      ...prd.assumptions,
      { text: `Research was limited to the first ${String(maxItems)} of ${String(items.length)} planned items (research.maxItems).`, risk: "safe" },
    ],
  };
}

/**
 * Runs intake: one model call, one retry that quotes the validation errors back, then {@link IntakeError}.
 * Emits `assumptions_generated`. Never asks the operator anything.
 */
export async function runIntake(input: IntakeInput, deps: IntakeDeps): Promise<IntakeResult> {
  let retryNote: string | null = null;
  let lastError = "no attempt was made";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const call = await deps.textCall(
      deps.provider,
      {
        prompt: buildIntakePrompt(input, retryNote),
        cwd: deps.cwd,
        timeoutMs: deps.timeoutMs,
        tier: "research-grade",
        webSearch: false,
        modelOverride: deps.model ?? null,
      },
      "intake",
    );
    if (!call.outcome.ok || call.outcome.text === null) {
      lastError = call.outcome.failure?.message ?? "the provider returned no text";
      // A provider failure is not the model's formatting mistake; retrying with a "fix your JSON" note would mislead it.
      retryNote = null;
      continue;
    }
    try {
      const { prd: parsed, quotes } = parseIntakeReplyFull(call.outcome.text);
      const { prd: backstopped, upgraded } = applyRiskBackstop(normalisePlan(parsed, input.maxItems));
      const withReq = withRequest(backstopped, input.prompt);
      const tagged = input.quoteStatedRules === true ? withStatedRequirements(withReq, verifiedQuotes(input.prompt, quotes)) : withReq;
      await deps.events.emit("assumptions_generated", {
        total: tagged.assumptions.length,
        risky: tagged.assumptions.filter((a) => a.risk === "risky").length,
        safe: tagged.assumptions.filter((a) => a.risk === "safe").length,
        upgradedByBackstop: upgraded.length,
        provider: deps.provider,
      });
      return { prd: tagged, upgraded };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      retryNote = lastError;
    }
  }
  throw new IntakeError(`Intake could not produce a valid baby PRD after 2 attempts: ${lastError}`, { provider: deps.provider });
}
