import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { RawInvocationResult } from "../domain/run.ts";
import { MemoryEventSink } from "./events.ts";
import { fakeModel } from "./fixtures.test.ts";
import { TOKEN_CATEGORIES, TokenAccountant, accountedRunProcess, accountedTextCall, callContext, categoryForPurpose, categoryForRead, categoryForTool, emptyTally, isExplorationCommand, parseClaudeTranscript, parseCodexEvents, tokensOf } from "./tokens.ts";

const raw = (stdout: string): RawInvocationResult => ({ exitCode: 0, signal: null, stdout, stderr: "", durationMs: 1, timedOut: false });
const chars = (n: number): string => "x".repeat(n);

test("isExplorationCommand: reads/greps/listings are exploration; tests, builds, installs and commits are not (the spike counted every Bash call as exploration)", () => {
  for (const c of ["ls -la src", "grep -rn lockNow src", "rg --files", "cat src/a.ts", "git log --oneline", "git diff HEAD~1", "git ls-files", "Get-Content a.ts", "Select-String -Path . -Pattern x", "head -50 f.md", "find . -name '*.ts'", 'powershell.exe -Command "Get-ChildItem src"', "sed -n 1,40p x.ts", "dir"]) assert.equal(isExplorationCommand(c), true, c);
  for (const c of ["npm test", "node --test src/x.test.ts", "git commit -m x", "git add -A", "npm install", "python app.py", "mkdir out", "tsc -p .", "echo hi > a.txt", "cargo build"]) assert.equal(isExplorationCommand(c), false, c);
});

test("categoryForRead/Tool: spec and PRD files are spec_prd, handoffs are handoffs, other reads are exploration; web is research; search MCP tools are exploration", () => {
  assert.equal(categoryForRead("runs/abc/baby-prd.md"), "spec_prd");
  assert.equal(categoryForRead("runs/abc/spec/PHASE_1_SPEC.md"), "spec_prd");
  assert.equal(categoryForRead("runs/abc/spec/context.md"), "spec_prd");
  assert.equal(categoryForRead("runs/abc/step14/executor-context.md"), "handoffs");
  assert.equal(categoryForRead("C:\\x\\runs\\a\\step14\\phase-1-handoff.md".split("\\").join(String.fromCharCode(92))), "handoffs");
  assert.equal(categoryForRead("src/osa/lock.ts"), "file_exploration");
  assert.equal(categoryForTool("Read", { file_path: "runs/a/baby-prd.md" }), "spec_prd");
  assert.equal(categoryForTool("Read", { file_path: "src/a.ts" }), "file_exploration");
  assert.equal(categoryForTool("Grep", {}), "file_exploration");
  assert.equal(categoryForTool("Bash", { command: "ls src" }), "file_exploration");
  assert.equal(categoryForTool("Bash", { command: "npm test" }), "tool_output");
  assert.equal(categoryForTool("WebFetch", {}), "research_input");
  assert.equal(categoryForTool("mcp__osa__code_search", {}), "file_exploration");
  assert.equal(categoryForTool("mcp__osa__doctor", {}), "tool_output");
  assert.equal(categoryForTool("Edit", {}), "tool_output");
});

function transcript(): string {
  const rec = (type: string, content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type, message: { role: type, content, ...extra } });
  return [
    rec("user", chars(400)), // the opening instructions
    rec("assistant", [{ type: "thinking", thinking: chars(80) }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/a.ts" } }], { usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 4000 } }),
    rec("user", [{ type: "tool_result", tool_use_id: "t1", content: chars(4000) }]),
    rec("assistant", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }, { type: "tool_use", id: "t3", name: "Bash", input: { command: "grep -rn foo src" } }]),
    rec("user", [{ type: "tool_result", tool_use_id: "t2", content: chars(800) }, { type: "tool_result", tool_use_id: "t3", content: chars(2000) }]),
    rec("assistant", [{ type: "tool_use", id: "t4", name: "Read", input: { file_path: "runs/x/spec/PHASE_1_SPEC.md" } }]),
    rec("user", [{ type: "tool_result", tool_use_id: "t4", content: chars(1200) }]),
    rec("assistant", [{ type: "text", text: chars(120) }], { usage: { input_tokens: 500, output_tokens: 30 } }),
    "not json",
    JSON.stringify({ type: "queue-operation" }),
  ].join("\n");
}

