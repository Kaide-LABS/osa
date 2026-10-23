// The trim-1 engine: a locally installed `trim` binary, run through the one sanctioned `runProcess`. trim-1
// (Apache-2.0, a 712-tree gradient-boosted line scorer, ~1.2 MB, no network, no GPU) has no Node API, so the
// only honest integration is this shell-out; when the binary is absent `resolveTrimmer` returns the
// `NoopTrimmer` and the caller logs `trim_skipped`. See docs/osa/TRIM1_NOTES.md.
//
// Observed contract (built from source and run on this machine, 2026-10-17):
//   trim --query "<ask>" [--point conservative|balanced|aggressive]   (context on stdin)
//   stdout: the kept lines in original order, each removed run replaced by one `… N lines …` marker line
//   stderr: `trim: kept K lines, removed R, A -> B bytes`   or   `trim: unchanged (<reason>)`
//   fails closed (input returned unchanged) on a tiny context (< 2000 bytes), a cut under 10%, etc.
// trim-1 has NO "keep these lines" and NO token-budget knob. So OSA (a) steps the operating point up until
// the budget is met, and (b) re-inserts every protected line the engine dropped (`protected.ts`), which makes
// "paths, hashes, errors, test names survive" a property of this wrapper, not of the model.

import type { RawInvocationResult } from "../domain/run.ts";
import type { OsaConfig } from "../domain/osa-config.ts";
import { TRIM_POINTS } from "../domain/osa-config.ts";
import { runProcess } from "../util/exec.ts";
import { isProtectedLine } from "./protected.ts";
import { NoopTrimmer, estimateTokens, unchangedResult } from "./trimmer.ts";
import type { ContextTrimmer, TrimOptions, TrimResult } from "./trimmer.ts";

type TrimPoint = (typeof TRIM_POINTS)[number];

const MARKER = /^… \d+ lines …$/;
const TRIM_TIMEOUT_MS = 60_000;
const MAX_QUERY_CHARS = 500;

/** Parses trim-1's stderr summary: `{ ok }` for `trim: kept ...` and `{ unchanged: reason }` for `trim: unchanged (...)`. Pure. */
export function parseTrimStderr(stderr: string): { readonly kind: "cut" } | { readonly kind: "unchanged"; readonly reason: string } | { readonly kind: "unknown" } {
  const line = stderr.trim().split(/\r?\n/)[0] ?? "";
  if (/^trim: kept \d+ lines?, removed \d+/.test(line)) return { kind: "cut" };
  const m = line.match(/^trim: unchanged \((.*)\)$/);
  if (m?.[1] !== undefined) return { kind: "unchanged", reason: m[1] };
  return { kind: "unknown" };
}

/**
 * Re-inserts protected lines the engine dropped. Walks the input once against the engine's output (markers
 * ignored); an input line is kept if the engine kept it OR it is protected. Runs of dropped lines collapse
 * into one `… N lines …` marker. Pure; the result contains every protected input line, in original order.
 */
export function restoreProtectedLines(input: string, engineOutput: string, keep: readonly string[]): { readonly output: string; readonly removedLines: number } {
  // The final newline terminates the last line; it does not start an extra empty one (that phantom line was counted as "removed").
  const inLines = input.replace(/\n$/, "").split("\n");
  const outLines = engineOutput.replace(/\n$/, "").split("\n");
  const result: string[] = [];
  let j = 0;
  let run = 0;
  let removed = 0;
  const flush = (): void => {
    if (run > 0) {
      result.push(`… ${String(run)} lines …`);
      removed += run;
      run = 0;
    }
  };
  for (const line of inLines) {
    while (j < outLines.length && MARKER.test(outLines[j] as string) && outLines[j] !== line) j += 1;
    if (j < outLines.length && outLines[j] === line) {
      flush();
      result.push(line);
      j += 1;
    } else if (isProtectedLine(line, keep)) {
      flush();
      result.push(line);
    } else {
      run += 1;
    }
  }
  flush();
  return { output: result.join("\n"), removedLines: removed };
}

/** Options of {@link Trim1Trimmer}. */
export interface Trim1Options {
  /** The `trim` executable (a path, or a bare name resolved on PATH). */
  readonly command: string;
  /** The operating point to start from. */
  readonly point: TrimPoint;
  readonly runProcessFn?: typeof runProcess;
  readonly cwd?: string;
}

/** Shell-out engine. See the module comment. */
export class Trim1Trimmer implements ContextTrimmer {
  readonly engine = "trim1";
  private readonly command: string;
  private readonly point: TrimPoint;
  private readonly spawn: typeof runProcess;
  private readonly cwd: string;

