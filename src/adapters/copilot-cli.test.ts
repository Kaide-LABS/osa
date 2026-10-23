import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawInvocationResult, TurnRequest } from "../domain/run.ts";
import { interpretCopilotAuthInputs } from "../verify/preflight.ts";
import { assertAdapterConformance } from "./conformance.ts";
import { COPILOT_INSTRUCTION, CopilotCliAdapter } from "./copilot-cli.ts";

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return { runId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", phase: 1, turnIndex: 0, archetype: "executor", provider: "copilot-cli", tier: "research-grade", modelOverride: null, repoDir: "/repo", specRef: { path: "PHASE_1_SPEC.md", sha256: "a".repeat(64) }, priorRecord: null, prompt: "x".repeat(50_000), timeoutMs: 1_800_000, babyPrdPath: "a.md", contextPath: "b.md", expectedArtifactPath: null, chatLogId: "run", chatLogGitignored: true, ...overrides };
}
function raw(overrides: Partial<RawInvocationResult> = {}): RawInvocationResult { return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...overrides }; }

// [UNVERIFIED-LOCAL] These tests pin the invocation shape taken from GitHub's documentation; they cannot prove the real CLI accepts it.
test("CopilotCliAdapter conforms", () => assertAdapterConformance(new CopilotCliAdapter(), request()));

test("a build turn: documented programmatic flags, the (long) prompt on stdin and only a one-line instruction on argv", () => {
  const inv = new CopilotCliAdapter().buildInvocation(request({ modelOverride: "claude-haiku-4.5" }));
  assert.deepStrictEqual(inv.args, ["-p", COPILOT_INSTRUCTION, "-s", "--no-ask-user", "--allow-all-tools", "--model=claude-haiku-4.5"]);
  assert.equal(inv.stdin?.length, 50_000);
  assert.ok(inv.args.every((a) => a.length < 200));
});

test("a text call grants no tool and explicitly denies shell, write and url", () => {
  const inv = new CopilotCliAdapter().buildTextInvocation({ prompt: "p", cwd: "/r", timeoutMs: 1000, tier: "research-grade", webSearch: false, modelOverride: null });
  assert.ok(!inv.args.includes("--allow-all-tools") && !inv.args.some((a) => a.startsWith("--allow-tool")));
  for (const tool of ["shell", "write", "url"]) assert.ok(inv.args.includes(`--deny-tool=${tool}`));
  assert.ok(!inv.args.some((a) => a.startsWith("--model")), "no model flag when none is set");
});

test("interpretTextResult: the trimmed stdout is the answer; non-zero exit, empty output and a timeout are failures", () => {
  const a = new CopilotCliAdapter();
  assert.deepEqual(a.interpretTextResult(raw({ stdout: "  the answer \n" })), { ok: true, text: "the answer", failure: null });
  assert.equal(a.interpretTextResult(raw({ stdout: "x", exitCode: 1 })).ok, false);
  assert.equal(a.interpretTextResult(raw()).ok, false);
  assert.equal(a.interpretTextResult(raw({ stdout: "x", timedOut: true })).ok, false);
});

test("sign-in cannot be observed from outside: a token in the environment is the only conclusive sign, otherwise 'indeterminate' (never 'signed out')", () => {
  assert.equal(interpretCopilotAuthInputs({ GH_TOKEN: "x" }).authState, "authenticated");
  assert.equal(interpretCopilotAuthInputs({ COPILOT_GITHUB_TOKEN: "x" }).authState, "authenticated");
  assert.equal(interpretCopilotAuthInputs({}).authState, "indeterminate");
  assert.equal(interpretCopilotAuthInputs({ GITHUB_TOKEN: "" }).authState, "indeterminate");
});
