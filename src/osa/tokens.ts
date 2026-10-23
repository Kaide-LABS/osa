// Per-run token accounting (Suite 7a). OSA's code-index work is judged by how much of a run's context it can actually save, and that is
// capped by how much of the context is file exploration in the first place -- so the share is measured, per phase and per run, in six
// categories, and logged as `token_breakdown` events:
//
//   file_exploration  reads, greps, globs, directory listings, git inspection, code_search results
//   research_input    web search/fetch results and the prompts of research stages
//   handoffs          step-14 notes, executor context, turn instructions
//   spec_prd          the locked PRD, the spec and prompts of the stages that author or review them
//   tool_output       everything else a tool returned (test runs, builds, commits, edits)
//   model_output      what the model itself produced: reasoning, answers, code and commands it wrote
//
// Numbers are ESTIMATES (characters / 4, the same rule the trimmer uses); the providers' own reported usage is recorded beside them so the
// estimate can be calibrated. Sources: Claude Code's session transcript (found through the `session_id` in its JSON result), Codex CLI's
// `--json` event stream, and, for stages that only exchange text, the prompt and reply themselves. The prior spike counted every Bash
// command as exploration; here a command is classified by what it does.

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import type { RawInvocationResult } from "../domain/run.ts";
import type { TextCall } from "../ports/text-provider.ts";
import type { runProcess } from "../util/exec.ts";
import type { EventSink } from "./events.ts";

export const TOKEN_CATEGORIES = ["file_exploration", "research_input", "handoffs", "spec_prd", "tool_output", "model_output"] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];
export type Tally = Record<TokenCategory, number>;

export const emptyTally = (): Tally => ({ file_exploration: 0, research_input: 0, handoffs: 0, spec_prd: 0, tool_output: 0, model_output: 0 });

/** Characters / 4, rounded up. */
export const tokensOf = (s: unknown): number => {
  if (s === null || s === undefined) return 0;
  const text = typeof s === "string" ? s : JSON.stringify(s);
  return Math.ceil(text.length / 4);
};

