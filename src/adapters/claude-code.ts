// Implements PHASE_2_SPEC.md §6.1
//
// ClaudeCodeAdapter -- the ProviderAdapter implementation driving the `claude` CLI in headless
// (`-p`) mode. Every flag below is sourced from docs/modernization_log.md §4.1 and, where this
// spec marked a value [UNVERIFIED-P2], independently re-confirmed against the installed binary's
// own `claude --help` (v2.1.211) during this phase's build: `--setting-sources` accepts a
// comma-separated list of `user`/`project`/`local`, so the literal `"project"` is a valid single
// member; `--allowedTools`/`--allowed-tools` accepts a comma- or space-separated list of bare tool
// names (its own help text shows "Bash(git *) Edit", i.e. bare names mixed with pattern-restricted
// ones); `--model <model>` exists as documented. `--bare` is never emitted, under any input (PRD
// §9 FM8).
//
// [UNVERIFIED-P2] closure, added at Step 12 review (approved commit chore: Phase 2 review
// approved): §6.1's fourth flagged item -- whether `claude -p` (no positional prompt argument)
// reads the prompt from stdin, as `stdin: req.prompt` below assumes -- was left unaddressed by
// the phase-2 implementation commit's own comments; `claude --help` alone does not settle it (its
// `[prompt]` argument description says only "Your prompt", with no stdin-fallback note). The
// review closed the gap with a live local smoke test rather than trusting the design silently:
// `echo "Reply with exactly the word OK and nothing else." | claude -p --output-format json
// --effort low` on the installed v2.1.211 binary returned `{"type":"result",...,"result":"OK",...}`
// -- confirming `-p` with no positional argument does read the prompt from stdin. [VERIFIED-LOCAL].
// This is the exact class of gap PHASE_1_SPEC.md's own Windows `exitCode:null` erratum (see
// COMPREHENSION.md §5-6) already showed this project shipping silently once; recorded here instead
// of left implicit so a future reader does not have to re-derive it.

import { InternalError, TurnTimeoutError } from "../domain/errors.ts";
import type { ModelTier } from "../domain/tiers.ts";
import type { ProviderId, RawInvocationResult, TurnOutcome, TurnRequest } from "../domain/run.ts";
import type { Invocation, PreflightReport, ProviderAdapter } from "../ports/provider-adapter.ts";
import type { TextCapabilities, TextCapableAdapter, TextOutcome, TextRequest } from "../ports/text-provider.ts";
import { buildProviderPreflightReport } from "../verify/preflight.ts";

/**
 * `claude --effort` accepted values. [VERIFIED-LOCAL] against the installed binary's own
 * `--help` (v2.1.211): "Effort level for the current session (low, medium, high, xhigh, max)".
 * The published CLI reference doc additionally lists `ultracode`; per
 * docs/modernization_log.md §1 ("treat any value absent from the installed binary's own help as
 * unavailable"), it is deliberately excluded here.
 */
export const CLAUDE_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

/** A member of {@link CLAUDE_EFFORT_VALUES}. */
export type ClaudeEffortValue = (typeof CLAUDE_EFFORT_VALUES)[number];

/**
 * Abstract tier -> Claude Code `--effort` value (docs/modernization_log.md §1, PRD §6.2). Private
 * to this file: PHASE_1_SPEC.md §3.2 forbids this table living in `src/domain/`, and
 * PHASE_2_SPEC.md §3.3 deliberately does not share it with `codex-cli.ts` (the two providers'
 * effort value sets differ).
 */
const TIER_TO_EFFORT: Readonly<Record<ModelTier, ClaudeEffortValue>> = {
  "research-grade": "high",
  "verification-grade": "high",
  "high-volume-low-effort": "low",
};

/**
 * The fixed tool-access list an executor/reviewer turn is granted. FM8 requires an explicit
 * `--allowedTools` set (never `--bare`); this exact list is OSA's own choice, sized to
 * what an executor/reviewer turn plausibly needs and no more (PHASE_2_SPEC.md §6.1).
 */
const ALLOWED_TOOLS = "Bash,Edit,Write,Read,Glob,Grep";

/**
 * Drives the `claude` CLI in headless (`-p`) mode. Implements {@link ProviderAdapter} for
 * `claude-code`. Implements PHASE_2_SPEC.md §6.1.
 */
export class ClaudeCodeAdapter implements ProviderAdapter, TextCapableAdapter {
  readonly id: ProviderId = "claude-code";
  readonly textCapabilities: TextCapabilities = { webSearch: true, execute: true, webContainment: "no-file-access" };

  /** Delegates to the single, already-verified preflight assembly (FM9; PHASE_2_SPEC.md §1.5). */
  preflight(): Promise<PreflightReport> {
    return buildProviderPreflightReport("claude-code");
  }

