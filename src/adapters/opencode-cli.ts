// OpenCode (`opencode`) driven through its headless `run` command. Every flag below was observed against the installed
// OpenCode v2.1.1 on 2026-10-23 (docs/osa/OPENCODE.md), not assumed:
//
//   opencode run --standalone --format json [--model provider/model#variant] [--auto]   (the prompt is read from stdin; a 200 KB prompt works)
//
// * `--standalone` starts a private server for the call instead of using the background service, so a call never shares state with it.
// * `--format json` prints one JSON event per line: step_start, text, tool_use, step_finish, error.
// * OpenCode runs shell and edit tools WITHOUT asking by default, so a read-only text call must switch them off. It is done through
//   the OPENCODE_CONFIG_CONTENT environment variable (permission rules; verified: with bash denied the model reports it has no shell).
// * OpenCode serves many vendors' models (`opencode models --standalone` lists them), which makes it the cheapest route to "any model".
// * Its `websearch` tool answered "Web search cancelled" in every headless run here, so web search is NOT claimed; `webfetch` works.

import { InternalError, TurnTimeoutError } from "../domain/errors.ts";
import type { ModelTier } from "../domain/tiers.ts";
import type { ProviderId, RawInvocationResult, TurnOutcome, TurnRequest } from "../domain/run.ts";
import type { Invocation, PreflightReport, ProviderAdapter } from "../ports/provider-adapter.ts";
import type { TextCapabilities, TextCapableAdapter, TextOutcome, TextRequest } from "../ports/text-provider.ts";
import { buildProviderPreflightReport } from "../verify/preflight.ts";

/** OpenCode has no effort flag of its own (a model variant is chosen with `#variant` in the model name); one neutral value. */
export const OPENCODE_EFFORT_VALUES = ["default"] as const;

/** Tools a read-only text call must not have. Names verified against OpenCode's own tool list (`edit`, `write`, `shell`, `execute` ...). */
const DENY_ALWAYS = ["edit", "write", "task", "subagent", "question", "websearch", "webfetch", "execute"] as const;

/** The permission rules for one text call, as the JSON OpenCode reads from OPENCODE_CONFIG_CONTENT. Pure. */
export function textPermissionConfig(req: Pick<TextRequest, "execute">): string {
  const permission: Record<string, "deny"> = {};
  for (const tool of DENY_ALWAYS) permission[tool] = "deny";
  // A call that must exercise a built project (the application check) keeps its shell; every other call has none.
  if (req.execute !== true) permission["bash"] = "deny";
  return JSON.stringify({ permission });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One parsed JSON event line, or null. */
function parseEvent(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface Parsed {
  /** The text of the final assistant message (what the model said last, after any tool use). */
  readonly answer: string | null;
  readonly errorMessage: string | null;
  readonly finished: boolean;
}

/** Reads OpenCode's JSON event stream. Pure. */
export function parseOpenCodeEvents(stdout: string): Parsed {
  const byMessage = new Map<string, string[]>();
  const order: string[] = [];
  let errorMessage: string | null = null;
  let finished = false;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const ev = parseEvent(line);
    if (ev === null) continue;
    const type = ev["type"];
    const part = isRecord(ev["part"]) ? ev["part"] : null;
    if (type === "text" && part !== null && typeof part["text"] === "string") {
      const id = typeof part["messageID"] === "string" ? part["messageID"] : "m";
      if (!byMessage.has(id)) {
        byMessage.set(id, []);
        order.push(id);
      }
      (byMessage.get(id) as string[]).push(part["text"]);
    } else if (type === "step_finish" && part !== null && part["reason"] !== "tool-calls") {
      finished = true;
    } else if (type === "error" && isRecord(ev["error"])) {
      const m = ev["error"]["message"];
      errorMessage = typeof m === "string" ? m : "OpenCode reported an error";
    }
  }
  const last = order.at(-1);
  const answer = last === undefined ? null : (byMessage.get(last) as string[]).join("").trim();
  return { answer: answer === "" ? null : answer, errorMessage, finished };
}

/** Provider adapter for OpenCode's headless `run`. */
export class OpenCodeCliAdapter implements ProviderAdapter, TextCapableAdapter {
  readonly id: ProviderId = "opencode-cli";
  readonly textCapabilities: TextCapabilities = { webSearch: false, execute: true, webContainment: "read-only-files" };

  preflight(): Promise<PreflightReport> {
    return buildProviderPreflightReport("opencode-cli");
  }

  resolveEffort(tier: ModelTier): string {
    if (tier.length === 0) throw new InternalError("OpenCodeCliAdapter.resolveEffort: empty tier");
    return "default";
  }

  /** A build turn edits files and runs commands; `--auto` approves whatever is not explicitly denied. */
  buildInvocation(req: TurnRequest): Invocation {
    const args = ["run", "--standalone", "--format", "json", "--auto"];
    if (req.modelOverride !== null) args.push("--model", req.modelOverride);
    return { command: "opencode", args, env: {}, cwd: req.repoDir, stdin: req.prompt };
  }

  interpretResult(raw: RawInvocationResult): TurnOutcome {
    if (raw.timedOut) return { ok: false, record: null, failure: new TurnTimeoutError("opencode-cli turn timed out", { exitCode: raw.exitCode, signal: raw.signal }) };
    const parsed = parseOpenCodeEvents(raw.stdout);
    if (parsed.errorMessage !== null) return { ok: false, record: null, failure: new InternalError(`opencode-cli: ${parsed.errorMessage}`, { exitCode: raw.exitCode }) };
    if (raw.exitCode !== 0) return { ok: false, record: null, failure: new InternalError(`opencode-cli exited ${String(raw.exitCode)}`, { exitCode: raw.exitCode, signal: raw.signal, stderrExcerpt: raw.stderr.slice(0, 2000) }) };
    if (!parsed.finished) return { ok: false, record: null, failure: new InternalError("opencode-cli produced no finished step", { stdoutExcerpt: raw.stdout.slice(0, 2000) }) };
    return { ok: true, record: null, failure: null };
  }

  /** A text call: no permission is auto-approved and the tools that change anything are switched off. */
  buildTextInvocation(req: TextRequest): Invocation {
    const args = ["run", "--standalone", "--format", "json"];
    if (req.modelOverride !== null) args.push("--model", req.modelOverride);
    return { command: "opencode", args, env: { OPENCODE_CONFIG_CONTENT: textPermissionConfig(req) }, cwd: req.cwd, stdin: req.prompt };
  }

  interpretTextResult(raw: RawInvocationResult): TextOutcome {
    const turn = this.interpretResult(raw);
    if (!turn.ok) return { ok: false, text: null, failure: turn.failure };
    const parsed = parseOpenCodeEvents(raw.stdout);
    if (parsed.answer === null) {
      return { ok: false, text: null, failure: new InternalError("opencode-cli text call produced no answer text", { stdoutExcerpt: raw.stdout.slice(0, 2000) }) };
    }
    return { ok: true, text: parsed.answer, failure: null };
  }
}
