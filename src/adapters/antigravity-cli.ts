// Implements PHASE_11_SPEC.md §4 and §6.2.
//
// Drives `agy` only through its print-mode CLI contract. Conversation continuation, interactive
// prompting, and terminal sandboxing flags are never emitted: turns must remain isolated and able
// to use git. The `--print=` flag shape was determined against the live, installed agy v1.1.27
// binary (PHASE_11 AC-A5), after the originally-assumed shapes (`--print` first, `--print` last
// with no value, and all three of FM-P20b's prescribed fallbacks) were each tried and rejected --
// see `buildInvocation`'s own comment for the exact observed errors.

import { InternalError, TurnTimeoutError } from "../domain/errors.ts";
import type { ModelTier } from "../domain/tiers.ts";
import type { ProviderId, RawInvocationResult, TurnOutcome, TurnRequest } from "../domain/run.ts";
import type { Invocation, PreflightReport, ProviderAdapter } from "../ports/provider-adapter.ts";
import type { TextCapabilities, TextCapableAdapter, TextOutcome, TextRequest } from "../ports/text-provider.ts";
import { buildProviderPreflightReport } from "../verify/preflight.ts";

/** `agy --effort` accepted values. */
export const ANTIGRAVITY_EFFORT_VALUES = ["low", "medium", "high"] as const;
export type AntigravityEffortValue = (typeof ANTIGRAVITY_EFFORT_VALUES)[number];

const TIER_TO_EFFORT: Readonly<Record<ModelTier, AntigravityEffortValue>> = {
  "research-grade": "high",
  "verification-grade": "high",
  "high-volume-low-effort": "low",
};