test("parseClaudeTranscript: results are attributed to the tool that produced them; the opening prompt, thinking and answers are what they are; usage is summed", () => {
  const p = parseClaudeTranscript(transcript());
  assert.equal(p.tally.file_exploration, 1000 + 500, "Read(src/a.ts) 4000 chars + grep 2000 chars");
  assert.equal(p.tally.spec_prd, 300, "the spec file read");
  assert.equal(p.tally.tool_output, 200, "npm test output");
  assert.equal(p.tally.handoffs, 100, "the opening instructions");
  assert.equal(p.tally.model_output, 20 + 30 + (tokensOf({ file_path: "src/a.ts" }) + tokensOf({ command: "npm test" }) + tokensOf({ command: "grep -rn foo src" }) + tokensOf({ file_path: "runs/x/spec/PHASE_1_SPEC.md" })), "thinking + final text + what it wrote into tool calls");
  assert.equal(p.toolCalls, 4);
  assert.equal(p.explorationCalls, 3, "Read, grep, Read(spec) -- reads count as exploration CALLS even when the result is categorised as spec");
  assert.deepEqual(p.usage, { inputTokens: 1500, outputTokens: 80, cacheReadTokens: 4000, cacheCreationTokens: 0 });
  assert.equal(p.finalText, 30);
  assert.equal(parseClaudeTranscript(transcript(), null).tally.handoffs, 0, "a text call's prompt is counted by the caller, not from the transcript");
});

test("parseCodexEvents: commands are classified by what they do; messages are model output; usage comes from turn.completed", () => {
  const ev = (o: unknown) => JSON.stringify(o);
  const out = [
    ev({ type: "item.completed", item: { type: "command_execution", command: '"powershell.exe" -Command "Get-Content src/a.ts"', aggregated_output: chars(4000) } }),
    ev({ type: "item.completed", item: { type: "command_execution", command: "npm test", aggregated_output: chars(800) } }),
    ev({ type: "item.completed", item: { type: "mcp_tool_call", server: "x", tool: "web_run", arguments: { q: "a" }, result: chars(2400) } }),
    ev({ type: "item.completed", item: { type: "file_change", changes: [{ path: "a.ts" }] } }),
    ev({ type: "item.completed", item: { type: "agent_message", text: chars(200) } }),
    ev({ type: "turn.completed", usage: { input_tokens: 9000, cached_input_tokens: 7000, output_tokens: 400 } }),
    "garbage",
  ].join("\n");
  const p = parseCodexEvents(out);
  assert.equal(p.tally.file_exploration, 1000);
  assert.equal(p.tally.tool_output, 200 + tokensOf([{ path: "a.ts" }]));
  assert.equal(p.tally.research_input, 600);
  assert.equal(p.finalText, 50);
  assert.deepEqual(p.usage, { inputTokens: 9000, outputTokens: 400, cacheReadTokens: 7000, cacheCreationTokens: 0 });
  assert.equal(p.explorationCalls, 1);
  assert.equal(p.toolCalls, 4);
});

test("categoryForPurpose: research stages are research_input; step-14 and turns are handoffs; authoring and review stages are spec_prd", () => {
  for (const [p, c] of [["research:docs-node", "research_input"], ["research-crosscheck", "research_input"], ["github-lookup-summary", "research_input"], ["step14-summary-2", "handoffs"], ["turn", "handoffs"], ["spec", "spec_prd"], ["intake", "spec_prd"], ["implication", "spec_prd"], ["application", "spec_prd"], ["plain-choices", "spec_prd"]] as const) assert.equal(categoryForPurpose(p), c, p);
});

