// Implements PHASE_2_SPEC.md §1.1 -- codex-cli.test.ts
// Unit tests for CodexCliAdapter plus the shared adapter conformance suite (§6.4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { TurnTimeoutError } from "../domain/errors.ts";
import type { Archetype } from "../domain/roles.ts";
import { MODEL_TIERS } from "../domain/tiers.ts";
import type { RawInvocationResult, TurnRequest } from "../domain/run.ts";
import { buildProviderPreflightReport, runPreflight } from "../verify/preflight.ts";
import { assertAdapterConformance } from "./conformance.ts";
import { CODEX_EFFORT_VALUES, CodexCliAdapter } from "./codex-cli.ts";

/** Only executor/reviewer are dispatched in V1 (PRD §6.3); no fixture needs any other archetype. */
const V1_ARCHETYPES: readonly Archetype[] = ["executor", "reviewer"];

function makeTurnRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    runId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    phase: 1,
    turnIndex: 0,
    archetype: "executor",
    provider: "codex-cli",
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

test("CodexCliAdapter satisfies the shared adapter conformance suite (§8 check #18)", () => {
  assertAdapterConformance(new CodexCliAdapter(), makeTurnRequest());
});

test("resolveEffort maps every MODEL_TIERS member to the pinned Codex effort table (§3.3, §8 check #11)", () => {
  const adapter = new CodexCliAdapter();
  assert.equal(adapter.resolveEffort("research-grade"), "high");
  assert.equal(adapter.resolveEffort("verification-grade"), "high");
  assert.equal(adapter.resolveEffort("high-volume-low-effort"), "low");
  for (const tier of MODEL_TIERS) {
    const first = adapter.resolveEffort(tier);
    assert.ok((CODEX_EFFORT_VALUES as readonly string[]).includes(first));
    assert.equal(adapter.resolveEffort(tier), first, "resolveEffort must be pure");
  }
});

test("buildInvocation never emits -a, --ask-for-approval, or --full-auto, across every Archetype/ModelTier/modelOverride combination reachable in V1 (PRD §9 FM7, §8 check #13)", () => {
  const adapter = new CodexCliAdapter();
  for (const archetype of V1_ARCHETYPES) {
    for (const tier of MODEL_TIERS) {
      for (const modelOverride of [null, "custom-op-override-1"]) {
        const invocation = adapter.buildInvocation(makeTurnRequest({ archetype, tier, modelOverride }));
        assert.ok(!invocation.args.includes("-a"), `-a leaked for ${archetype}/${tier}/${String(modelOverride)}`);
        assert.ok(!invocation.args.includes("--ask-for-approval"));
        assert.ok(!invocation.args.includes("--full-auto"));
      }
    }
  }
});

test("buildInvocation is pure and produces exactly the FM7-mandated flag set, unconditionally", () => {
  const adapter = new CodexCliAdapter();
  const req = makeTurnRequest();
  const invocation = adapter.buildInvocation(req);
  assert.deepStrictEqual(adapter.buildInvocation(req), invocation);
  assert.deepStrictEqual(req, makeTurnRequest(), "buildInvocation must not mutate its input");
  assert.deepStrictEqual(invocation, {
    command: "codex",
    args: [
      "exec",
      "-c",
      'approval_policy="never"',
      "--sandbox",
      "workspace-write",
      "-c",
      'model_reasoning_effort="low"',
      "--json",
      "-C",
      "/repo",
      "-",
    ],
    env: {},
    cwd: "/repo",
    stdin: "Implement PHASE_2_SPEC.md.",
  });
});

test('buildInvocation inserts -c model="<override>" only when modelOverride is non-null, before --json', () => {
  const adapter = new CodexCliAdapter();
  const withOverride = adapter.buildInvocation(makeTurnRequest({ modelOverride: "custom-op-override-1" }));
  const idx = withOverride.args.indexOf("--json");
  assert.ok(idx > 0);
  assert.deepStrictEqual(withOverride.args.slice(idx - 2, idx), ["-c", 'model="custom-op-override-1"']);

  const withoutOverride = adapter.buildInvocation(makeTurnRequest({ modelOverride: null }));
  assert.ok(!withoutOverride.args.some((a) => a.startsWith("model=")));
});

test("interpretResult: timeout is checked first, unconditionally, even with exitCode: 0 (§8 check #14)", () => {
  const outcome = new CodexCliAdapter().interpretResult(fakeRaw({ timedOut: true, exitCode: 0 }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.record, null);
  assert.ok(outcome.failure instanceof TurnTimeoutError);
});

test("interpretResult: a synthetic turn.failed JSONL line is a failure even when exitCode: 0 (§8 check #16)", () => {
  const stdout = [JSON.stringify({ type: "thread.started" }), JSON.stringify({ type: "turn.failed", error: "boom" })].join(
    "\n",
  );
  const outcome = new CodexCliAdapter().interpretResult(fakeRaw({ exitCode: 0, stdout }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.record, null);
  assert.match(outcome.failure?.message ?? "", /turn\.failed/);
});

test("interpretResult: a synthetic error event is a failure even when exitCode: 0", () => {
  const outcome = new CodexCliAdapter().interpretResult(
    fakeRaw({ exitCode: 0, stdout: JSON.stringify({ type: "error", message: "boom" }) }),
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.record, null);
});

test("interpretResult: a non-parseable JSONL line is skipped, not a crash", () => {
  const stdout = ["not json at all", JSON.stringify({ type: "turn.completed" })].join("\n");
  const outcome = new CodexCliAdapter().interpretResult(fakeRaw({ exitCode: 0, stdout }));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.record, null);
});

test("interpretResult: non-zero exit with no failure event is a failure (exit-code fallback)", () => {
  const outcome = new CodexCliAdapter().interpretResult(fakeRaw({ exitCode: 1 }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.record, null);
});

test("interpretResult: exitCode 0 with empty stdout is failure, record still null (§8 check #15)", () => {
  const outcome = new CodexCliAdapter().interpretResult(fakeRaw({ exitCode: 0, stdout: "" }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.record, null);
  assert.notEqual(outcome.failure, null);
});

test("buildProviderPreflightReport('codex-cli') matches runPreflight()'s corresponding array element (§8 check #19)", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-codex-adapter-test-`);
  try {
    const standalone = await buildProviderPreflightReport("codex-cli");
    const summary = await runPreflight(dir);
    const fromRunPreflight = summary.providers.find((p) => p.provider === "codex-cli");
    assert.deepStrictEqual(standalone, fromRunPreflight);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CodexCliAdapter().preflight() against the real machine is self-consistent whatever is installed (a missing CLI is indeterminate, never 'signed out'; no problems means authenticated)", async () => {
  const report = await new CodexCliAdapter().preflight();
  assert.equal(report.provider, "codex-cli");
  assert.equal(report.authenticated, report.authState === "authenticated");
  if (!report.cliFound) {
    assert.equal(report.authState, "indeterminate");
    assert.ok(report.problems.length > 0);
  }
  if (report.problems.length === 0) assert.equal(report.authenticated, true);
});
