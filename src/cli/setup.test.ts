// Implements PHASE_9_SPEC.md §1.5, §8.2 AC1, §8.3 AC2, §8.4 AC3 (amended by OSA WS1/WS3: osa is the only server)
// Covers runSetupCommand end-to-end via injected deps, computeSetupExitCode, and renderSetupHumanReport.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { RawInvocationResult } from "../domain/run.ts";
import type { RunProcessOptions } from "../util/exec.ts";
import { computeSetupExitCode, renderSetupHumanReport, runSetupCommand } from "./setup.ts";
import type { SetupReport } from "./setup.ts";
import { ExitCode } from "../domain/errors.ts";
import { DoctorReport } from "./doctor.ts";
import { DriveReport } from "./drive.ts";
import { RunReport } from "./run.ts";

const ENTRY_PATH = "/home/op/osa/dist/cli/main.js";
const CLAUDE_OK = async () => ({ found: true, version: "2.1.211" });

function fakeResult(overrides: Partial<RawInvocationResult> = {}): RawInvocationResult {
  return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...overrides };
}

/** A `claude mcp` fake: `add` and `get` answered by name. */
function claudeFake(over: { add?: (name: string) => RawInvocationResult; get?: (name: string) => RawInvocationResult } = {}) {
  const calls: RunProcessOptions[] = [];
  const runProcess = async (o: RunProcessOptions): Promise<RawInvocationResult> => {
    calls.push(o);
    if (o.command === "node") return fakeResult({ exitCode: 0 });
    if (o.command === "claude" && o.args[0] === "mcp" && o.args[1] === "add") return (over.add ?? (() => fakeResult()))(o.args[6] as string);
    if (o.command === "claude" && o.args[0] === "mcp" && o.args[1] === "get") {
      const name = o.args[2] as string;
      if (over.get !== undefined) return over.get(name);
      void name;
      return fakeResult({ exitCode: 0 });
    }
    return fakeResult({ exitCode: 1 });
  };
  return { runProcess, calls, claudeArgvs: () => calls.filter((c) => c.command === "claude").map((c) => c.args.join(" ")) };
}

test("AC1-a: one setup run registers osa -- exact add / post-check argv sequence", async () => {
  const f = claudeFake();
  const { report, exitCode } = await runSetupCommand({ json: false, entryPath: ENTRY_PATH }, { runProcess: f.runProcess, checkProviderCli: CLAUDE_OK });
  assert.equal(exitCode, ExitCode.OK);
  assert.equal(report.ok, true);
  assert.equal(report.scope, "user");
  assert.deepStrictEqual(report.servers.map((s) => [s.id, s.outcome]), [["osa", "registered"]]);
  const argvs = f.claudeArgvs();
  assert.ok(argvs[0]?.startsWith("mcp add --scope user --transport stdio osa --"), String(argvs[0]));
  assert.equal(argvs[1], "mcp get osa");
  assert.equal(argvs.length, 2);
  assert.ok(!argvs.join(" ").includes("arxiv"), "no research servers are ever registered or probed any more");
  assert.deepStrictEqual(report.notes, []);
});

test("AC1-b: osa's command/args reflect nodeOnPath true/false", async () => {
  const withNode = claudeFake();
  const a = await runSetupCommand({ json: false, entryPath: ENTRY_PATH }, { runProcess: withNode.runProcess, checkProviderCli: CLAUDE_OK });
  assert.equal(a.report.servers[0]?.command, "node");
  assert.deepStrictEqual(a.report.servers[0]?.args, [ENTRY_PATH, "mcp"]);

  const noNode = async (o: RunProcessOptions): Promise<RawInvocationResult> => {
    if (o.command === "node") return fakeResult({ exitCode: 1 });
    return o.args[1] === "get" && o.args[2] === "OSA" ? fakeResult({ exitCode: 1 }) : fakeResult();
  };
  const b = await runSetupCommand({ json: false, entryPath: ENTRY_PATH }, { runProcess: noNode, checkProviderCli: CLAUDE_OK });
  assert.equal(b.report.servers[0]?.command, process.execPath);
});

