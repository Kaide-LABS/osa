import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawInvocationResult, TurnRequest } from "../domain/run.ts";
import { assertAdapterConformance } from "./conformance.ts";
import { AntigravityCliAdapter } from "./antigravity-cli.ts";

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return { runId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", phase: 11, turnIndex: 0, archetype: "executor", provider: "antigravity-cli", tier: "high-volume-low-effort", modelOverride: null, repoDir: "/repo", specRef: { path: "PHASE_11_SPEC.md", sha256: "a".repeat(64) }, priorRecord: null, prompt: "/loop\n\"quoted\"\\slash", timeoutMs: 1_800_000, babyPrdPath: "a.md", contextPath: "b.md", expectedArtifactPath: null, chatLogId: "run", chatLogGitignored: true, ...overrides };
}
function raw(overrides: Partial<RawInvocationResult> = {}): RawInvocationResult { return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...overrides }; }

test("AntigravityCliAdapter conforms", () => assertAdapterConformance(new AntigravityCliAdapter(), request()));
test("preflight reports the Antigravity identity", async () => {
  const report = await new AntigravityCliAdapter().preflight();
  assert.equal(report.provider, "antigravity-cli");
});
test("buildInvocation uses NDJSON stdin and pinned flags", () => {
  const invocation = new AntigravityCliAdapter().buildInvocation(request());
  assert.deepStrictEqual(invocation.args, ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--dangerously-skip-permissions", "--effort", "low", "--print-timeout", "1800000ms", "--print="]);
  assert.equal(invocation.args.at(-1), "--print=", "--print must carry an explicit empty attached value -- agy rejects both a bare --print and a --print with a non-empty value alongside --input-format stream-json");
  assert.deepStrictEqual(JSON.parse(invocation.stdin as string), { event: "user", message: { content: "/loop\n\"quoted\"\\slash" } });
});
test("interpretResult requires SUCCESS result event", () => {
  const adapter = new AntigravityCliAdapter();
  assert.equal(adapter.interpretResult(raw()).ok, false);
  assert.equal(adapter.interpretResult(raw({ stdout: JSON.stringify({ event: "result", status: "WAITING" }) })).ok, false);
  assert.equal(adapter.interpretResult(raw({ stdout: JSON.stringify({ event: "result", status: "SUCCESS" }) })).ok, true);
});

// Captured from the installed `agy` 1.3.3 (2026-10-17) running the adapter's own text invocation with the prompt
// "Reply with exactly the single word OK and nothing else." -- the `init.tools` list is elided. This exact stream
// was reported as `antigravity-cli reported result status undefined` before the fix (docs/osa/ANTIGRAVITY.md).
const AGY_1_3_3_STDOUT = [
  { event: "init", conversation_id: "a5038539", init: { cwd: "C:\\repo", tools: ["run_command", "search_web"], permission_mode: "request-review" } },
  { event: "step_update", step_update: { conversation_id: "a5038539", step_index: 0, state: "DONE", step_type: "user_input" } },
  { event: "step_update", step_update: { conversation_id: "a5038539", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "OK" } },
  { event: "step_update", step_update: { conversation_id: "a5038539", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "\n", duration_seconds: 3.5 } },
  { event: "result", result: { conversation_id: "a5038539", status: "SUCCESS", response: "OK\n", duration_seconds: 3.9, num_turns: 1, usage: { input_tokens: 11576, output_tokens: 1, total_tokens: 11577 } } },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

test("REGRESSION agy 1.3.x: a SUCCESS result nested under `result` is a success (it was misreported as `status undefined`)", () => {
  const adapter = new AntigravityCliAdapter();
  const outcome = adapter.interpretResult(raw({ stdout: AGY_1_3_3_STDOUT }));
  assert.equal(outcome.ok, true, String(outcome.failure?.message));
});

test("agy 1.3.x nested non-SUCCESS statuses are still failures, with the real status and error in the message/details", () => {
  const adapter = new AntigravityCliAdapter();
  const waiting = adapter.interpretResult(raw({ stdout: JSON.stringify({ event: "result", result: { status: "WAITING" } }) }));
  assert.equal(waiting.ok, false);
  assert.match(waiting.failure?.message ?? "", /WAITING; permission handling stalled/);
  const errored = adapter.interpretResult(raw({ stdout: JSON.stringify({ event: "result", result: { status: "ERROR", error: "quota exceeded" } }) }));
  assert.equal(errored.ok, false);
  assert.match(errored.failure?.message ?? "", /ERROR/);
  assert.equal(errored.failure?.details["error"], "quota exceeded");
});

test("a SUCCESS result with a non-zero exit code is still a failure, in both result shapes", () => {
  const adapter = new AntigravityCliAdapter();
  for (const stdout of [AGY_1_3_3_STDOUT, JSON.stringify({ event: "result", status: "SUCCESS" })]) {
    assert.equal(adapter.interpretResult(raw({ stdout, exitCode: 1, stderr: "boom" })).ok, false);
  }
});

test("text calls: the answer is result.response (1.3.x), then the agent_response deltas, then flat legacy fields", () => {
  const adapter = new AntigravityCliAdapter();
  assert.equal(adapter.interpretTextResult(raw({ stdout: AGY_1_3_3_STDOUT })).text, "OK\n");
  // no `response`: fall back to the streamed deltas
  const noResponse = AGY_1_3_3_STDOUT.split("\n").map((l) => {
    const e = JSON.parse(l) as { event: string; result?: Record<string, unknown> };
    if (e.event === "result" && e.result !== undefined) delete e.result["response"];
    return JSON.stringify(e);
  }).join("\n");
  assert.equal(adapter.interpretTextResult(raw({ stdout: noResponse })).text, "OK\n");
  // legacy flat shape with a text field
  assert.equal(adapter.interpretTextResult(raw({ stdout: JSON.stringify({ event: "result", status: "SUCCESS", response: "legacy answer" }) })).text, "legacy answer");
  assert.equal(adapter.interpretTextResult(raw({ stdout: JSON.stringify({ event: "result", result: { status: "SUCCESS" } }) })).ok, false, "success but no answer text at all");
});

test("the text invocation never skips permissions; the turn invocation still does (turns must be able to use git and edit files)", () => {
  const adapter = new AntigravityCliAdapter();
  const text = adapter.buildTextInvocation({ prompt: "p", cwd: "/repo", timeoutMs: 5000, tier: "research-grade", webSearch: false, modelOverride: null });
  assert.ok(!text.args.includes("--dangerously-skip-permissions"));
  assert.ok(adapter.buildInvocation(request()).args.includes("--dangerously-skip-permissions"));
});

// ---- opt-in live checks against the real `agy` binary (never run in CI) ----
//   AGY_LIVE=1       node --test src/adapters/antigravity-cli.test.ts   -> read-only TEXT call (no permission skipping)
//   AGY_LIVE_TURN=1  node --test src/adapters/antigravity-cli.test.ts   -> a real TURN: agy edits a file and commits it in a
//                                                                      throwaway git repo, with --dangerously-skip-permissions.
// See docs/osa/ANTIGRAVITY.md for why the second one is a manual step.

test("LIVE (opt-in via AGY_LIVE=1): a real agy text call is interpreted as a success with its answer", { skip: process.env["AGY_LIVE"] === undefined }, async () => {
  const { runProcess } = await import("../util/exec.ts");
  const adapter = new AntigravityCliAdapter();
  const inv = adapter.buildTextInvocation({ prompt: "Reply with exactly the single word OK and nothing else.", cwd: process.cwd(), timeoutMs: 120_000, tier: "high-volume-low-effort", webSearch: false, modelOverride: null });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const result = await runProcess({ command: inv.command, args: inv.args, cwd: inv.cwd, stdin: inv.stdin, env, timeoutMs: 150_000 });
  const outcome = adapter.interpretTextResult(result);
  assert.equal(outcome.ok, true, String(outcome.failure?.message));
  assert.match(outcome.text ?? "", /OK/);
});

test("LIVE (opt-in via AGY_LIVE_TURN=1): a real agy TURN edits a file and commits it in a throwaway repo", { skip: process.env["AGY_LIVE_TURN"] === undefined }, async () => {
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const { runProcess } = await import("../util/exec.ts");
  const dir = await mkdtemp(`${tmpdir()}/osa-agy-turn-`);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: dir }).toString().trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  await writeFile(`${dir}/README.md`, "# demo\n", "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const adapter = new AntigravityCliAdapter();
  const inv = adapter.buildInvocation(request({ repoDir: dir, prompt: "Create a file named hello.txt containing exactly the text hi, then run: git add hello.txt && git commit -m \"add hello\". Then reply DONE.", timeoutMs: 300_000, tier: "high-volume-low-effort" }));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const result = await runProcess({ command: inv.command, args: inv.args, cwd: inv.cwd, stdin: inv.stdin, env, timeoutMs: 330_000 });
  const outcome = adapter.interpretResult(result);
  assert.equal(outcome.ok, true, String(outcome.failure?.message));
  assert.match(await readFile(`${dir}/hello.txt`, "utf8"), /^hi\s*$/);
  assert.match(git("log", "-1", "--format=%s"), /add hello/);
});