const EXPLORE_CMD = /^\s*(?:(?:cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?(?:\s+-\w+)*\s+-command|bash\s+-lc|sh\s+-c)\s+)?["']?\s*(?:ls|dir|find|fd|grep|egrep|rg|ag|cat|bat|head|tail|more|less|type|tree|wc|file|stat|readlink|realpath|pwd|cd|get-content|gc|select-string|sls|get-childitem|gci|git\s+(?:ls-files|log|show|diff|status|grep|blame|rev-parse|branch|ls-tree|cat-file)|sed\s+-n|awk|cut|sort|uniq|nl|od|xxd|jq|test\s+-[a-z])\b/i;

const SHELL_WRAPPER = /^\s*["']?[^"'\s]*(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?["']?\s+(?:-\w+\s+)*(?:-command|-c|-lc|\/c)\s+["']?/i;

/** Is this shell command reading/inspecting the project (as opposed to running, building, testing or changing it)? Pure. */
export function isExplorationCommand(command: string): boolean {
  return EXPLORE_CMD.test(command.replace(SHELL_WRAPPER, ""));
}

/** Does this tool call READ or SEARCH the repository (whatever it reads)? Counts exploration CALLS; the tokens go by {@link categoryForTool}. Pure. */
export function isReadLikeCall(name: string, input: unknown): boolean {
  const n = name.toLowerCase();
  if (["read", "notebookread", "grep", "glob", "ls", "list"].includes(n)) return true;
  if (n === "bash" || n === "powershell" || n === "shell") return isExplorationCommand(typeof input === "object" && input !== null ? String((input as Record<string, unknown>)["command"] ?? "") : "");
  return n.startsWith("mcp__") && categoryForTool(name, input) === "file_exploration";
}

/** The path a Read-like tool call targets, if any. */
function targetPath(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const o = input as Record<string, unknown>;
  return String(o["file_path"] ?? o["path"] ?? o["notebook_path"] ?? "");
}

const SPEC_PRD_PATH = /(?:baby-prd|baby_prd)\.md$|PHASE_\d+_SPEC\.md$|\/spec\/context\.md$|(?:^|\/)context\.md$|(?:^|\/)[A-Za-z0-9_-]*PRD[A-Za-z0-9_-]*\.md$/i;
const HANDOFF_PATH = /step14\/|executor-context|handoff|summary\.md$|COMPREHENSION\.md$|BUILD_COMPLETE\.md$/i;

/** Which category does the result of reading `path` belong to? Pure. */
export function categoryForRead(path: string): TokenCategory {
  const p = path.split(String.fromCharCode(92)).join("/");
  if (HANDOFF_PATH.test(p)) return "handoffs";
  if (SPEC_PRD_PATH.test(p)) return "spec_prd";
  return "file_exploration";
}

/** The category of a tool RESULT. Pure. */
export function categoryForTool(name: string, input: unknown): TokenCategory {
  const n = name.toLowerCase();
  if (n === "read" || n === "notebookread") return categoryForRead(targetPath(input));
  if (n === "grep" || n === "glob" || n === "ls" || n === "list") return "file_exploration";
  if (n === "bash" || n === "powershell" || n === "shell") {
    const cmd = typeof input === "object" && input !== null ? String((input as Record<string, unknown>)["command"] ?? "") : "";
    return isExplorationCommand(cmd) ? "file_exploration" : "tool_output";
  }
  if (n === "websearch" || n === "webfetch" || n === "web_search" || n === "web_fetch") return "research_input";
  if (n.startsWith("mcp__")) return /search|snippet|outline|architecture|trace|query_graph|memory_read/.test(n) ? "file_exploration" : "tool_output";
  return "tool_output";
}

/** What a provider reported about its own usage (calibration data). */
export interface ReportedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}
export const noUsage: ReportedUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

/** One parsed provider run. */
export interface Parsed {
  readonly tally: Tally;
  readonly usage: ReportedUsage;
  /** Number of tool calls seen. */
  readonly toolCalls: number;
  /** Number of the tool calls that were file exploration. */
  readonly explorationCalls: number;
  /** Tokens of the model's final answer (already counted from the reply for text-only exchanges). */
  readonly finalText: number;
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  content?: unknown;
}

/**
 * Categorises a Claude Code session transcript (JSONL). Pure. `firstUserCategory` is where the opening prompt goes (a turn's instructions are
 * "handoffs"; for a text call the caller counts the prompt itself and passes `null` to skip it).
 */
export function parseClaudeTranscript(jsonl: string, firstUserCategory: TokenCategory | null = "handoffs"): Parsed {
  const tally = emptyTally();
  const tools = new Map<string, { name: string; input: unknown }>();
  let toolCalls = 0;
  let explorationCalls = 0;
  let seenFirstUser = false;
  let lastAssistantText = 0;
  let usage = noUsage;
  for (const line of jsonl.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let r: { type?: string; message?: { role?: string; content?: unknown; usage?: Record<string, number> }; isSidechain?: boolean };
    try {
      r = JSON.parse(line) as typeof r;
    } catch {
      continue;
    }
    if (r.type !== "user" && r.type !== "assistant") continue;
    const content = r.message?.content;
    const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Block[]) : [];
    if (r.type === "assistant" && r.message?.usage !== undefined) {
      const u = r.message.usage;
      usage = {
        inputTokens: usage.inputTokens + (u["input_tokens"] ?? 0),
        outputTokens: usage.outputTokens + (u["output_tokens"] ?? 0),
        cacheReadTokens: usage.cacheReadTokens + (u["cache_read_input_tokens"] ?? 0),
        cacheCreationTokens: usage.cacheCreationTokens + (u["cache_creation_input_tokens"] ?? 0),
      };
    }
    for (const b of blocks) {
      if (b.type === "tool_use") {
        toolCalls += 1;
        tools.set(String(b.id), { name: String(b.name ?? "?"), input: b.input });
        tally.model_output += tokensOf(b.input);
        if (isReadLikeCall(String(b.name ?? ""), b.input)) explorationCalls += 1;
      } else if (b.type === "tool_result") {
        const t = tools.get(String(b.tool_use_id));
        tally[t === undefined ? "tool_output" : categoryForTool(t.name, t.input)] += tokensOf(b.content);
      } else if (b.type === "text" || b.type === "thinking") {
        const n = tokensOf(b.text ?? b.thinking ?? "");
        if (r.type === "assistant") {
          tally.model_output += n;
          if (b.type === "text") lastAssistantText = n;
        } else if (!seenFirstUser) {
          seenFirstUser = true;
          if (firstUserCategory !== null) tally[firstUserCategory] += n;
        } else {
          tally.handoffs += n; // system reminders, queued instructions
        }
      }
    }
  }
  return { tally, usage, toolCalls, explorationCalls, finalText: lastAssistantText };
}

