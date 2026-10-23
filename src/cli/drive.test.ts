// Implements PHASE_6_SPEC.md §1.2 -- drive.test.ts
// runDriveCommand() config read/parse/validation-failure tests, mirroring run.test.ts's own shape,
// plus §8 acceptance criteria 14-16 (CLI surface, and the existing run/doctor/evidence regression
// guard).

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { UsageError } from "../domain/errors.ts";
import type { DriveConfig } from "../domain/driver.ts";
import type { DriveDispatchDeps } from "../dispatch/driver-loop.ts";
import type { RunResult } from "../dispatch/run-loop.ts";
import { runProcess } from "../util/exec.ts";
import { runDriveCommand, DriveReport } from "./drive.ts";

const MAIN_TS_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));
const RUN_TIMEOUT_MS = 120_000;
const DRIVER_RUN_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

async function runMain(args: readonly string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await runProcess({
    command: process.execPath,
    args: [MAIN_TS_PATH, ...args],
    cwd: process.cwd(),
    timeoutMs: RUN_TIMEOUT_MS,
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function validDriveConfigJson(dir: string, overrides: Partial<Record<string, unknown>> = {}): string {
  const config: Record<string, unknown> = {
    repo_dir: dir,
    driver_run_id: DRIVER_RUN_ID,
    starting_spec_path: "PHASE_1_SPEC.md",
    baby_prd_path: "baby_prd.md",
    context_path: "context.md",
    target_total_phases: 1,
    executor_providers: ["claude-code", "codex-cli"],
    ...overrides,
  };
  return JSON.stringify(config);
}

function okResult(exitCode = 0): RunResult {
  return { ok: true, exitCode, turns: [], halt: null, problems: [], warnings: [] };
}

test("runDriveCommand throws UsageError (exit 2) when the config file cannot be read", async () => {
  await assert.rejects(
    () => runDriveCommand({ configPath: "/definitely/does/not/exist.json", json: false }),
    (err: unknown) => {
      assert.ok(err instanceof UsageError);
      assert.equal(err.exitCode, 2);
      return true;
    },
  );
});

test("runDriveCommand throws UsageError (exit 2) when the config file is not valid JSON", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-drive-cli-test-`);
  try {
    const configPath = `${dir}/config.json`;
    await writeFile(configPath, "not valid json{{{", "utf8");
    await assert.rejects(
      () => runDriveCommand({ configPath, json: false }),
      (err: unknown) => {
        assert.ok(err instanceof UsageError);
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await cleanup(dir);
  }
});

test("runDriveCommand throws UsageError (exit 2, not a RelaySchemaError) when the config fails DriveConfig validation", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-drive-cli-test-`);
  try {
    const configPath = `${dir}/config.json`;
    await writeFile(configPath, JSON.stringify({ repo_dir: "/tmp/repo" }), "utf8");
    await assert.rejects(
      () => runDriveCommand({ configPath, json: false }),
      (err: unknown) => {
        assert.ok(err instanceof UsageError);
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await cleanup(dir);
  }
});

test("runDriveCommand dispatches a valid config via an injected runDispatchFn and returns a DriveReport whose exit_code passes through runDrive's own result", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-drive-cli-test-`);
  try {
    const configPath = `${dir}/config.json`;
    await writeFile(configPath, validDriveConfigJson(dir), "utf8");

    const deps: DriveDispatchDeps = {
      runDispatchFn: async () => {
        await writeFile(`${dir}/BUILD_COMPLETE.md`, "done\n", "utf8");
        return okResult();
      },
    };
    const { report, exitCode } = await runDriveCommand({ configPath, json: false }, deps);

    assert.equal(exitCode, report.exit_code);
    assert.equal(report.exit_code, 0);
    assert.equal(report.ok, true);
    assert.equal(report.driver_run_id, DRIVER_RUN_ID);
    assert.equal(report.final_state_id, "D3_BUILD_COMPLETE_PRESENT");
    assert.equal(report.phases.length, 2);
    DriveReport.parse(report);
  } finally {
    await cleanup(dir);
  }
});

test("runDriveCommand propagates a driver halt's own exit code (e.g. DRIVER_HALTED_AMBIGUOUS, 14) into DriveReport.exit_code", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-drive-cli-test-`);
  try {
    const configPath = `${dir}/config.json`;
    await writeFile(configPath, validDriveConfigJson(dir), "utf8");

    const deps: DriveDispatchDeps = { runDispatchFn: async () => okResult() };
    const { report, exitCode } = await runDriveCommand({ configPath, json: false }, deps);

    assert.equal(exitCode, 14);
    assert.equal(report.exit_code, 14);
    assert.equal(report.ok, false);
    assert.equal(report.final_state_id, "D4_NEITHER_PRESENT");
  } finally {
    await cleanup(dir);
  }
});

test("DriveConfig round-trips through runDriveCommand with starting_phase/max_phases defaults applied", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-drive-cli-test-`);
  try {
    const configPath = `${dir}/config.json`;
    await writeFile(configPath, validDriveConfigJson(dir), "utf8");
    const deps: DriveDispatchDeps = {
      runDispatchFn: async () => {
        await writeFile(`${dir}/BUILD_COMPLETE.md`, "done\n", "utf8");
        return okResult();
      },
    };
    const { report } = await runDriveCommand({ configPath, json: false }, deps);
    assert.equal(report.starting_phase, 1);
    assert.equal(report.max_phases, 25);
  } finally {
    await cleanup(dir);
  }
});

test("DriveConfig type usage (compile-time sanity): a hand-built DriveConfig object satisfies the schema", () => {
  const dir = "/tmp/target-repo";
  const config = {
    repo_dir: dir,
    driver_run_id: randomUUID(),
    starting_phase: 1,
    starting_spec_path: "PHASE_1_SPEC.md",
    baby_prd_path: "baby_prd.md",
    context_path: "context.md",
    target_total_phases: 3,
    max_phases: 25,
    executor_providers: ["claude-code", "codex-cli"],
    reviewer_provider: null,
    turn_timeout_ms: 1_800_000,
    build_complete_path: "BUILD_COMPLETE.md",
    chat_log_gitignored: true,
  } satisfies DriveConfig;
  assert.equal(config.repo_dir, dir);
});

test("CLI: OSA drive with no --config exits 2 before touching any file", async () => {
  const { exitCode, stdout, stderr } = await runMain(["drive"]);
  assert.equal(exitCode, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /--config/);
});

test("CLI: OSA drive --config <path> <unknown-flag> is a usage error (exit 2)", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-drive-cli-test-`);
  try {
    const { exitCode, stderr } = await runMain(["drive", "--config", `${dir}/does-not-matter.json`, "--not-a-real-flag"]);
    assert.equal(exitCode, 2);
    assert.match(stderr, /Unknown flag/);
  } finally {
    await cleanup(dir);
  }
});

