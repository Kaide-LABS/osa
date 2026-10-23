// Plain-language rewrite of the spec's engineering decisions for the run summary (OSA_DIRECTIVE.md "Plain-language
// surfaces"). The spec author's decisions are written for coding agents ("CommonJS", "readFileSync", exit codes); the
// person reading the summary needs the handful that affect them, in everyday words. One short model call; if it cannot be
// had, the summary says how many technical decisions were made and points at the "For engineers" section -- it never
// pastes the raw text into the plain-language part.

import { NO_QUESTIONS } from "./prompt-rules.ts";
import type { ProviderId } from "../domain/run.ts";
import type { TextCall } from "../ports/text-provider.ts";

/** Cap on bullets shown to the person. */
export const MAX_PLAIN_CHOICES = 8;

/** Builds the prompt. Pure. */
export function buildPlainChoicesPrompt(decisions: readonly string[]): string {
  return [
    NO_QUESTIONS,
    "Below are technical decisions made while writing the spec for a software project. The reader is NOT an engineer.",
    `Rewrite them as at most ${String(MAX_PLAIN_CHOICES)} short bullet points ("- ...") saying what was chosen on their behalf and, in a few words, why it matters to them.`,
    "Keep only choices a person would care about (how it behaves, what it will and will not do, what it needs to run). Merge related ones.",
    "Plain everyday words only: no code, no file names, no programming terms (no 'CommonJS', 'stdout', 'exit code', 'module', 'API').",
    "Reply with the bullets and nothing else.",
    "",
    "=== TECHNICAL DECISIONS ===",
    ...decisions.map((d) => `- ${d}`),
  ].join("\n");
}

/** Extracts up to {@link MAX_PLAIN_CHOICES} bullets from a reply; code-ish fragments are stripped. Pure. */
export function parsePlainChoices(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*[-*]\s+(.*\S)\s*$/)?.[1])
    .filter((l): l is string => l !== undefined)
    .map((l) => l.replace(/`/g, "").trim())
    .filter((l) => l !== "")
    .slice(0, MAX_PLAIN_CHOICES);
}

/** The result of {@link plainChoices}. */
export interface PlainChoices {
  readonly bullets: readonly string[];
  /** False when the model could not be used (the caller then shows only a count). */
  readonly rewritten: boolean;
}

/** Rewrites `decisions` in plain language. Never throws. No decisions => no bullets, `rewritten: true`. */
export async function plainChoices(input: {
  readonly decisions: readonly string[];
  readonly textCall: TextCall;
  readonly provider: ProviderId;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly modelOverride?: string | null;
}): Promise<PlainChoices> {
  if (input.decisions.length === 0) return { bullets: [], rewritten: true };
  const call = await input.textCall(
    input.provider,
    { prompt: buildPlainChoicesPrompt(input.decisions), cwd: input.cwd, timeoutMs: input.timeoutMs, tier: "high-volume-low-effort", webSearch: false, modelOverride: input.modelOverride ?? null },
    "plain-choices",
  );
  if (!call.outcome.ok || call.outcome.text === null) return { bullets: [], rewritten: false };
  const bullets = parsePlainChoices(call.outcome.text);
  return bullets.length > 0 ? { bullets, rewritten: true } : { bullets: [], rewritten: false };
}