test("AC1-c precondition: skipped-no-agent-cli when the claude CLI is not found -- nothing attempted, exit PREFLIGHT_FAILED", async () => {
  const f = claudeFake();
  const { report, exitCode } = await runSetupCommand({ json: false, entryPath: ENTRY_PATH }, { runProcess: f.runProcess, checkProviderCli: async () => ({ found: false, version: null }) });
  assert.equal(exitCode, computeSetupExitCode({ agentCliFound: false, selfOutcome: "skipped-no-agent-cli" }));
  assert.equal(report.servers[0]?.outcome, "skipped-no-agent-cli");
  assert.equal(f.claudeArgvs().length, 0);
  assert.equal(report.ok, false);
});

test("AC2-b: an osa add failure is fatal (exit SETUP_FAILED) and named in problems", async () => {
  const f = claudeFake({ add: () => fakeResult({ exitCode: 1, stderr: "self-failure" }) });
  const { report, exitCode } = await runSetupCommand({ json: false, entryPath: ENTRY_PATH }, { runProcess: f.runProcess, checkProviderCli: CLAUDE_OK });
  assert.equal(exitCode, ExitCode.SETUP_FAILED);
  assert.equal(report.ok, false);
  assert.equal(report.servers[0]?.outcome, "failed");
  assert.ok(report.problems.some((p) => p.includes("osa")));
});

test("AC2-c (FM-I7): computeSetupExitCode depends only on osa's own outcome and whether the CLI was found", () => {
  for (const self of ["registered", "already-registered"] as const) {
    assert.equal(computeSetupExitCode({ agentCliFound: true, selfOutcome: self }), ExitCode.OK);
  }
  for (const self of ["failed", "registered-unverified", "skipped-launcher-unavailable", "indeterminate"] as const) {
    assert.equal(computeSetupExitCode({ agentCliFound: true, selfOutcome: self }), ExitCode.SETUP_FAILED);
  }
});

test("AC2-d (FM-I1): add ok but post-add get fails -> registered-unverified, exit SETUP_FAILED, distinct rendering", async () => {
  const f = claudeFake({ get: () => fakeResult({ exitCode: 1 }) });
  const { report, exitCode } = await runSetupCommand({ json: false, entryPath: ENTRY_PATH }, { runProcess: f.runProcess, checkProviderCli: CLAUDE_OK });
  assert.equal(report.servers[0]?.outcome, "registered-unverified");
  assert.equal(exitCode, ExitCode.SETUP_FAILED);
  const registeredReport: SetupReport = { ...report, servers: report.servers.map((s) => ({ ...s, outcome: "registered" as const })) };
  const failedReport: SetupReport = { ...report, servers: report.servers.map((s) => ({ ...s, outcome: "failed" as const })) };
  const unverified = renderSetupHumanReport(report);
  assert.notEqual(unverified, renderSetupHumanReport(registeredReport));
  assert.notEqual(unverified, renderSetupHumanReport(failedReport));
});

test("FM-I6: an unexpected throw during the attempt converts to osa's own indeterminate outcome, not a crash", async () => {
  const runProcess = async (o: RunProcessOptions): Promise<RawInvocationResult> => {
    if (o.command === "node") return fakeResult();
    if (o.args[1] === "add") throw new Error("boom");
    return fakeResult({ exitCode: 1 });
  };
  const { report, exitCode } = await runSetupCommand({ json: false, entryPath: ENTRY_PATH }, { runProcess, checkProviderCli: CLAUDE_OK });
  assert.equal(report.servers[0]?.outcome, "indeterminate");
  assert.match(report.servers[0]?.detail ?? "", /boom/);
  assert.equal(exitCode, ExitCode.SETUP_FAILED);
});