test("CLI: OSA drive --config <path> where the JSON fails DriveConfig validation exits 2", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-drive-cli-test-`);
  try {
    const configPath = `${dir}/config.json`;
    await writeFile(configPath, JSON.stringify({ not: "a valid config" }), "utf8");
    const { exitCode, stdout, stderr } = await runMain(["drive", "--config", configPath]);
    assert.equal(exitCode, 2);
    assert.equal(stdout, "");
    assert.notEqual(stderr, "");
  } finally {
    await cleanup(dir);
  }
});

test("CLI: OSA drive --config <path> --json on a start-incoherent target (BUILD_COMPLETE.md already present) emits a single DriveReport-shaped JSON object on stdout (§8 AC15)", async () => {
  // Spawns a real `node src/cli/main.ts ...` process, so it can't accept an injected `deps` object
  // (main.ts's own call site never threads a deps override -- production stays untouched, the same
  // reasoning run.test.ts's own CLI-level `--json` test documents). This uses a target repo whose
  // BUILD_COMPLETE.md already exists, which checkDriverStartCoherence rejects deterministically
  // before any dispatch attempt -- so the real subprocess never needs a real provider CLI or a real
  // runDispatch() call to reach a terminal, JSON-emitting result on any machine.
  const dir = await mkdtemp(`${tmpdir()}/osa-drive-cli-test-`);
  try {
    await writeFile(`${dir}/BUILD_COMPLETE.md`, "already done\n", "utf8");
    const configPath = `${dir}/config.json`;
    await writeFile(configPath, validDriveConfigJson(dir), "utf8");

    const { exitCode, stdout } = await runMain(["drive", "--config", configPath, "--json"]);

    const parsed: unknown = JSON.parse(stdout);
    const report = DriveReport.parse(parsed);
    assert.equal(exitCode, report.exit_code);
    assert.equal(report.driver_run_id, DRIVER_RUN_ID);
    assert.equal(report.exit_code, 17);
    assert.equal(report.ok, false);
    assert.equal(report.final_state_id, "D0_NOT_STARTED");
    assert.deepStrictEqual(
      report.phases.map((p) => p.dispatched_run_id),
      [null],
    );
  } finally {
    await cleanup(dir);
  }
});

test("CLI: OSA run/doctor/evidence's own existing flag parsing is unchanged by the new drive command (§8 AC16 regression guard)", async () => {
  const { exitCode: runExit, stderr: runStderr } = await runMain(["run"]);
  assert.equal(runExit, 2);
  assert.match(runStderr, /--config/);

  const { exitCode: evidenceExit, stderr: evidenceStderr } = await runMain(["evidence"]);
  assert.equal(evidenceExit, 2);
  assert.match(evidenceStderr, /--repo-dir/);

  const { exitCode: doctorExit } = await runMain(["doctor", "--boundary", "--providers"]);
  assert.equal(doctorExit, 2);
});
