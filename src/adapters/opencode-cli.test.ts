import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawInvocationResult, TurnRequest } from "../domain/run.ts";
import { assertAdapterConformance } from "./conformance.ts";
import { OpenCodeCliAdapter, parseOpenCodeEvents, textPermissionConfig } from "./opencode-cli.ts";

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return { runId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", phase: 1, turnIndex: 0, archetype: "executor", provider: "opencode-cli", tier: "research-grade", modelOverride: null, repoDir: "/repo", specRef: { path: "PHASE_1_SPEC.md", sha256: "a".repeat(64) }, priorRecord: null, prompt: "do the work\n\"quoted\"", timeoutMs: 1_800_000, babyPrdPath: "a.md", contextPath: "b.md", expectedArtifactPath: null, chatLogId: "run", chatLogGitignored: true, ...overrides };
}
function raw(overrides: Partial<RawInvocationResult> = {}): RawInvocationResult { return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...overrides }; }
const lines = (...events: object[]): string => events.map((e) => JSON.stringify(e)).join("\n");

// Event streams captured from the installed OpenCode v2.1.1 (2026-10-23), ids shortened.
const TEXT_ONLY = lines(
  { type: "text", sessionID: "s", part: { messageID: "m1", type: "text", text: "pong" } },
);
const WITH_TOOL = lines(
  { type: "step_start", part: { messageID: "m1", type: "step-start" } },
  { type: "text", part: { messageID: "m1", type: "text", text: "I'll run that command for you." } },
  { type: "tool_use", part: { messageID: "m1", type: "tool", tool: "shell", state: { status: "completed", output: "hello-from-shell\n" } } },
  { type: "step_finish", part: { messageID: "m1", type: "step-finish", reason: "tool-calls" } },
  { type: "text", part: { messageID: "m2", type: "text", text: "The command output was:\n\n```\nhello-from-shell\n```" } },
  { type: "step_finish", part: { messageID: "m2", type: "step-finish", reason: "stop" } },
);
const BILLING_ERROR = lines({ type: "error", sessionID: "s", error: { type: "provider.invalid-request", message: "Your credit balance is too low to access the Anthropic API.", status: 400 } });

test("OpenCodeCliAdapter conforms", () => assertAdapterConformance(new OpenCodeCliAdapter(), request()));

test("preflight reports the OpenCode identity", async () => {
  assert.equal((await new OpenCodeCliAdapter().preflight()).provider, "opencode-cli");
});

test("a build turn: private server, JSON events, auto-approve, the prompt on stdin (never on argv), the model when one is set", () => {
  const a = new OpenCodeCliAdapter();
  const inv = a.buildInvocation(request());
  assert.deepStrictEqual(inv.args, ["run", "--standalone", "--format", "json", "--auto"]);
  assert.equal(inv.command, "opencode");
  assert.equal(inv.stdin, "do the work\n\"quoted\"");
  assert.deepStrictEqual(a.buildInvocation(request({ modelOverride: "anthropic/claude-opus-4-8" })).args.slice(-2), ["--model", "anthropic/claude-opus-4-8"]);
});

test("a text call is read-only: no --auto, and the permission rules (env) switch off every tool that changes anything or reaches the web", () => {
  const a = new OpenCodeCliAdapter();
  const inv = a.buildTextInvocation({ prompt: "p", cwd: "/r", timeoutMs: 1000, tier: "research-grade", webSearch: false, modelOverride: "opencode/big-pickle" });
  assert.deepStrictEqual(inv.args, ["run", "--standalone", "--format", "json", "--model", "opencode/big-pickle"]);
  assert.ok(!inv.args.includes("--auto"));
  const rules = JSON.parse(inv.env["OPENCODE_CONFIG_CONTENT"] ?? "{}") as { permission: Record<string, string> };
  for (const tool of ["bash", "edit", "write", "task", "subagent", "execute", "websearch", "webfetch"]) assert.equal(rules.permission[tool], "deny", `${tool} is denied`);
  // the application check may run the built project, so only then does the shell stay
  const exec = JSON.parse(textPermissionConfig({ execute: true })) as { permission: Record<string, string> };
  assert.equal(exec.permission["bash"], undefined);
  assert.equal(exec.permission["edit"], "deny", "it still cannot edit");
});

test("parseOpenCodeEvents: the answer is the LAST assistant message, not the text said before a tool call", () => {
  assert.deepEqual(parseOpenCodeEvents(TEXT_ONLY), { answer: "pong", errorMessage: null, finished: false });
  const p = parseOpenCodeEvents(WITH_TOOL);
  assert.match(p.answer ?? "", /^The command output was:/);
  assert.doesNotMatch(p.answer ?? "", /I'll run that command/);
  assert.equal(p.finished, true);
  assert.equal(parseOpenCodeEvents("not json\n\n").answer, null);
});

test("interpretTextResult: text on a finished stream; an error event, a non-zero exit, a timeout and an unfinished stream are failures", () => {
  const a = new OpenCodeCliAdapter();
  const ok = a.interpretTextResult(raw({ stdout: WITH_TOOL }));
  assert.equal(ok.ok, true);
  assert.match(ok.text ?? "", /hello-from-shell/);
  const billing = a.interpretTextResult(raw({ stdout: BILLING_ERROR, exitCode: 1 }));
  assert.equal(billing.ok, false);
  assert.match(billing.failure?.message ?? "", /credit balance is too low/);
  assert.equal(a.interpretTextResult(raw({ stdout: WITH_TOOL, exitCode: 1 })).ok, false);
  assert.equal(a.interpretTextResult(raw({ stdout: WITH_TOOL, timedOut: true })).ok, false);
  assert.equal(a.interpretTextResult(raw({ stdout: TEXT_ONLY })).ok, false, "no finished step: the run was cut off");
  assert.equal(a.interpretResult(raw()).ok, false, "an empty successful process is not a success");
  assert.equal(a.interpretResult(raw({ stdout: WITH_TOOL })).ok, true);
});

test("capabilities: OpenCode claims no web search (its websearch tool was cancelled in every headless run) but can run commands", () => {
  const caps = new OpenCodeCliAdapter().textCapabilities;
  assert.equal(caps.webSearch, false);
  assert.equal(caps.execute, true);
});