test("FM-I12: an already-registered server (add fails with the scope-specific 'already exists' marker) issues no post-check get, and its detail is a verbatim stderr slice", async () => {
  const gets: string[] = [];
  const f = claudeFake({
    add: (name) => fakeResult({ exitCode: 1, stderr: `MCP server ${name} already exists in user config` }),
    get: (name) => {
      gets.push(name);
      return fakeResult({ exitCode: 0 });
    },
  });
  const { report, exitCode } = await runSetupCommand({ json: false, entryPath: ENTRY_PATH }, { runProcess: f.runProcess, checkProviderCli: CLAUDE_OK });
  assert.deepStrictEqual(gets, [], "no post-check get");
  assert.equal(report.servers[0]?.outcome, "already-registered");
  assert.equal(exitCode, ExitCode.OK);
  assert.ok(report.servers[0]?.detail.includes("already exists in user config"));
});

test("FM-I12-b: a genuine (non-duplicate) add failure is still 'failed', not 'already-registered'", async () => {
  const f = claudeFake({ add: () => fakeResult({ exitCode: 1, stderr: "permission denied" }) });
  const { report } = await runSetupCommand({ json: false, entryPath: ENTRY_PATH }, { runProcess: f.runProcess, checkProviderCli: CLAUDE_OK });
  assert.equal(report.servers[0]?.outcome, "failed");
});

test("renderSetupHumanReport never renders 'registered' as working/connected/ready/verified working", () => {
  const report: SetupReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    ok: true,
    exit_code: 0,
    scope: "user",
    agent_cli: { found: true, version: "2.1.211" },
    servers: [{ id: "osa", required: true, outcome: "registered", launcher: "node", command: "node", args: [ENTRY_PATH, "mcp"], detail: "d", remediation: null }],
    problems: [],
    notes: [],
  };
  const rendered = renderSetupHumanReport(report);
  for (const forbidden of ["working", "connected", "verified working", "is running"]) {
    assert.ok(!rendered.toLowerCase().includes(forbidden), `must not render "${forbidden}"`);
  }
  assert.ok(rendered.includes("registered"));
});

// PHASE_9_SPEC.md scope edge 3 ("no tool-schema change") bound Phase 9 only; PHASE_10_SPEC.md §2.3
// explicitly authorizes `DriveReport` gaining `warnings` (the driver path would otherwise silently
// discard every chat-log warning, PRD §9 FM14's anti-silence rule) -- `RunReport` and `DoctorReport`
// are untouched by Phase 10 and still assert their exact, unmodified key sets.
// osa/test-hardening (TEST_REPORT.md, judgement call J-02): the operator explicitly asked for a doctor check that warns
// when dist/ is stale, so `DoctorReport` gains exactly two OPTIONAL keys, `build` and `warnings` -- and, in WS10, a third, `features` (the optional plug-ins' state). The assertion stays an
// exact-set equality; it was extended, not loosened.
test("AC3-c: RunReport/DoctorReport key sets are exactly their literal, unmodified expected sets; DriveReport gains only 'warnings' (PHASE_10_SPEC.md §2.3)", () => {
  assert.deepStrictEqual(
    Object.keys(RunReport.shape).sort(),
    ["schema_version", "generated_at", "run_id", "phase", "ok", "exit_code", "turns", "halt", "problems", "warnings"].sort(),
  );
  assert.deepStrictEqual(
    Object.keys(DriveReport.shape).sort(),
    [
      "schema_version",
      "generated_at",
      "driver_run_id",
      "starting_phase",
      "target_total_phases",
      "max_phases",
      "ok",
      "exit_code",
      "final_state_id",
      "phases",
      "warnings",
      "problems",
    ].sort(),
  );
  assert.deepStrictEqual(
    Object.keys(DoctorReport.shape).sort(),
    ["schema_version", "generated_at", "ok", "exit_code", "toolchain", "providers", "boundary", "lock", "build", "features", "warnings", "problems"].sort(),
  );
});