  constructor(o: Trim1Options) {
    this.command = o.command;
    this.point = o.point;
    this.spawn = o.runProcessFn ?? runProcess;
    this.cwd = o.cwd ?? process.cwd();
  }

  private async runOnce(input: string, query: string, point: TrimPoint): Promise<{ raw: RawInvocationResult; summary: ReturnType<typeof parseTrimStderr> }> {
    const raw = await this.spawn({ command: this.command, args: ["--query", query, "--point", point], cwd: this.cwd, stdin: input, timeoutMs: TRIM_TIMEOUT_MS, noShellFallback: true });
    return { raw, summary: parseTrimStderr(raw.stderr) };
  }

  async trim(input: string, opts: TrimOptions): Promise<TrimResult> {
    const before = estimateTokens(input);
    if (before <= opts.budgetTokens) return unchangedResult(input, opts, this.engine, "already within the token budget", this.point);
    const query = (opts.query ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
    if (query === "") return unchangedResult(input, opts, this.engine, "trim-1 is query-conditioned and no query was supplied", this.point);

    let best: TrimResult | null = null;
    let lastReason = "trim-1 returned the input unchanged";
    for (const point of TRIM_POINTS.slice(TRIM_POINTS.indexOf(this.point))) {
      const { raw, summary } = await this.runOnce(input, query, point);
      if (raw.timedOut || raw.exitCode !== 0 || summary.kind === "unknown") {
        lastReason = raw.timedOut ? "trim-1 timed out" : `trim-1 failed (exit ${String(raw.exitCode)})`;
        break; // an engine fault is not something a more aggressive point fixes
      }
      if (summary.kind === "unchanged") {
        lastReason = `trim-1: ${summary.reason}`;
        continue;
      }
      const restored = restoreProtectedLines(input, raw.stdout.replace(/\n$/, ""), opts.keep);
      const after = estimateTokens(restored.output);
      const candidate: TrimResult = {
        output: input.endsWith("\n") ? `${restored.output}\n` : restored.output,
        removedLines: restored.removedLines,
        ratio: after / before,
        applied: true,
        engine: this.engine,
        beforeTokens: before,
        afterTokens: after,
        metBudget: after <= opts.budgetTokens,
        reason: null,
        point,
      };
      best = candidate;
      if (candidate.metBudget) break;
    }
    if (best === null) return unchangedResult(input, opts, this.engine, lastReason, this.point);
    return best.metBudget ? best : { ...best, reason: "the token budget could not be met without dropping protected lines" };
  }
}

/** Dependencies of {@link resolveTrimmer}. */
export interface ResolveTrimmerDeps {
  readonly runProcessFn?: typeof runProcess;
  readonly cwd?: string;
}

/** The outcome of {@link resolveTrimmer}. */
export interface ResolvedTrimmer {
  readonly trimmer: ContextTrimmer;
  /** Why the configured engine is not in use, else `null`. */
  readonly note: string | null;
}

/**
 * Picks the trimmer for `trim` config. `trim1` is probed once -- a genuine trim-1 binary answers a tiny input with
 * exit 0 and a `trim: unchanged (...)` line on stderr -- so an unrelated executable named `trim` on PATH is never
 * mistaken for it. Anything else yields the {@link NoopTrimmer} with the reason, which the caller logs.
 */
export async function resolveTrimmer(trim: OsaConfig["trim"], deps: ResolveTrimmerDeps = {}): Promise<ResolvedTrimmer> {
  if (!trim.enabled) return { trimmer: new NoopTrimmer("trim.enabled is false"), note: "trim.enabled is false" };
  if (trim.engine === "noop") return { trimmer: new NoopTrimmer("trim.engine is noop"), note: "trim.engine is noop" };
  const command = trim.binaryPath !== "" ? trim.binaryPath : "trim";
  const spawn = deps.runProcessFn ?? runProcess;
  const probe = await spawn({ command, args: ["--query", "probe"], cwd: deps.cwd ?? process.cwd(), stdin: "probe\n", timeoutMs: 15_000, noShellFallback: true });
  const genuine = probe.exitCode === 0 && parseTrimStderr(probe.stderr).kind !== "unknown";
  if (!genuine) {
    const note = `trim-1 is not available (\`${command}\` was not found or is not trim-1); install it with \`go install github.com/caveman-ai/trim-1/cmd/trim@latest\` or set trim.binaryPath`;
    return { trimmer: new NoopTrimmer(note), note };
  }
  return { trimmer: new Trim1Trimmer({ command, point: trim.point, runProcessFn: spawn, ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}) }), note: null };
}