function buildStreamJsonStdin(prompt: string): string {
  return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The fields of a `result` event, whichever shape this `agy` emits. agy 1.1.x put `status` (and `error`)
 * directly on the event: `{"event":"result","status":"SUCCESS"}`. agy 1.3.x nests them:
 * `{"event":"result","result":{"status":"SUCCESS","response":"OK
","conversation_id":...}}`. Reading only the flat
 * shape made EVERY turn on 1.3.x look failed ("result status undefined") although the CLI had succeeded --
 * reproduced against the installed 1.3.3 binary on 2026-10-17 (docs/osa/ANTIGRAVITY.md). Both shapes are
 * accepted; the nested object wins when present.
 */
export function resultPayload(event: Record<string, unknown>): Record<string, unknown> {
  const nested = event["result"];
  return isRecord(nested) ? { ...event, ...nested } : event;
}

function parseEvent(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Provider adapter for Antigravity CLI print mode. */
export class AntigravityCliAdapter implements ProviderAdapter, TextCapableAdapter {
  readonly id: ProviderId = "antigravity-cli";
  /** No verified headless web-search tool exists for `agy` (docs/osa/CONFLICTS.md C-08); research routes elsewhere. */
  readonly textCapabilities: TextCapabilities = { webSearch: false, execute: false };

  preflight(): Promise<PreflightReport> {
    return buildProviderPreflightReport("antigravity-cli");
  }

  resolveEffort(tier: ModelTier): AntigravityEffortValue {
    const effort = TIER_TO_EFFORT[tier];
    if (effort === undefined) {
      throw new InternalError(`AntigravityCliAdapter.resolveEffort: unreachable tier "${tier}"`, { tier });
    }
    return effort;
  }

  buildInvocation(req: TurnRequest): Invocation {
    // `--print` cannot be used bare (agy: "flag needs an argument: -print") and cannot be given a
    // non-empty value alongside `--input-format stream-json` (agy: "a prompt given on the command
    // line would be ignored" -- stream-json mode reads the prompt from stdin, so any command-line
    // value is a contradiction agy refuses outright). The only shape agy's parser accepts is an
    // explicit, empty, attached value: `--print=`. Reproduced directly against the installed agy
    // v1.1.27 binary: `agy --input-format stream-json --output-format stream-json --print-timeout
    // 1000ms --print=` starts a real session (an `init` event) and exits 0. This is the one
    // combination not in PHASE_11_SPEC.md §7 FM-P20b's own three prescribed fallbacks (`--print ""`,
    // `--print -`, `--prompt` in place of `--print`), all of which were tried and rejected.
    const args = [
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--disable-slash-commands", "--dangerously-skip-permissions", "--effort", this.resolveEffort(req.tier),
      "--print-timeout", `${String(req.timeoutMs)}ms`,
    ];
    if (req.modelOverride !== null) args.push("--model", req.modelOverride);
    args.push("--print=");
    return { command: "agy", args, env: {}, cwd: req.repoDir, stdin: buildStreamJsonStdin(req.prompt) };
  }

  interpretResult(raw: RawInvocationResult): TurnOutcome {
    if (raw.timedOut) return { ok: false, record: null, failure: new TurnTimeoutError("antigravity-cli turn timed out", { exitCode: raw.exitCode, signal: raw.signal }) };
    let result: Record<string, unknown> | null = null;
    for (const line of raw.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const event = parseEvent(line);
      if (event?.["event"] === "result") result = event;
    }
    if (result === null) return { ok: false, record: null, failure: new InternalError("antigravity-cli produced no result event", { stdoutExcerpt: raw.stdout.slice(0, 2000) }) };
    const payload = resultPayload(result);
    const status = payload["status"];
    if (status !== "SUCCESS") {
      const message = status === "WAITING" ? "antigravity-cli reported WAITING; permission handling stalled despite --dangerously-skip-permissions" : `antigravity-cli reported result status ${String(status)}`;
      return { ok: false, record: null, failure: new InternalError(message, { status, error: payload["error"], exitCode: raw.exitCode, signal: raw.signal }) };
    }
    if (raw.exitCode !== 0) return { ok: false, record: null, failure: new InternalError(`antigravity-cli exited ${String(raw.exitCode)}`, { exitCode: raw.exitCode, signal: raw.signal, stderrExcerpt: raw.stderr.slice(0, 2000) }) };
    return { ok: true, record: null, failure: null };
  }

  /**
   * Builds a text call. Unlike a build turn it deliberately omits `--dangerously-skip-permissions`: a text
   * call needs no tool permissions, and a call that tries to use a tool stalls as `WAITING` (reported as a
   * failure) instead of silently running with approvals skipped. Pure. (OSA WS2.)
   */
  buildTextInvocation(req: TextRequest): Invocation {
    const args = [
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--disable-slash-commands", "--effort", this.resolveEffort(req.tier),
      "--print-timeout", `${String(req.timeoutMs)}ms`,
    ];
    if (req.modelOverride !== null) args.push("--model", req.modelOverride);
    args.push("--print=");
    return { command: "agy", args, env: {}, cwd: req.cwd, stdin: buildStreamJsonStdin(req.prompt) };
  }

  /**
   * Interprets agy stream-json output. [VERIFIED-LOCAL, agy 1.3.3] The answer is `result.response`
   * on the `result` event; older/other shapes fall back to `text`/`output`/`result`, then to the
   * `agent_response` step deltas. See docs/osa/ANTIGRAVITY.md.
   */
  interpretTextResult(raw: RawInvocationResult): TextOutcome {
    const turn = this.interpretResult(raw);
    if (!turn.ok) {
      return { ok: false, text: null, failure: turn.failure };
    }
    let resultText: string | null = null;
    const assistantParts: string[] = [];
    for (const line of raw.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const event = parseEvent(line);
      if (event === null) continue;
      if (event["event"] === "result") {
        const payload = resultPayload(event);
        for (const key of ["response", "text", "output", "result"]) {
          const v = payload[key];
          if (typeof v === "string" && v.trim() !== "") {
            resultText = v;
            break;
          }
        }
      } else if (event["event"] === "step_update" && isRecord(event["step_update"])) {
        // agy 1.3.x streams the answer as `agent_response` step deltas.
        const step = event["step_update"];
        if (step["step_type"] === "agent_response" && typeof step["text_delta"] === "string") assistantParts.push(step["text_delta"]);
      } else if (typeof event["event"] === "string" && /assistant|agent|model|message|text/i.test(event["event"])) {
        const message = event["message"];
        const content = typeof message === "object" && message !== null ? (message as Record<string, unknown>)["content"] : event["content"];
        if (typeof content === "string" && content.trim() !== "") assistantParts.push(content);
      }
    }
    const text = resultText ?? (assistantParts.length > 0 ? assistantParts.join("") : null);
    if (text === null) {
      return {
        ok: false,
        text: null,
        failure: new InternalError("antigravity-cli text call produced no recognisable answer text", { stdoutExcerpt: raw.stdout.slice(0, 2000) }),
      };
    }
    return { ok: true, text, failure: null };
  }
}
