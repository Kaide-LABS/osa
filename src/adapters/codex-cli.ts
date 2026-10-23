// Implements PHASE_2_SPEC.md §6.2
//
// CodexCliAdapter -- the ProviderAdapter implementation driving the `codex` CLI (`codex exec`).
// `-a`/`--ask-for-approval` and `--full-auto` are never emitted, under any input: neither appears
// at all in the installed binary's own `codex exec --help` (v0.128.0) -- confirming PRD §9 FM7's
// finding that `-a` is rejected by `exec` (it exists only on the top-level interactive `codex`
// command) and that `--full-auto` is fully removed in favour of `--sandbox workspace-write`. The
// same `--help` output confirms the documented stdin contract used below: "[PROMPT] ... If not
// provided as an argument (or if `-` is used), instructions are read from stdin."

import { InternalError, TurnTimeoutError } from "../domain/errors.ts";
import type { ModelTier } from "../domain/tiers.ts";
import type { ProviderId, RawInvocationResult, TurnOutcome, TurnRequest } from "../domain/run.ts";
import type { Invocation, PreflightReport, ProviderAdapter } from "../ports/provider-adapter.ts";
import type { TextCapabilities, TextCapableAdapter, TextOutcome, TextRequest } from "../ports/text-provider.ts";
import { buildProviderPreflightReport } from "../verify/preflight.ts";

/**
 * `-c model_reasoning_effort` accepted values. [VERIFIED-DOC] docs/modernization_log.md §4.2 (the
 * config-reference page): `minimal | low | medium | high | xhigh`.
 */
export const CODEX_EFFORT_VALUES = ["minimal", "low", "medium", "high", "xhigh"] as const;

/** A member of {@link CODEX_EFFORT_VALUES}. */
export type CodexEffortValue = (typeof CODEX_EFFORT_VALUES)[number];

/**
 * Abstract tier -> Codex `model_reasoning_effort` value (docs/modernization_log.md §1, PRD §6.2).
 * Private to this file -- see the identical note on `claude-code.ts`'s own `TIER_TO_EFFORT`
 * (PHASE_2_SPEC.md §3.3).
 */
const TIER_TO_EFFORT: Readonly<Record<ModelTier, CodexEffortValue>> = {
  "research-grade": "high",
  "verification-grade": "high",
  "high-volume-low-effort": "low",
};

/** JSONL event `type` values that mean the turn failed, even if the process later exits `0`. */
const TURN_FAILURE_EVENT_TYPES: ReadonlySet<string> = new Set(["turn.failed", "error"]);

/** Cap on how many matched failure events are attached to the thrown error's `details`. */
const MAX_REPORTED_EVENTS = 20;

/**
 * Best-effort parse of one JSONL line from `codex exec --json`'s event stream. Returns `null` on
 * a line that fails to parse as a JSON object -- skipped, not treated as a crash. The documented
 * contract (docs/modernization_log.md §4.2) is the event-*type* vocabulary
 * (`thread.started`/`turn.started`/`turn.completed`/`turn.failed`/`item.*`/`error`), not a
 * guarantee that every implementation detail of every line is parseable by a naive split.
 */