  /**
   * Maps an abstract {@link ModelTier} to Claude Code's own `--effort` value. [DET] Total over
   * every {@link ModelTier}; throws {@link InternalError} on an unreachable tier value, mirroring
   * `getRole()`'s established pattern (PHASE_1_SPEC.md §3.3) for an exhaustive switch over a
   * closed union.
   */
  resolveEffort(tier: ModelTier): ClaudeEffortValue {
    const effort = TIER_TO_EFFORT[tier];
    if (effort === undefined) {
      throw new InternalError(`ClaudeCodeAdapter.resolveEffort: unreachable tier "${tier}"`, { tier });
    }
    return effort;
  }

  /**
   * Builds the `claude -p` invocation for one turn. **Pure**: reads only `req` and this file's own
   * fixed tables, never the process environment or the clock. `--bare` is never emitted, under any
   * `req` value (PRD §9 FM8) -- `--permission-mode bypassPermissions`, `--setting-sources project`,
   * `--strict-mcp-config`, and `--allowedTools` are unconditional elements of every branch, not
   * gated behind an `if`. Implements PHASE_2_SPEC.md §6.1.
   */
  buildInvocation(req: TurnRequest): Invocation {
    const args: string[] = [
      "-p",
      "--output-format",
      "json",
      "--effort",
      this.resolveEffort(req.tier),
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--allowedTools",
      ALLOWED_TOOLS,
    ];
    if (req.modelOverride !== null) {
      args.push("--model", req.modelOverride);
    }
    return {
      command: "claude",
      args,
      env: {},
      cwd: req.repoDir,
      stdin: req.prompt,
    };
  }

  /**
   * Interprets a completed `claude -p --output-format json` process result. [DET] Fixed order:
   * (1) an unconditional timeout check, before any exit-code inspection -- a timed-out run is
   * never resolved as a success regardless of exit code; (2) non-zero exit (`exitCode === null`,
   * a spawn-level failure, falls into this same branch); (3) a JSON parse check on stdout, to
   * catch a malformed `--output-format json` payload; (4) success. `record` is always `null` in
   * Phase 2: this method receives none of the six arguments `handoffPath()` needs to locate an
   * on-disk `HandoffRecord` -- combining this method's `ok`/`failure` signal with a file read is
   * Phase 3's dispatch-loop responsibility. Implements PHASE_2_SPEC.md §6.1.
   */
  interpretResult(raw: RawInvocationResult): TurnOutcome {
    if (raw.timedOut) {
      return {
        ok: false,
        record: null,
        failure: new TurnTimeoutError("claude-code turn timed out", {
          exitCode: raw.exitCode,
          signal: raw.signal,
        }),
      };
    }
    if (raw.exitCode !== 0) {
      return {
        ok: false,
        record: null,
        failure: new InternalError(`claude-code exited ${String(raw.exitCode)}`, {
          exitCode: raw.exitCode,
          signal: raw.signal,
          stderrExcerpt: raw.stderr.slice(0, 2000),
        }),
      };
    }
    try {
      JSON.parse(raw.stdout);
    } catch {
      return {
        ok: false,
        record: null,
        failure: new InternalError(
          "claude-code exited 0 but --output-format json stdout did not parse as JSON",
          { stdoutExcerpt: raw.stdout.slice(0, 2000) },
        ),
      };
    }
    return { ok: true, record: null, failure: null };
  }

  /**
   * Builds a read-only text call: `claude -p` restricted via `--tools` to read-only repo tools, plus the
   * built-in `WebSearch`/`WebFetch` when `req.webSearch`. No write tool is ever offered, so a text call
   * cannot modify the repository. Pure. (OSA WS2/WS3.)
   */
  buildTextInvocation(req: TextRequest): Invocation {
    // Read-only by construction: no Edit/Write tool is ever offered. `Bash` is added only for an explicit
    // `execute` call (the application agent), which callers point at a disposable copy of the repository.
    // A call that reaches the open web gets ONLY the web tools: no Read/Glob/Grep, so planted page text cannot make it read a
    // local file and send it out through a web request. Repository-reading calls never get the web tools.
    const tools = req.webSearch ? "WebSearch,WebFetch" : ["Read", "Glob", "Grep", ...(req.execute === true ? ["Bash"] : [])].join(",");
    const args: string[] = [
      "-p",
      "--output-format",
      "json",
      "--effort",
      this.resolveEffort(req.tier),
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--tools",
      tools,
    ];
    if (req.modelOverride !== null) {
      args.push("--model", req.modelOverride);
    }
    return { command: "claude", args, env: {}, cwd: req.cwd, stdin: req.prompt };
  }

  /** Interprets `claude -p --output-format json`: the answer is the `result` string of the result object. */
  interpretTextResult(raw: RawInvocationResult): TextOutcome {
    const turn = this.interpretResult(raw);
    if (!turn.ok) {
      return { ok: false, text: null, failure: turn.failure };
    }
    const parsed: unknown = JSON.parse(raw.stdout);
    const obj = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    const result = obj?.["result"];
    if (obj?.["is_error"] === true || typeof result !== "string" || result.trim() === "") {
      return {
        ok: false,
        text: null,
        failure: new InternalError("claude-code text call returned an error or an empty result", { stdoutExcerpt: raw.stdout.slice(0, 2000) }),
      };
    }
    return { ok: true, text: result, failure: null };
  }
}