/** Categorises a Codex CLI `--json` event stream. Pure. */
export function parseCodexEvents(stdout: string): Parsed {
  const tally = emptyTally();
  let finalText = 0;
  let usage = noUsage;
  let toolCalls = 0;
  let explorationCalls = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let e: { type?: string; item?: Record<string, unknown>; usage?: Record<string, number> };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    if (e.type === "turn.completed" && e.usage !== undefined) {
      usage = {
        inputTokens: usage.inputTokens + (e.usage["input_tokens"] ?? 0),
        outputTokens: usage.outputTokens + (e.usage["output_tokens"] ?? 0),
        cacheReadTokens: usage.cacheReadTokens + (e.usage["cached_input_tokens"] ?? 0),
        cacheCreationTokens: usage.cacheCreationTokens,
      };
    }
    if (e.type !== "item.completed" || e.item === undefined) continue;
    const it = e.item;
    switch (it["type"]) {
      case "command_execution": {
        toolCalls += 1;
        const cmd = String(it["command"] ?? "");
        const cat = categoryForTool("shell", { command: cmd });
        if (isReadLikeCall("shell", { command: cmd })) explorationCalls += 1;
        tally.model_output += tokensOf(cmd);
        tally[cat] += tokensOf(it["aggregated_output"]);
        break;
      }
      case "mcp_tool_call": {
        toolCalls += 1;
        const name = `mcp__${String(it["server"] ?? "")}__${String(it["tool"] ?? "")}`;
        const cat = categoryForTool(name, it["arguments"]);
        if (cat === "file_exploration") explorationCalls += 1;
        tally.model_output += tokensOf(it["arguments"]);
        tally[/web/i.test(String(it["tool"] ?? "")) ? "research_input" : cat] += tokensOf(it["result"]);
        break;
      }
      case "web_search":
        toolCalls += 1;
        tally.research_input += tokensOf(it);
        break;
      case "file_change":
        toolCalls += 1;
        tally.tool_output += tokensOf(it["changes"]);
        break;
      case "agent_message":
        finalText = tokensOf(it["text"]);
        tally.model_output += finalText;
        break;
      case "reasoning":
        tally.model_output += tokensOf(it["text"]);
        break;
      default:
        break;
    }
  }
  return { tally, usage, toolCalls, explorationCalls, finalText };
}

/** Where a text call's PROMPT belongs. Pure. */
export function categoryForPurpose(purpose: string): TokenCategory {
  if (purpose.startsWith("research:") || purpose === "research-crosscheck" || purpose === "github-lookup-summary") return "research_input";
  if (purpose.startsWith("step14-summary") || purpose === "turn") return "handoffs";
  return "spec_prd";
}

/** A finished tally with shares. */
export interface Breakdown {
  readonly categories: Tally;
  readonly total: number;
  /** Share of the total in each category (0..1). */
  readonly shares: Tally;
  readonly calls: number;
  readonly toolCalls: number;
  readonly explorationCalls: number;
  readonly reported: ReportedUsage;
  readonly byProvider: Record<string, ReportedUsage>;
}

const addUsage = (a: ReportedUsage, b: ReportedUsage): ReportedUsage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens });

interface Scope {
  tally: Tally;
  calls: number;
  toolCalls: number;
  explorationCalls: number;
  reported: ReportedUsage;
  byProvider: Map<string, ReportedUsage>;
}
const newScope = (): Scope => ({ tally: emptyTally(), calls: 0, toolCalls: 0, explorationCalls: 0, reported: noUsage, byProvider: new Map() });

/** Where the provider CLIs keep Claude session transcripts. */
export function claudeProjectsDir(): string {
  return `${homedir().split(String.fromCharCode(92)).join("/")}/.claude/projects`;
}

/** Finds `<sessionId>.jsonl` under any project directory. */
export function findClaudeTranscript(sessionId: string, root = claudeProjectsDir()): string | null {
  if (!/^[0-9a-f-]{16,64}$/i.test(sessionId) || !existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const p = `${root}/${d}/${sessionId}.jsonl`;
    if (existsSync(p)) return p;
  }
  return null;
}

/** Context carried (through async calls) to the process-level recorder. */
export interface CallContext {
  readonly purpose: string | null;
}
export const callContext = new AsyncLocalStorage<CallContext>();

/** Accumulates the categories per phase and per run. */
export class TokenAccountant {
  private readonly run = newScope();
  private readonly phases = new Map<number, Scope>();
  private phase: number | null = null;
  private readonly transcriptRoot: string;

  constructor(opts: { readonly transcriptRoot?: string } = {}) {
    this.transcriptRoot = opts.transcriptRoot ?? claudeProjectsDir();
  }

  setPhase(phase: number | null): void {
    this.phase = phase;
  }