function tryParseJsonlEvent(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/**
 * Drives the `codex exec` CLI in non-interactive mode. Implements {@link ProviderAdapter} for
 * `codex-cli`. Implements PHASE_2_SPEC.md §6.2.
 */
export class CodexCliAdapter implements ProviderAdapter, TextCapableAdapter {
  readonly id: ProviderId = "codex-cli";
  readonly textCapabilities: TextCapabilities = { webSearch: true, execute: true, webContainment: "read-only-files" };

  /** Delegates to the single, already-verified preflight assembly (FM9; PHASE_2_SPEC.md §1.5). */
  preflight(): Promise<PreflightReport> {
    return buildProviderPreflightReport("codex-cli");
  }

  /**
   * Maps an abstract {@link ModelTier} to Codex's own `model_reasoning_effort` value. [DET] Total
   * over every {@link ModelTier}; throws {@link InternalError} on an unreachable tier value,
   * mirroring `ClaudeCodeAdapter.resolveEffort`'s identical pattern.
   */
  resolveEffort(tier: ModelTier): CodexEffortValue {
    const effort = TIER_TO_EFFORT[tier];
    if (effort === undefined) {
      throw new InternalError(`CodexCliAdapter.resolveEffort: unreachable tier "${tier}"`, { tier });
    }
    return effort;
  }

  /**
   * Builds the `codex exec` invocation for one turn. **Pure**. `-a`/`--ask-for-approval` and
   * `--full-auto` are never emitted, under any `req` value (PRD §9 FM7) -- `-c
   * approval_policy="never"` and `--sandbox workspace-write` are unconditional elements of every
   * branch, not gated behind an `if`. Implements PHASE_2_SPEC.md §6.2.
   */
  buildInvocation(req: TurnRequest): Invocation {
    const args: string[] = [
      "exec",
      "-c",
      `approval_policy="never"`,
      "--sandbox",
      "workspace-write",
      "-c",
      `model_reasoning_effort="${this.resolveEffort(req.tier)}"`,
    ];
    if (req.modelOverride !== null) {
      args.push("-c", `model="${req.modelOverride}"`);
    }
    args.push("--json", "-C", req.repoDir, "-");
    return {
      command: "codex",
      args,
      env: {},
      cwd: req.repoDir,
      stdin: req.prompt,
    };
  }

  /**
   * Interprets a completed `codex exec --json` process result. [DET] Fixed order: (1) an
   * unconditional timeout check, before any exit-code inspection; (2) scan every parseable JSONL
   * stdout line for a `turn.failed`/`error` event -- checked *before* the exit-code fallback,
   * because a wrapped failure can in principle still exit `0` and the event stream is the more
   * specific signal when both are present; (3) non-zero exit; (4) success. `record` is always
   * `null` in Phase 2 -- same reasoning as `ClaudeCodeAdapter.interpretResult`'s closing note.
   * Implements PHASE_2_SPEC.md §6.2.
   */
  interpretResult(raw: RawInvocationResult): TurnOutcome {
    if (raw.timedOut) {
      return {
        ok: false,
        record: null,
        failure: new TurnTimeoutError("codex-cli turn timed out", {
          exitCode: raw.exitCode,
          signal: raw.signal,
        }),
      };
    }

    const failureEvents: Record<string, unknown>[] = [];
    for (const line of raw.stdout.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const event = tryParseJsonlEvent(line);
      if (event === null) {
        continue;
      }
      const type = event["type"];
      if (typeof type === "string" && TURN_FAILURE_EVENT_TYPES.has(type)) {
        failureEvents.push(event);
      }
    }
    if (failureEvents.length > 0) {
      return {
        ok: false,
        record: null,
        failure: new InternalError("codex-cli reported a turn.failed/error event", {
          events: failureEvents.slice(0, MAX_REPORTED_EVENTS),
        }),
      };
    }

    if (raw.exitCode !== 0) {
      return {
        ok: false,
        record: null,
        failure: new InternalError(`codex-cli exited ${String(raw.exitCode)}`, {
          exitCode: raw.exitCode,
          signal: raw.signal,
          stderrExcerpt: raw.stderr.slice(0, 2000),
        }),
      };
    }

    if (raw.stdout.trim() === "") {
      return { ok: false, record: null, failure: new InternalError("codex-cli produced no JSONL events", { stdoutExcerpt: "" }) };
    }
    return { ok: true, record: null, failure: null };
  }

  /**
   * Builds a read-only text call: `codex exec --sandbox read-only`, with the native web search tool
   * enabled through the `web_search` config key when `req.webSearch`. [UNVERIFIED-LOCAL] The `web_search`
   * key name follows the Codex config reference; if an installed build ignores it, the call still
   * succeeds but without live search -- which the research stage detects through its own doc-source
   * requirement rather than trusting this flag. Pure. (OSA WS2/WS3.)
   */
  buildTextInvocation(req: TextRequest): Invocation {
    const args: string[] = [
      "exec",
      "-c",
      `approval_policy="never"`,
      "--sandbox",
      // `execute` (application agent, in a disposable copy) needs a writable scratch area for the program's own
      // temp files; every other text call stays read-only.
      req.execute === true ? "workspace-write" : "read-only",
      "-c",
      `model_reasoning_effort="${this.resolveEffort(req.tier)}"`,
    ];
    // Codex 0.160 gives every `exec` call a built-in web tool UNLESS told otherwise (live-verified: a call made with no web flag still
    // looked up a release published that week). A call that did not ask for the web must therefore say "disabled" explicitly.
    args.push("-c", req.webSearch ? `web_search="live"` : `web_search="disabled"`);
    if (req.modelOverride !== null) {
      args.push("-c", `model="${req.modelOverride}"`);
    }
    // A web-enabled call runs in an empty scratch directory (see makeTextCall), which is not a git repository.
    if (req.webSearch) args.push("--skip-git-repo-check");
    args.push("--json", "-C", req.cwd, "-");
    return { command: "codex", args, env: {}, cwd: req.cwd, stdin: req.prompt };
  }

  /** Interprets `codex exec --json`: the answer is the last `agent_message` item's text. */
  interpretTextResult(raw: RawInvocationResult): TextOutcome {
    const turn = this.interpretResult(raw);
    if (!turn.ok) {
      return { ok: false, text: null, failure: turn.failure };
    }
    let last: string | null = null;
    for (const line of raw.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const event = tryParseJsonlEvent(line);
      const item = event?.["item"];
      if (event?.["type"] === "item.completed" && typeof item === "object" && item !== null) {
        const rec = item as Record<string, unknown>;
        if (rec["type"] === "agent_message" && typeof rec["text"] === "string" && rec["text"].trim() !== "") {
          last = rec["text"];
        }
      }
    }
    if (last === null) {
      return {
        ok: false,
        text: null,
        failure: new InternalError("codex-cli text call produced no agent_message", { stdoutExcerpt: raw.stdout.slice(0, 2000) }),
      };
    }
    return { ok: true, text: last, failure: null };
  }
}