test("the accountant keeps per-phase and per-run tallies, shares sum to ~1, and emits token_breakdown events", async () => {
  const a = new TokenAccountant();
  a.recordText("research:x", 4000, 400);
  a.setPhase(1);
  a.recordText("step14-summary-1", 800, 200);
  a.add("file_exploration", 500);
  a.setPhase(2);
  a.add("file_exploration", 100);
  a.add("tool_output", 100);
  a.setPhase(null);
  const run = a.breakdown(null);
  assert.equal(run.categories.research_input, 1000);
  assert.equal(run.categories.handoffs, 200);
  assert.equal(run.categories.model_output, 100 + 50);
  assert.equal(run.categories.file_exploration, 600);
  assert.equal(run.total, 1000 + 200 + 150 + 600 + 100);
  assert.ok(Math.abs(TOKEN_CATEGORIES.reduce((n, c) => n + run.shares[c], 0) - 1) < 0.01);
  assert.equal(a.breakdown(1).categories.file_exploration, 500);
  assert.equal(a.breakdown(2).categories.file_exploration, 100);
  assert.equal(a.breakdown(2).categories.research_input, 0, "pre-build work is not attributed to a phase");
  assert.deepEqual(a.breakdown(7).categories, emptyTally());
  const events = new MemoryEventSink();
  await a.emit(events, 1);
  await a.emit(events, null);
  assert.deepEqual(events.events.map((e) => [e.event, e.data["scope"]]), [["token_breakdown", "phase-1"], ["token_breakdown", "run"]]);
  assert.equal((events.events[1]?.data["categories"] as Record<string, number>)["file_exploration"], 600);
});

test("accountedTextCall counts prompt and reply by purpose; the purpose reaches the process-level recorder; accounting never breaks a call", async () => {
  const a = new TokenAccountant();
  const inner = fakeModel().call;
  const call = accountedTextCall(inner, a);
  let seenPurpose: string | null = "unset";
  const wrapped = accountedRunProcess(() => Promise.resolve(raw("")), a);
  const r = await callContext.run({ purpose: "spec" }, async () => {
    seenPurpose = callContext.getStore()?.purpose ?? null;
    await wrapped({ command: "claude", args: [], cwd: ".", timeoutMs: 1 });
    return call("claude-code", { prompt: chars(2000), cwd: ".", timeoutMs: 1, tier: "research-grade", webSearch: false, modelOverride: null }, "spec");
  });
  assert.equal(r.outcome.ok, true);
  assert.equal(seenPurpose, "spec");
  assert.ok(a.breakdown().categories.spec_prd >= 500);
  // a process whose output is garbage must not throw
  const broken = accountedRunProcess(() => Promise.resolve(raw("{not json")), a);
  await broken({ command: "claude", args: [], cwd: ".", timeoutMs: 1 });
  await broken({ command: "codex", args: [], cwd: ".", timeoutMs: 1 });
});

test("a real Claude transcript on disk is found through the JSON result's session_id and categorised for a turn", async () => {
  const root = mkdtempSync(`${tmpdir()}/osa-claude-projects-`);
  await mkdir(`${root}/some-project`, { recursive: true });
  const sid = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  await writeFile(`${root}/some-project/${sid}.jsonl`, transcript(), "utf8");
  const a = new TokenAccountant({ transcriptRoot: root });
  a.setPhase(1);
  a.recordProcess("claude", chars(400), raw(JSON.stringify({ result: "ok", session_id: sid })), null);
  const b = a.breakdown(1);
  assert.equal(b.categories.file_exploration, 1500);
  assert.equal(b.categories.handoffs, 100);
  assert.equal(b.explorationCalls, 3);
  assert.equal(b.reported.cacheReadTokens, 4000);
  assert.equal(b.byProvider["claude-code"]?.inputTokens, 1500);
  // unknown session: falls back to the sizes it can see
  a.recordProcess("claude", chars(800), raw(JSON.stringify({ result: "ok", session_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" })), null);
  assert.ok(a.breakdown(1).categories.handoffs >= 100 + 200);
});
