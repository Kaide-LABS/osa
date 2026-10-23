// Implements PHASE_8_SPEC.md §1.2, §8 criterion 2
//
// Same shape as run.test.ts, for `drive`/`DriveReport` (baby_prd AC2). Reuses driver-loop.test.ts's
// own `runDispatchFn` fake-dispatch fixture pattern (not its exported symbols -- nothing in that
// file is exported), which stands in for a real per-phase turn dispatch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DriveConfig } from "../../domain/driver.ts";
import type { RunResult } from "../../dispatch/run-loop.ts";
import type { DriveDispatchDeps } from "../../dispatch/driver-loop.ts";
import { runDriveCommand, type DriveReport } from "../../cli/drive.ts";
import { driveReportToCallToolResult, registerDriveTool } from "./drive.ts";

function syntheticReport(overrides: Partial<DriveReport> = {}): DriveReport {
  return {
    schema_version: 1,
    generated_at: "2026-08-18T00:00:00.000Z",
    driver_run_id: randomUUID(),
    starting_phase: 1,
    target_total_phases: 1,
    max_phases: 25,
    ok: true,
    exit_code: 0,
    final_state_id: "D3_BUILD_COMPLETE_PRESENT",
    phases: [],
    warnings: [],
    problems: [],
    ...overrides,
  };
}

test("driveReportToCallToolResult: an ok report is a non-error result carrying the report verbatim", () => {
  const report = syntheticReport();
  const result = driveReportToCallToolResult(report);
  assert.equal(result.isError, undefined);
  assert.deepStrictEqual(result.structuredContent, report);
});

test("driveReportToCallToolResult: a halted report (ok:false) is still a non-error CallToolResult", () => {
  const report = syntheticReport({ ok: false, exit_code: 14, final_state_id: "D4_NEITHER_PRESENT" });
  const result = driveReportToCallToolResult(report);
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as DriveReport).ok, false);
});

// ---- Integration: MCP tool <-> CLI equivalence -----------------------------------------------

function baseDriveConfig(dir: string, overrides: Partial<DriveConfig> = {}): DriveConfig {
  return {
    repo_dir: dir,
    driver_run_id: randomUUID(),
    starting_phase: 1,
    starting_spec_path: "PHASE_1_SPEC.md",
    baby_prd_path: "baby_prd.md",
    context_path: "context.md",
    target_total_phases: 1,
    max_phases: 25,
    executor_providers: ["claude-code", "codex-cli"],
    reviewer_provider: null,
    turn_timeout_ms: 1_800_000,
    build_complete_path: "BUILD_COMPLETE.md",
    chat_log_gitignored: true,
    ...overrides,
  };
}

function okResult(exitCode = 0): RunResult {
  return { ok: true, exitCode, turns: [], halt: null, problems: [], warnings: [] };
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** A fresh temp repo plus a `runDispatchFn` fake that writes BUILD_COMPLETE.md on its one call -- a deterministic D3 stop. */
async function buildFixture(): Promise<{ dir: string; config: DriveConfig; deps: DriveDispatchDeps }> {
  const dir = await mkdtemp(`${tmpdir()}/osa-mcp-drive-`);
  const runDispatchFn: DriveDispatchDeps["runDispatchFn"] = async () => {
    await writeFile(`${dir}/BUILD_COMPLETE.md`, "done\n", "utf8");
    return okResult();
  };
  return { dir, config: baseDriveConfig(dir), deps: { runDispatchFn } };
}

/** Captures the handler registerDriveTool wires up, without a real transport/SDK validation pass. */
function captureDriveHandler(deps?: DriveDispatchDeps): (config: Record<string, unknown>) => Promise<CallToolResult> {
  let handler: ((config: Record<string, unknown>) => Promise<CallToolResult>) | null = null;
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, cb: (config: Record<string, unknown>) => Promise<CallToolResult>) => {
      handler = cb;
    },
  };
  registerDriveTool(fakeServer as unknown as Parameters<typeof registerDriveTool>[0], deps);
  if (handler === null) {
    throw new Error("registerDriveTool never called server.registerTool");
  }
  return handler;
}

test("drive MCP tool <-> CLI `drive --config <path> --json` equivalence (baby_prd AC2)", async () => {
  const mcpFixture = await buildFixture();
  const cliFixture = await buildFixture();
  try {
    const handler = captureDriveHandler(mcpFixture.deps);
    const mcpResult = await handler(mcpFixture.config as unknown as Record<string, unknown>);
    assert.equal(mcpResult.isError, undefined);
    const mcpReport = mcpResult.structuredContent as DriveReport;

    const cliConfigPath = `${cliFixture.dir}/drive-config.json`;
    await writeFile(cliConfigPath, JSON.stringify(cliFixture.config, null, 2), "utf8");
    const { report: cliReport } = await runDriveCommand({ configPath: cliConfigPath, json: true }, cliFixture.deps);

    const strip = (r: DriveReport): Omit<DriveReport, "driver_run_id" | "generated_at" | "phases"> => {
      const { driver_run_id: _driver_run_id, generated_at: _generated_at, phases: _phases, ...rest } = r;
      return rest;
    };
    assert.deepStrictEqual(strip(mcpReport), strip(cliReport));
    assert.equal(mcpReport.ok, true);
    assert.equal(mcpReport.final_state_id, "D3_BUILD_COMPLETE_PRESENT");
  } finally {
    await cleanup(mcpFixture.dir);
    await cleanup(cliFixture.dir);
  }
});

test("drive MCP tool: a thrown error from a malformed config becomes isError:true (temp file cleaned up regardless, §7 FM-M5)", async () => {
  const handler = captureDriveHandler(undefined);
  const result = await handler({ not_a_valid_config: true });
  assert.equal(result.isError, true);
});

