// Implements PHASE_2_SPEC.md §1.1 -- claude-code.test.ts
// Unit tests for ClaudeCodeAdapter plus the shared adapter conformance suite (§6.4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ExitCode, TurnTimeoutError } from "../domain/errors.ts";
import type { Archetype } from "../domain/roles.ts";
import { MODEL_TIERS } from "../domain/tiers.ts";
import type { RawInvocationResult, TurnRequest } from "../domain/run.ts";
import { buildProviderPreflightReport, runPreflight } from "../verify/preflight.ts";
import { assertAdapterConformance } from "./conformance.ts";
import { CLAUDE_EFFORT_VALUES, ClaudeCodeAdapter } from "./claude-code.ts";

/** Only executor/reviewer are dispatched in V1 (PRD §6.3); no fixture needs any other archetype. */
const V1_ARCHETYPES: readonly Archetype[] = ["executor", "reviewer"];

function makeTurnRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    runId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    phase: 1,
    turnIndex: 0,
    archetype: "executor",
    provider: "claude-code",
    tier: "high-volume-low-effort",
    modelOverride: null,
    repoDir: "/repo",
    specRef: { path: "PHASE_2_SPEC.md", sha256: "c".repeat(64) },
    priorRecord: null,
    prompt: "Implement PHASE_2_SPEC.md.",
    timeoutMs: 1_800_000,
    babyPrdPath: ".claude/loopr/baby_prd.md",
    contextPath: ".claude/loopr/context.md",
    expectedArtifactPath: null,
    chatLogId: "run-1",
    chatLogGitignored: true,
    ...overrides,
  };
}

function fakeRaw(overrides: Partial<RawInvocationResult> = {}): RawInvocationResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    ...overrides,
  };
}

test("ClaudeCodeAdapter satisfies the shared adapter conformance suite (§8 check #18)", () => {
  assertAdapterConformance(new ClaudeCodeAdapter(), makeTurnRequest());
});

test("resolveEffort maps every MODEL_TIERS member to the pinned Claude effort table (§3.3, §8 check #11)", () => {
  const adapter = new ClaudeCodeAdapter();
  assert.equal(adapter.resolveEffort("research-grade"), "high");
  assert.equal(adapter.resolveEffort("verification-grade"), "high");
  assert.equal(adapter.resolveEffort("high-volume-low-effort"), "low");
  for (const tier of MODEL_TIERS) {
    const first = adapter.resolveEffort(tier);
    assert.ok((CLAUDE_EFFORT_VALUES as readonly string[]).includes(first));
    assert.equal(adapter.resolveEffort(tier), first, "resolveEffort must be pure");
  }
});

test("buildInvocation never emits --bare, across every Archetype/ModelTier/modelOverride combination reachable in V1 (§8 check #13)", () => {
  const adapter = new ClaudeCodeAdapter();
  for (const archetype of V1_ARCHETYPES) {
    for (const tier of MODEL_TIERS) {
      for (const modelOverride of [null, "custom-op-override-1"]) {
        const invocation = adapter.buildInvocation(makeTurnRequest({ archetype, tier, modelOverride }));
        assert.ok(
          !invocation.args.includes("--bare"),
          `--bare leaked for ${archetype}/${tier}/${String(modelOverride)}`,
        );
      }
    }
  }
});

test("buildInvocation is pure and produces exactly the FM7/FM8-mandated flag set, unconditionally", () => {
  const adapter = new ClaudeCodeAdapter();
  const req = makeTurnRequest();
  const invocation = adapter.buildInvocation(req);
  assert.deepStrictEqual(adapter.buildInvocation(req), invocation);
  assert.deepStrictEqual(req, makeTurnRequest(), "buildInvocation must not mutate its input");
  assert.deepStrictEqual(invocation, {
    command: "claude",
    args: [
      "-p",
      "--output-format",
      "json",
      "--effort",
      "low",
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--allowedTools",
      "Bash,Edit,Write,Read,Glob,Grep",
    ],
    env: {},
    cwd: "/repo",
    stdin: "Implement PHASE_2_SPEC.md.",
  });
});

test("buildInvocation appends --model only when modelOverride is non-null", () => {
  const adapter = new ClaudeCodeAdapter();
  const withOverride = adapter.buildInvocation(makeTurnRequest({ modelOverride: "custom-op-override-1" }));
  assert.ok(withOverride.args.includes("--model"));
  assert.equal(withOverride.args[withOverride.args.indexOf("--model") + 1], "custom-op-override-1");

  const withoutOverride = adapter.buildInvocation(makeTurnRequest({ modelOverride: null }));
  assert.ok(!withoutOverride.args.includes("--model"));
});

test("interpretResult: timeout is checked first, unconditionally, even with exitCode: 0 (§8 check #14)", () => {
  const outcome = new ClaudeCodeAdapter().interpretResult(fakeRaw({ timedOut: true, exitCode: 0 }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.record, null);
  assert.ok(outcome.failure instanceof TurnTimeoutError);
  assert.equal(outcome.failure?.exitCode, ExitCode.TURN_TIMEOUT);
});

test("interpretResult: non-zero exit (including null, a spawn-level failure) is a failure", () => {
  const adapter = new ClaudeCodeAdapter();
  const nonZero = adapter.interpretResult(fakeRaw({ exitCode: 1 }));
  assert.equal(nonZero.ok, false);
  assert.equal(nonZero.record, null);

  const spawnFailure = adapter.interpretResult(fakeRaw({ exitCode: null, stderr: "spawn claude ENOENT" }));
  assert.equal(spawnFailure.ok, false);
  assert.equal(spawnFailure.record, null);
});

test("interpretResult: exitCode 0 with non-JSON stdout is a failure (§8 check #17)", () => {
  const outcome = new ClaudeCodeAdapter().interpretResult(fakeRaw({ exitCode: 0, stdout: "not json" }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.record, null);
  assert.match(outcome.failure?.message ?? "", /did not parse as JSON/);
});

test("interpretResult: exitCode 0 with valid JSON stdout is success, record still null (§8 check #15)", () => {
  const outcome = new ClaudeCodeAdapter().interpretResult(
    fakeRaw({ exitCode: 0, stdout: JSON.stringify({ result: "ok", session_id: "s1", total_cost_usd: 0.01 }) }),
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.record, null);
  assert.equal(outcome.failure, null);
});

test("buildProviderPreflightReport('claude-code') matches runPreflight()'s corresponding array element (§8 check #19)", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-claude-adapter-test-`);
  try {
    const standalone = await buildProviderPreflightReport("claude-code");
    const summary = await runPreflight(dir);
    const fromRunPreflight = summary.providers.find((p) => p.provider === "claude-code");
    assert.deepStrictEqual(standalone, fromRunPreflight);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("ClaudeCodeAdapter().preflight() against the real machine is self-consistent whatever is installed (a missing CLI is indeterminate, never 'signed out'; healthy means authenticated)", async () => {
  const report = await new ClaudeCodeAdapter().preflight();
  assert.equal(report.provider, "claude-code");
  assert.equal(report.authenticated, report.authState === "authenticated");
  if (!report.cliFound) {
    assert.equal(report.authState, "indeterminate");
    assert.ok(report.problems.length > 0);
  }
  if (report.problems.length === 0) assert.equal(report.authenticated, true);
});