  private scopes(): Scope[] {
    const s = [this.run];
    if (this.phase !== null) {
      let p = this.phases.get(this.phase);
      if (p === undefined) {
        p = newScope();
        this.phases.set(this.phase, p);
      }
      s.push(p);
    }
    return s;
  }

  add(category: TokenCategory, tokens: number): void {
    for (const s of this.scopes()) s.tally[category] += tokens;
  }

  /** Records the prompt and reply of a text-only exchange. */
  recordText(purpose: string, promptChars: number, replyChars: number): void {
    for (const s of this.scopes()) {
      s.calls += 1;
      s.tally[categoryForPurpose(purpose)] += Math.ceil(promptChars / 4);
      s.tally.model_output += Math.ceil(replyChars / 4);
    }
  }

  /** Records what a provider process did, from its raw output. Never throws. */
  recordProcess(command: string, stdin: string | null | undefined, raw: RawInvocationResult, purpose: string | null): void {
    try {
      const base = command.split(String.fromCharCode(92)).join("/").split("/").pop()?.toLowerCase().replace(/\.(exe|cmd)$/, "") ?? command;
      const isTurn = purpose === null || purpose === "turn";
      let parsed: Parsed | null = null;
      let provider = base;
      if (base === "claude") {
        provider = "claude-code";
        let sessionId = "";
        try {
          sessionId = String((JSON.parse(raw.stdout) as { session_id?: unknown }).session_id ?? "");
        } catch {
          sessionId = "";
        }
        const file = sessionId === "" ? null : findClaudeTranscript(sessionId, this.transcriptRoot);
        if (file !== null) parsed = parseClaudeTranscript(readFileSync(file, "utf8"), isTurn ? "handoffs" : null);
      } else if (base === "codex") {
        provider = "codex-cli";
        parsed = parseCodexEvents(raw.stdout);
      }
      for (const s of this.scopes()) {
        if (isTurn) {
          s.calls += 1;
          if (parsed === null) {
            s.tally.handoffs += tokensOf(stdin ?? "");
            s.tally.model_output += tokensOf(raw.stdout);
          }
        }
        if (parsed !== null) {
          for (const c of TOKEN_CATEGORIES) s.tally[c] += c === "model_output" && !isTurn ? Math.max(0, parsed.tally[c] - parsed.finalText) : parsed.tally[c];
          s.toolCalls += parsed.toolCalls;
          s.explorationCalls += parsed.explorationCalls;
          s.reported = addUsage(s.reported, parsed.usage);
          s.byProvider.set(provider, addUsage(s.byProvider.get(provider) ?? noUsage, parsed.usage));
        }
      }
    } catch {
      /* accounting must never break a run */
    }
  }

  /** The breakdown for one phase, or for the whole run when `phase` is null. */
  breakdown(phase: number | null = null): Breakdown {
    const s = phase === null ? this.run : (this.phases.get(phase) ?? newScope());
    const total = TOKEN_CATEGORIES.reduce((n, c) => n + s.tally[c], 0);
    const shares = emptyTally();
    for (const c of TOKEN_CATEGORIES) shares[c] = total === 0 ? 0 : Math.round((s.tally[c] / total) * 1000) / 1000;
    return { categories: { ...s.tally }, total, shares, calls: s.calls, toolCalls: s.toolCalls, explorationCalls: s.explorationCalls, reported: s.reported, byProvider: Object.fromEntries(s.byProvider) };
  }

  /** Emits `token_breakdown` for a phase, or for the run (`phase: null`). */
  async emit(events: EventSink, phase: number | null): Promise<void> {
    const b = this.breakdown(phase);
    await events.emit("token_breakdown", { scope: phase === null ? "run" : `phase-${String(phase)}`, ...b });
  }
}

/** Wraps a TextCall so each exchange is recorded (prompt by purpose, reply as model output) and the purpose is visible to the process-level recorder. */
export function accountedTextCall(inner: TextCall, acct: TokenAccountant): TextCall {
  return (provider, req, purpose) =>
    callContext.run({ purpose }, async () => {
      const r = await inner(provider, req, purpose);
      acct.recordText(purpose, req.prompt.length, r.outcome.text?.length ?? 0);
      return r;
    });
}

/** Wraps a process runner so every provider process feeds the accountant. */
export function accountedRunProcess(inner: typeof runProcess, acct: TokenAccountant): typeof runProcess {
  return async (o) => {
    const raw = await inner(o);
    acct.recordProcess(o.command, o.stdin, raw, callContext.getStore()?.purpose ?? null);
    return raw;
  };
}
