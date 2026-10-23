// Context trimming (OSA_DIRECTIVE.md WS4). A `ContextTrimmer` shortens text that is being HANDED OFF between
// stages (research -> spec input, phase N output -> phase N+1 input, agent -> agent relays). It never sees
// the locked baby PRD, the spec, or acceptance criteria -- see `handoff.ts`, which makes that structural.
//
// Engines: `Trim1Trimmer` (shells out to a locally installed trim-1 binary; see docs/osa/TRIM1_NOTES.md) and
// `NoopTrimmer` (the honest fallback: returns the input unchanged and says why). The interface is small and
// engine-agnostic so another pruning model can be swapped in by config.

/** A coarse token estimate (about 4 characters per token for English prose and code). Documented as an estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Options of {@link ContextTrimmer.trim}. */
export interface TrimOptions {
  /** Aim for at most this many (estimated) tokens. */
  readonly budgetTokens: number;
  /**
   * Literal substrings: every input line containing one survives byte-identical. (The engine-independent
   * protected-line patterns in `protected.ts` are applied on top.)
   */
  readonly keep: readonly string[];
  /** What the downstream reader is about to do; query-conditioned engines (trim-1) require it. */
  readonly query?: string;
}

/** The result of a trim. */
export interface TrimResult {
  readonly output: string;
  /** Input lines that are not in `output` (replaced by removal markers). */
  readonly removedLines: number;
  /** `afterTokens / beforeTokens` (1 = nothing removed). */
  readonly ratio: number;
  /** The engine actually shortened the text. `false` = output === input. */
  readonly applied: boolean;
  readonly engine: string;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  /** `afterTokens <= budgetTokens`. */
  readonly metBudget: boolean;
  /** Why nothing was applied (or a caveat), else `null`. */
  readonly reason: string | null;
  /** The engine's operating point, if it has one. */
  readonly point: string | null;
}

/** Shortens handoff text. Never throws for a modelled outcome; an engine failure returns `applied: false`. */
export interface ContextTrimmer {
  readonly engine: string;
  trim(input: string, opts: TrimOptions): Promise<TrimResult>;
}

/** Builds an "unchanged" result. Pure. */
export function unchangedResult(input: string, opts: TrimOptions, engine: string, reason: string, point: string | null = null): TrimResult {
  const tokens = estimateTokens(input);
  return { output: input, removedLines: 0, ratio: 1, applied: false, engine, beforeTokens: tokens, afterTokens: tokens, metBudget: tokens <= opts.budgetTokens, reason, point };
}

/** The fallback engine: does nothing, and says so. Used when `trim.engine` is `noop` or trim-1 is unavailable. */
export class NoopTrimmer implements ContextTrimmer {
  readonly engine = "noop";
  private readonly why: string;

  constructor(why = "the noop engine is configured") {
    this.why = why;
  }

  trim(input: string, opts: TrimOptions): Promise<TrimResult> {
    return Promise.resolve(unchangedResult(input, opts, this.engine, this.why));
  }
}
