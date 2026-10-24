// Implements PHASE_1_SPEC.md §1.6 -- main.test.ts
// Covers §8 acceptance criteria #13-18.
//
// Each case spawns a real `node src/cli/main.ts ...` child process via the sanctioned
// `runProcess` wrapper (src/util/exec.ts) -- this is the most faithful way to test the acceptance
// criteria, which are themselves phrased as literal CLI invocations, and it avoids the hazard of
// globally monkey-patching `process.stdout.write` across an `await` boundary while node:test's own
// reporter is concurrently writing lifecycle events to the very same stream.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };
import { PROVIDER_IDS } from "../domain/run.ts";
import { runProcess } from "../util/exec.ts";
import { DoctorReport } from "./doctor.ts";
import { renderHumanReport, renderMcpConfig, renderRunHumanReport } from "./main.ts";
import { RunReport } from "./run.ts";

const MAIN_TS_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));
const RUN_TIMEOUT_MS = 120_000;

async function runMain(args: readonly string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await runProcess({
    command: process.execPath,
    args: [MAIN_TS_PATH, ...args],
    cwd: process.cwd(),
    timeoutMs: RUN_TIMEOUT_MS,
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

test("--version prints the package version to stdout only and exits 0", async () => {
  const { exitCode, stdout, stderr } = await runMain(["--version"]);
  assert.equal(exitCode, 0);
  assert.equal(stdout, `${pkg.version}\n`);
  assert.equal(stderr, "");
});

test("-v is an alias for --version", async () => {
  const { exitCode, stdout } = await runMain(["-v"]);
  assert.equal(exitCode, 0);
  assert.equal(stdout, `${pkg.version}\n`);
});

test("--help prints usage to stdout only and exits 0", async () => {
  const { exitCode, stdout, stderr } = await runMain(["--help"]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /^Usage: osa/);
  assert.equal(stderr, "");
});

test("--help's run line names pinned-role behavior (PHASE_7_SPEC.md §4.3, baby_prd.md AC6)", async () => {
  const { stdout } = await runMain(["--help"]);
  assert.match(stdout, /role_pins|pinned/);
});

function baseRunReport(warnings: readonly string[]): RunReport {
  return RunReport.parse({
    schema_version: 1,
    generated_at: "2026-08-18T00:00:00.000Z",
    run_id: "11111111-1111-4111-8111-111111111111",
    phase: 1,
    ok: true,
    exit_code: 0,
    turns: [
      { turn_index: 0, archetype: "executor", provider: "claude-code", status: "completed", continuity_verdict: null, retried: false },
      { turn_index: 1, archetype: "executor", provider: "codex-cli", status: "completed", continuity_verdict: "CONTINUED", retried: false },
      { turn_index: 2, archetype: "reviewer", provider: "codex-cli", status: "completed", continuity_verdict: "CONTINUED", retried: false },
    ],
    halt: null,
    problems: [],
    warnings,
  });
}

test("renderRunHumanReport (PHASE_7_SPEC.md §4.3, AC3) renders a non-empty warnings entry in its own 'Warnings:' block", () => {
  const withWarning = renderRunHumanReport(
    baseRunReport(["Turn 2 (reviewer/codex-cli) is reviewing its own prior work: role_pins left no other provider eligible for the reviewer role this run."]),
  );
  assert.match(withWarning, /\nWarnings:\n  - Turn 2 \(reviewer\/codex-cli\) is reviewing its own prior work:/);
});

test("renderRunHumanReport omits the 'Warnings:' block entirely when report.warnings is empty (pre-Phase-7 fixtures unaffected)", () => {
  const withoutWarning = renderRunHumanReport(baseRunReport([]));
  assert.doesNotMatch(withoutWarning, /Warnings:/);
});

test("no arguments at all behaves like --help", async () => {
  const { exitCode, stdout } = await runMain([]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /^Usage: osa/);
});

test("-h is an alias for --help", async () => {
  const { exitCode, stdout } = await runMain(["-h"]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /^Usage: osa/);
});

test("an unknown command prints to stderr only and exits 2", async () => {
  const { exitCode, stdout, stderr } = await runMain(["frobnicate"]);
  assert.equal(exitCode, 2);
  assert.equal(stdout, "");
  assert.notEqual(stderr, "");
});

test("an unknown doctor flag is a usage error (exit 2)", async () => {
  const { exitCode, stderr } = await runMain(["doctor", "--not-a-real-flag"]);
  assert.equal(exitCode, 2);
  assert.match(stderr, /Unknown flag/);
});

test("doctor --boundary --providers exits 2 (mutually exclusive)", async () => {
  const { exitCode, stderr } = await runMain(["doctor", "--boundary", "--providers"]);
  assert.equal(exitCode, 2);
  assert.match(stderr, /mutually exclusive/);
});

test("doctor --json emits a single JSON object on stdout satisfying DoctorReport, with all provider identities", async () => {
  const { stdout, stderr } = await runMain(["doctor", "--json"]);
  assert.equal(stderr, "");
  const parsed: unknown = JSON.parse(stdout);
  const report = DoctorReport.parse(parsed);
  assert.deepStrictEqual(report.providers.map((p) => p.provider).sort(), [...PROVIDER_IDS].sort());
});

test("doctor --boundary --json exits 0 on this clean repo and reports zero violations", async () => {
  const { exitCode, stdout } = await runMain(["doctor", "--boundary", "--json"]);
  assert.equal(exitCode, 0);
  const report = DoctorReport.parse(JSON.parse(stdout));
  assert.deepStrictEqual(report.boundary.violations, []);
});

test("doctor --providers: exit 0 exactly when at least one provider is healthy (which CLIs this machine has is not part of the contract)", async () => {
  const { exitCode, stdout } = await runMain(["doctor", "--providers", "--json"]);
  const report = DoctorReport.parse(JSON.parse(stdout));
  const healthy = report.providers.filter((p) => p.problems.length === 0).length;
  const toolchainOk = report.toolchain.node.inRange && report.toolchain.git.inRange;
  assert.equal(exitCode === 0, toolchainOk && healthy >= 1);
  if (exitCode === 0) {
    assert.deepStrictEqual(report.problems, []);
    for (const p of report.providers) if (!p.cliFound) assert.ok(!(report.warnings ?? []).some((w) => p.problems.includes(w)), "an uninstalled provider is not mentioned");
  }
});

/**
 * A minimal, valid {@link DoctorReport} carrying exactly one provider in the requested credential
 * state. Constructed literally (never probed) because an indeterminate probe cannot be provoked
 * from this machine's real CLIs on demand -- the same constructed-input approach `preflight.test.ts`
 * uses for the `parse*` functions.
 */
function reportWithAuthState(authState: "authenticated" | "unauthenticated" | "indeterminate"): DoctorReport {
  return DoctorReport.parse({
    schema_version: 1,
    generated_at: "2026-08-16T00:00:00.000Z",
    ok: authState === "authenticated",
    exit_code: authState === "authenticated" ? 0 : 3,
    toolchain: {
      node: { found: true, version: "24.0.0", inRange: true },
      git: { found: true, version: "2.54.0", inRange: true },
    },
    providers: [
      {
        provider: "codex-cli",
        cliFound: true,
        version: "codex-cli 0.128.0",
        versionInRange: true,
        authenticated: authState === "authenticated",
        authState,
        problems: [],
      },
    ],
    boundary: { filesScanned: 0, violations: [] },
    lock: { acquirable: true, detail: "not checked" },
    problems: [],
  });
}

test("DoctorReport rejects a providers[] entry with no authState (the new field is part of the schema)", () => {
  const valid = reportWithAuthState("unauthenticated");
  const provider = valid.providers[0];
  assert.ok(provider !== undefined);
  const { authState: _dropped, ...withoutAuthState } = provider;
  assert.equal(DoctorReport.safeParse({ ...valid, providers: [withoutAuthState] }).success, false);
});

test("doctor's human-readable output distinguishes an indeterminate probe from a genuine sign-in failure", () => {
  const unauthenticated = renderHumanReport(reportWithAuthState("unauthenticated"));
  const indeterminate = renderHumanReport(reportWithAuthState("indeterminate"));
  const authenticated = renderHumanReport(reportWithAuthState("authenticated"));

  // The whole point: three states, three distinct operator-facing lines.
  assert.notEqual(indeterminate, unauthenticated);
  assert.notEqual(indeterminate, authenticated);
  assert.notEqual(unauthenticated, authenticated);

  assert.match(unauthenticated, /codex-cli: .*not authenticated/);
  assert.match(indeterminate, /codex-cli: .*UNKNOWN/);
  // An indeterminate result must never render as the sign-in-failure wording, or an operator will
  // chase a credential problem that does not exist (the Windows cmd.exe defect's exact symptom).
  assert.doesNotMatch(indeterminate, /not authenticated/);
  assert.match(indeterminate, /NOT a confirmed sign-in failure/);

  // The `authenticated` line stays byte-identical to what it has always been.
  assert.match(authenticated, /codex-cli: codex-cli 0\.128\.0 \(in range\), authenticated\n/);
});

test("doctor (no flags) runs the full report and exits per §4.3 precedence", async () => {
  const { exitCode, stdout } = await runMain(["doctor"]);
  assert.match(stdout, /^osa doctor --/);
  // The boundary scan of this repository is clean and the lock is acquirable, so the only thing that can fail the report is the preflight: no
  // usable provider (or a toolchain out of range). Exit 0 and an "OK" header go together; whether this machine has a provider is not the test's business.
  assert.ok(exitCode === 0 || exitCode === 3, `unexpected exit code ${String(exitCode)}`);
  assert.equal(exitCode === 0, /^osa doctor -- OK/.test(stdout));
});

// PHASE_8_SPEC.md §1.2 -- `mcp` subcommand parsing and usage-text additions.

test("mcp is parsed with zero flags and exits 0 cleanly on stdin EOF", async () => {
  const { exitCode, stdout, stderr } = await runMain(["mcp"]);
  assert.equal(exitCode, 0);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("any flag passed to mcp is a usage error (exit 2)", async () => {
  const { exitCode, stderr } = await runMain(["mcp", "--not-a-real-flag"]);
  assert.equal(exitCode, 2);
  assert.match(stderr, /Unknown flag for mcp/);
});

test("USAGE_TEXT contains an osa mcp line", async () => {
  const { stdout } = await runMain(["--help"]);
  assert.match(stdout, /osa mcp\s+Start a local, stdio-only Model Context Protocol server/);
});

// PHASE_9_SPEC.md §7 FM-I3 reviewer check (c): "parseSetupArgs rejects --scope as an unknown flag
// (a test asserts the UsageError)." parseArgs/parseSetupArgs are synchronous and throw before any
// I/O is attempted, so this is safe to drive through the real `main.ts` entry point -- no `claude`
// CLI is ever shelled out to and no MCP config is touched.
test("--scope is an unknown flag for setup and is rejected (exit 2) -- PHASE_9_SPEC.md §7 FM-I3(c)", async () => {
  const { exitCode, stderr } = await runMain(["setup", "--scope", "user"]);
  assert.equal(exitCode, 2);
  assert.match(stderr, /Unknown flag for setup/);
});

test("any unrecognized flag passed to setup is a usage error (exit 2)", async () => {
  const { exitCode, stderr } = await runMain(["setup", "--not-a-real-flag"]);
  assert.equal(exitCode, 2);
  assert.match(stderr, /Unknown flag for setup/);
});

test("USAGE_TEXT contains an osa setup line", async () => {
  const { stdout } = await runMain(["--help"]);
  assert.match(stdout, /osa setup \[--json\]\s+Register osa's own MCP server/);
});

test("mcp-config prints a paste-ready MCP entry for the installation it runs from, and takes no flags", async () => {
  const text = renderMcpConfig("/home/me/lib/node_modules/@kaide-labs/osa/dist/cli/main.js");
  const json = text.slice(text.indexOf("{"), text.indexOf("\n}\n") + 2);
  const parsed = JSON.parse(json) as { mcpServers: { osa: { command: string; args: string[] } } };
  assert.equal(parsed.mcpServers.osa.command, "node");
  assert.deepEqual(parsed.mcpServers.osa.args.slice(1), ["mcp"]);
  assert.match(parsed.mcpServers.osa.args[0] ?? "", /@kaide-labs.osa.dist.cli.main\.js$/);
  assert.match(text, /claude mcp add --scope user --transport stdio osa -- node /);
  assert.match(renderMcpConfig("/opt/with space/main.js"), /node "\/opt\/with space\/main\.js" mcp/, "a path with a space is quoted in the command line");
  const ok = await runMain(["mcp-config"]);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /"mcpServers"/);
  const bad = await runMain(["mcp-config", "--nope"]);
  assert.equal(bad.exitCode, 2);
  assert.match(bad.stderr, /Unknown flag for mcp-config/);
  const help = await runMain(["--help"]);
  assert.match(help.stdout, /osa mcp-config/);
  assert.match(help.stdout, /osa_plan \/ osa_spec \/ osa_build \/ osa_status/);
});
