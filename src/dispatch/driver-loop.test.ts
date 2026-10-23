// Implements PHASE_6_SPEC.md §1.2 -- driver-loop.test.ts
// runDrive() integration tests against real temporary directories with an injected fake
// `runDispatchFn` (DriveDispatchDeps's own test seam -- PHASE_6_SPEC.md §6.4) standing in for a
// real per-phase turn dispatch. Covers baby_prd.md acceptance criteria 3, 4, 5, 6, 7 and §8
// acceptance criteria 9-13, FM-D6, FM-D7, FM-D8.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { DriveConfig } from "../domain/driver.ts";
import { DriverLogEntry } from "../domain/driver.ts";
import { ChatLogEntry } from "../domain/chat-log.ts";
import { InternalError } from "../domain/errors.ts";
import type { FileRef, HaltSignal, HandoffRecord } from "../domain/relay.ts";
import { writeHandoffRecord } from "../domain/relay.ts";
import type { ProviderId, RawInvocationResult, RunConfig, TurnOutcome, TurnRequest } from "../domain/run.ts";
import type { AdapterRegistry, Invocation, PreflightReport, ProviderAdapter } from "../ports/provider-adapter.ts";
import { runProcess } from "../util/exec.ts";
import { chatLogPath, handoffPath } from "../util/paths.ts";
import { sha256File } from "../util/hash.ts";
import type { PreflightSummary } from "../verify/preflight.ts";
import type { RunResult } from "./run-loop.ts";
import { driverLogPath } from "../util/paths.ts";
import { runDrive } from "./driver-loop.ts";

async function freshRepo(): Promise<string> {
  return mkdtemp(`${tmpdir()}/osa-driver-loop-test-`);
}

const GIT_TIMEOUT_MS = 120_000;

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const result = await runProcess({ command: "git", args, cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${String(result.exitCode)}): ${result.stderr}`);
  }
  return result.stdout;
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "--quiet", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
}

async function commitFile(dir: string, relPath: string, content: string, message: string): Promise<string> {
  await writeFile(`${dir}/${relPath}`, content, "utf8");
  await git(dir, ["add", relPath]);
  await git(dir, ["commit", "--quiet", "-m", message]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

/** A real git repo, seeded exactly like `run-loop.test.ts`'s own `freshRepoWithSpec()`, for the one AC1-a test in this file that drives a real (unfaked) `runDispatch` across two real phases. */
async function freshGitRepoWithSpec(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/osa-driver-loop-ac1a-test-`);
  await initRepo(dir);
  await commitFile(dir, "PHASE_1_SPEC.md", "spec content\n", "add spec");
  await commitFile(dir, "baby_prd.md", "baby prd content\n", "add baby_prd.md");
  await commitFile(dir, "context.md", "context content\n", "add context.md");
  return dir;
}

/**
 * A synthetic, always-healthy `PreflightSummary`, the identical fixture `run-loop.test.ts` already
 * uses for the same reason: the real `runPreflight()` shells out to real provider CLIs with no
 * injection seam, which would make AC1-a's real (unfaked) `runDispatch` call fail at
 * PREFLIGHT_FAILED on this machine before ever reaching the turn loop under test.
 */
function fakeHealthyPreflight(): Promise<PreflightSummary> {
  return Promise.resolve({
    node: { found: true, version: "24.15.0", inRange: true },
    git: { found: true, version: "2.54.0", inRange: true },
    providers: [
      { provider: "claude-code", cliFound: true, version: "2.1.211", versionInRange: true, authenticated: true, authState: "authenticated", problems: [] },
      { provider: "codex-cli", cliFound: true, version: "0.128.0", versionInRange: true, authenticated: true, authState: "authenticated", problems: [] },
    ],
    ok: true,
    problems: [],
  });
}

/** A schema-valid draft `HandoffRecord`, identical in spirit to `run-loop.test.ts`'s own `draft()` -- `reconcileHandoffRecord` only ever replaces `repo`/`spec_ref`/artifact hashes, so any schema-valid placeholder is sufficient for the rest. */
function draft(overrides: {
  readonly role?: "executor" | "reviewer";
  readonly artifactsRead?: readonly FileRef[];
  readonly artifactsWritten?: readonly FileRef[];
} = {}): HandoffRecord {
  return {
    schema_version: 1,
    run_id: "00000000-0000-0000-0000-000000000000",
    phase: 1,
    turn_index: 0,
    role: overrides.role ?? "executor",
    provider: "claude-code",
    model_tier: "high-volume-low-effort",
    started_at: "2026-08-16T10:00:00Z",
    completed_at: "2026-08-16T10:05:00Z",
    repo: { branch: "placeholder", head_before: "0".repeat(40), head_after: "1".repeat(40), commits: ["1".repeat(40)] },
    spec_ref: { path: "PLACEHOLDER.md", sha256: "0".repeat(64) },
    artifacts_read: overrides.artifactsRead ? [...overrides.artifactsRead] : [],
    artifacts_written: overrides.artifactsWritten ? [...overrides.artifactsWritten] : [],
    status: "completed",
    work_done: "did work",
    next_steps: [],
    open_questions: [],
    halt: null satisfies HaltSignal | null,
  };
}

/**
 * Records every `TurnRequest` it is asked to build an invocation for into one SHARED array, in real
 * dispatch order, regardless of which provider instance is asked -- this is what lets the AC1-a
 * test's fake `runProcessFn` (which only receives `RunProcessOptions`, never the `TurnRequest`
 * itself) recover the real `runId`/`phase`/`turnIndex`/`archetype`/`provider` for the turn it is
 * currently being asked to spawn, purely from its own call index.
 */
class SharedRecordingFakeAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly seen: TurnRequest[];
  constructor(id: ProviderId, seen: TurnRequest[]) {
    this.id = id;
    this.seen = seen;
  }
  preflight(): Promise<PreflightReport> {
    return Promise.resolve({ provider: this.id, cliFound: true, version: "1.0.0", versionInRange: true, authenticated: true, authState: "authenticated", problems: [] });
  }
  resolveEffort(): string {
    return "low";
  }
  buildInvocation(req: TurnRequest): Invocation {
    this.seen.push(req);
    return { command: "fake-cli", args: [], env: {}, cwd: req.repoDir, stdin: req.prompt };
  }
  interpretResult(raw: RawInvocationResult): TurnOutcome {
    if (raw.exitCode !== 0) {
      return { ok: false, record: null, failure: new InternalError(raw.stderr || "fake-cli failed") };
    }
    return { ok: true, record: null, failure: null };
  }
}

function baseDriveConfig(dir: string, overrides: Partial<DriveConfig> = {}): DriveConfig {
  return {
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
    ...overrides,
  };
}

function okResult(exitCode = 0): RunResult {
  return { ok: true, exitCode, turns: [], halt: null, problems: [], warnings: [] };
}

function errResult(exitCode: number, problems: readonly string[]): RunResult {
  return { ok: false, exitCode, turns: [], halt: null, problems, warnings: [] };
}

test("runDrive (FM-D7) halts with DRIVER_START_INCOHERENT when BUILD_COMPLETE.md already exists before any dispatch, and dispatches nothing", async () => {
  const dir = await freshRepo();
  try {
    await writeFile(`${dir}/BUILD_COMPLETE.md`, "already done\n", "utf8");
    let dispatchCount = 0;
    const config = baseDriveConfig(dir);
    const result = await runDrive(config, {
      runDispatchFn: async () => {
        dispatchCount += 1;
        return okResult();
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 17);
    assert.equal(result.finalStateId, "D0_NOT_STARTED");
    assert.equal(dispatchCount, 0);
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0]?.dispatched_run_id, null);
    assert.equal(result.phases[0]?.dispatched_run_exit_code, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDrive (baby_prd.md AC3, §8 AC9, D4) halts with DRIVER_HALTED_AMBIGUOUS when a completed phase produces neither artifact, and never dispatches a next phase", async () => {
  const dir = await freshRepo();
  try {
    const config = baseDriveConfig(dir);
    let dispatchCount = 0;
    const result = await runDrive(config, {
      runDispatchFn: async () => {
        dispatchCount += 1;
        return okResult();
      },
    });
    assert.equal(result.exitCode, 14);
    assert.equal(result.ok, false);
    assert.equal(result.finalStateId, "D4_NEITHER_PRESENT");
    assert.equal(dispatchCount, 1);
    assert.equal(result.problems.length, 1);
    assert.ok(result.problems[0]?.toLowerCase().includes("ambiguous"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDrive (baby_prd.md AC4, §8 AC10, D5) halts with DRIVER_HALTED_INCOHERENT when a completed phase produces both artifacts, and does not pick one", async () => {
  const dir = await freshRepo();
  try {
    const config = baseDriveConfig(dir);
    const result = await runDrive(config, {
      runDispatchFn: async () => {
        await writeFile(`${dir}/PHASE_2_SPEC.md`, "next spec\n", "utf8");
        await writeFile(`${dir}/BUILD_COMPLETE.md`, "done\n", "utf8");
        return okResult();
      },
    });
    assert.equal(result.exitCode, 15);
    assert.equal(result.ok, false);
    assert.equal(result.finalStateId, "D5_BOTH_PRESENT");
    assert.ok(result.problems[0]?.toLowerCase().includes("incoherent"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDrive (baby_prd.md AC5, §8 AC11) walks a real 2-phase fixture build to BUILD_COMPLETE.md in one invocation, with no manual re-invocation", async () => {
  const dir = await freshRepo();
  try {
    const config = baseDriveConfig(dir, { target_total_phases: 2 });
    const dispatchedPhases: number[] = [];
    const isFinalByPhase: Record<number, boolean> = {};
    const result = await runDrive(config, {
      runDispatchFn: async (runConfig) => {
        dispatchedPhases.push(runConfig.phase);
        isFinalByPhase[runConfig.phase] = runConfig.is_final_phase;
        if (runConfig.phase === 1) {
          await writeFile(`${dir}/PHASE_2_SPEC.md`, "next spec\n", "utf8");
        } else {
          await writeFile(`${dir}/BUILD_COMPLETE.md`, "done\n", "utf8");
        }
        return okResult();
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.finalStateId, "D3_BUILD_COMPLETE_PRESENT");
    assert.deepEqual(dispatchedPhases, [1, 2]);
    // FM-D8: is_final_phase === phase >= target_total_phases, computed at exactly one call site.
    assert.equal(isFinalByPhase[1], false);
    assert.equal(isFinalByPhase[2], true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDrive (PHASE_7_SPEC.md §6.4/FM-P5) threads role_pins unchanged into every dispatched phase's own RunConfig, across at least two consecutive phases", async () => {
  const dir = await freshRepo();
  try {
    const rolePins = { "claude-code": "executor", "codex-cli": "reviewer" } as const;
    const config = baseDriveConfig(dir, { target_total_phases: 3, role_pins: rolePins });
    const seenRolePins: unknown[] = [];
    const result = await runDrive(config, {
      runDispatchFn: async (runConfig) => {
        seenRolePins.push(runConfig.role_pins);
        if (runConfig.phase < 3) {
          await writeFile(`${dir}/PHASE_${String(runConfig.phase + 1)}_SPEC.md`, "next spec\n", "utf8");
        } else {
          await writeFile(`${dir}/BUILD_COMPLETE.md`, "done\n", "utf8");
        }
        return okResult();
      },
    });
    assert.equal(result.ok, true);
    assert.equal(seenRolePins.length, 3);
    for (const seen of seenRolePins) {
      assert.deepEqual(seen, rolePins);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDrive (PHASE_7_SPEC.md §6.4) omits role_pins entirely from a dispatched phase's RunConfig when DriveConfig carries none", async () => {
  const dir = await freshRepo();
  try {
    const config = baseDriveConfig(dir, { target_total_phases: 1 });
    let dispatchedHasKey = true;
    const result = await runDrive(config, {
      runDispatchFn: async (runConfig) => {
        dispatchedHasKey = Object.prototype.hasOwnProperty.call(runConfig, "role_pins");
        await writeFile(`${dir}/BUILD_COMPLETE.md`, "done\n", "utf8");
        return okResult();
      },
    });
    assert.equal(result.ok, true);
    assert.equal(dispatchedHasKey, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDrive (baby_prd.md AC6, §8 AC12, FM-D6) stops at the configured max-phases cap and reports the cap, not a false build-finished claim", async () => {
  const dir = await freshRepo();
  try {
    const config = baseDriveConfig(dir, { target_total_phases: 100, max_phases: 3 });
    let dispatchCount = 0;
    const result = await runDrive(config, {
      runDispatchFn: async (runConfig) => {
        dispatchCount += 1;
        await writeFile(`${dir}/PHASE_${String(runConfig.phase + 1)}_SPEC.md`, "next spec\n", "utf8");
        return okResult();
      },
    });
    assert.equal(result.exitCode, 16);
    assert.equal(result.ok, false);
    assert.equal(dispatchCount, 3);
    assert.ok(result.problems[0]?.toLowerCase().includes("cap"));
    // The reason explicitly denies a false "build finished" claim (PHASE_6_SPEC.md §6.5's own
    // literal wording is "not because the build finished") -- the halt is attributed to the cap.
    assert.ok(result.problems[0]?.toLowerCase().includes("not because the build finished"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDrive (baby_prd.md AC7, §8 AC13, FM-D9) writes a durable, append-only dispatch log a fresh reader can reconstruct without re-running anything", async () => {
  const dir = await freshRepo();
  try {
    const config = baseDriveConfig(dir, { target_total_phases: 2 });
    const result = await runDrive(config, {
      runDispatchFn: async (runConfig) => {
        if (runConfig.phase === 1) {
          await writeFile(`${dir}/PHASE_2_SPEC.md`, "next spec\n", "utf8");
        } else {
          await writeFile(`${dir}/BUILD_COMPLETE.md`, "done\n", "utf8");
        }
        return okResult();
      },
    });

    const logPath = driverLogPath(dir, config.driver_run_id);
    const raw = await readFile(logPath, "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, result.phases.length);

    const parsed = lines.map((line) => DriverLogEntry.parse(JSON.parse(line) as unknown));
    assert.deepEqual(
      parsed.map((p) => p.state_id),
      result.phases.map((p) => p.state_id),
    );
    assert.deepEqual(
      parsed.map((p) => p.decision_kind),
      result.phases.map((p) => p.decision_kind),
    );
    assert.equal(parsed[parsed.length - 1]?.decision_kind, "stop");
    assert.equal(parsed[parsed.length - 1]?.exit_code, 0);
    for (const entry of parsed) {
      assert.equal(entry.driver_run_id, config.driver_run_id);
      assert.ok(entry.reason.length > 0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDrive (D1_RUN_ERRORED) halts and propagates the failing runDispatch()'s own exit code, never a driver-invented one", async () => {
  const dir = await freshRepo();
  try {
    const config = baseDriveConfig(dir);
    const result = await runDrive(config, {
      runDispatchFn: async () => errResult(3, ["preflight failed: git not found"]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.equal(result.finalStateId, "D1_RUN_ERRORED");
    assert.ok(result.problems[0]?.includes("preflight failed"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDrive honors a custom build_complete_path, ignoring an unrelated BUILD_COMPLETE.md at repo root left by another loopr-managed build track", async () => {
  const dir = await freshRepo();
  try {
    // An unrelated build track's own completion marker, already sitting at root before this
    // driver invocation starts.
    await writeFile(`${dir}/BUILD_COMPLETE.md`, "unrelated track, already done\n", "utf8");
    const config = baseDriveConfig(dir, { build_complete_path: "BUILD_COMPLETE_V3.md" });
    let dispatchCount = 0;
    const result = await runDrive(config, {
      runDispatchFn: async () => {
        dispatchCount += 1;
        await writeFile(`${dir}/BUILD_COMPLETE_V3.md`, "this track is done\n", "utf8");
        return okResult();
      },
    });
    // Must not halt on start-incoherence over the unrelated root BUILD_COMPLETE.md.
    assert.equal(dispatchCount, 1);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.finalStateId, "D3_BUILD_COMPLETE_PRESENT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDrive dispatches config.starting_phase, not a hardcoded 1 (resume support)", async () => {
  const dir = await freshRepo();
  try {
    const config = baseDriveConfig(dir, {
      starting_phase: 4,
      starting_spec_path: "PHASE_4_SPEC.md",
      target_total_phases: 4,
    });
    let seenPhase: number | null = null;
    const result = await runDrive(config, {
      runDispatchFn: async (runConfig) => {
        seenPhase = runConfig.phase;
        await writeFile(`${dir}/BUILD_COMPLETE.md`, "done\n", "utf8");
        return okResult();
      },
    });
    assert.equal(seenPhase, 4);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDrive (PHASE_10_SPEC.md §8.1 AC1-a) a real two-phase drive, dispatched through the REAL (unfaked) runDispatch via the adapters/runProcessFn/preflightFn seams, produces ONE ordered, complete, byte-identical chat log spanning both phases and both providers", async () => {
  // Deliberately does NOT use `runDispatchFn` (every other test in this file does): AC1-a exists to
  // prove the chat log is correct end to end through the real per-phase turn dispatch, so this test
  // lets `runDrive` call the real, unmodified `runDispatch` (`src/dispatch/run-loop.ts`) and fakes
  // only the injection seams that function already exposes for exactly this purpose -- adapters,
  // runProcessFn, preflightFn -- so no `claude`/`codex` process is ever spawned.
  const dir = await freshGitRepoWithSpec();
  try {
    const config = baseDriveConfig(dir, { target_total_phases: 2 });
    const seenRequests: TurnRequest[] = [];
    const claude = new SharedRecordingFakeAdapter("claude-code", seenRequests);
    const codex = new SharedRecordingFakeAdapter("codex-cli", seenRequests);
    const adapters: Partial<AdapterRegistry> = { "claude-code": claude, "codex-cli": codex };

    const babyPrdRef: FileRef = { path: "baby_prd.md", sha256: await sha256File(`${dir}/baby_prd.md`) };
    const contextRef: FileRef = { path: "context.md", sha256: await sha256File(`${dir}/context.md`) };

    const responses: { stdout: string; stderr: string }[] = [];
    let lastWrittenRef: FileRef | null = null;
    let call = 0;
    const runProcessFn: typeof runProcess = async () => {
      const step = call;
      call += 1;
      const req = seenRequests[step];
      if (req === undefined) {
        throw new Error(`runProcessFn invoked before buildInvocation recorded a TurnRequest for step ${String(step)}`);
      }
      if (req.turnIndex === 0) {
        lastWrittenRef = null; // a fresh phase's own turn loop starts over at turn_index 0
      }
      const stdout = `stdout for phase ${String(req.phase)} turn ${String(req.turnIndex)} (${req.archetype}/${req.provider})`;
      const stderr = `stderr for phase ${String(req.phase)} turn ${String(req.turnIndex)}`;
      responses.push({ stdout, stderr });

      const artifactsRead: FileRef[] = [babyPrdRef, contextRef, req.specRef];
      if (lastWrittenRef !== null) {
        artifactsRead.push(lastWrittenRef);
      }

      if (req.archetype === "executor") {
        const fileName = `artifact-p${String(req.phase)}-t${String(req.turnIndex)}.txt`;
        await commitFile(dir, fileName, `content for step ${String(step)}\n`, `phase ${String(req.phase)} turn ${String(req.turnIndex)}`);
        const fileRef: FileRef = { path: fileName, sha256: await sha256File(`${dir}/${fileName}`) };
        await writeHandoffRecord(
          handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider),
          draft({ artifactsRead, artifactsWritten: [fileRef] }),
        );
        lastWrittenRef = fileRef;
      } else {
        const isFinalPhase = req.phase >= 2;
        const nextFileName = isFinalPhase ? "BUILD_COMPLETE.md" : `PHASE_${String(req.phase + 1)}_SPEC.md`;
        await commitFile(dir, nextFileName, `next artifact produced by phase ${String(req.phase)}'s reviewer\n`, `phase ${String(req.phase)} reviewer`);
        const nextRef: FileRef = { path: nextFileName, sha256: await sha256File(`${dir}/${nextFileName}`) };
        await writeHandoffRecord(
          handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider),
          draft({ role: "reviewer", artifactsRead, artifactsWritten: [nextRef] }),
        );
      }
      return { exitCode: 0, signal: null, stdout, stderr, durationMs: 1, timedOut: false };
    };

    const result = await runDrive(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, true, `expected a clean build-complete; got: ${JSON.stringify(result)}`);
    assert.equal(result.exitCode, 0);
    assert.equal(seenRequests.length, 6); // 3 turns/phase x 2 phases, no retries in this fixture
    // Both providers genuinely appear across the phases.
    assert.ok(seenRequests.some((r) => r.provider === "claude-code"));
    assert.ok(seenRequests.some((r) => r.provider === "codex-cli"));

    // 1. Exactly one log file exists, named `<driver_run_id>.jsonl`.
    const chatLogDirEntries = await readdir(`${dir}/.osa/chat-log`);
    const jsonlEntries = chatLogDirEntries.filter((f) => f.endsWith(".jsonl"));
    assert.deepStrictEqual(jsonlEntries, [`${config.driver_run_id}.jsonl`]);

    const raw = await readFile(chatLogPath(dir, config.driver_run_id), "utf8");
    const lines = raw.trim().split("\n");

    // 2. Every line parses as JSON and validates against ChatLogEntry.
    const entries = lines.map((line) => ChatLogEntry.parse(JSON.parse(line) as unknown));

    // 3. Entry count === 2 x (number of turn attempts across both phases).
    assert.equal(entries.length, 12);

    // 4. For each turn attempt, exactly one prompt and one response entry share
    //    (run_id, phase, turn_index) -- and dispatch is strictly sequential, so entries appear as
    //    consecutive [prompt, response] pairs in real dispatch order.
    for (let i = 0; i < 6; i += 1) {
      const promptEntry = entries[2 * i];
      const responseEntry = entries[2 * i + 1];
      const req = seenRequests[i];
      assert.ok(promptEntry && responseEntry && req);
      assert.equal(promptEntry.entry_kind, "prompt");
      assert.equal(responseEntry.entry_kind, "response");
      assert.equal(promptEntry.run_id, req.runId);
      assert.equal(responseEntry.run_id, req.runId);
      assert.equal(promptEntry.phase, req.phase);
      assert.equal(promptEntry.turn_index, req.turnIndex);
      assert.equal(responseEntry.phase, req.phase);
      assert.equal(responseEntry.turn_index, req.turnIndex);

      // 5. Byte-identical prompt/response content.
      assert.equal(promptEntry.transcript.prompt, req.prompt);
      assert.equal(responseEntry.transcript.stdout, responses[i]?.stdout);
      assert.equal(responseEntry.transcript.stderr, responses[i]?.stderr);

      // 6. provider/role/model_tier/model_override/spec_ref match the real per-turn values.
      for (const entry of [promptEntry, responseEntry]) {
        assert.equal(entry.provider, req.provider);
        assert.equal(entry.role, req.archetype);
        assert.equal(entry.model_tier, req.tier);
        assert.equal(entry.model_override, req.modelOverride);
        assert.deepStrictEqual(entry.spec_ref, req.specRef);
      }
    }

    // 7. written_at parses as an ISO-8601 UTC instant and is non-decreasing down the file.
    for (const entry of entries) {
      assert.ok(!Number.isNaN(Date.parse(entry.written_at)), `not a parseable timestamp: ${entry.written_at}`);
    }
    for (let i = 1; i < entries.length; i += 1) {
      assert.ok((entries[i]?.written_at ?? "") >= (entries[i - 1]?.written_at ?? ""), "written_at must be non-decreasing down the file");
    }

    // 8. File order equals real dispatch order: phase 1's entries all precede phase 2's, and within
    //    a phase, turn_index is non-decreasing.
    const phases = entries.map((e) => e.phase);
    const firstPhase2Index = phases.indexOf(2);
    assert.ok(firstPhase2Index > 0, "phase 2 entries must exist and follow phase 1's");
    assert.ok(phases.slice(0, firstPhase2Index).every((p) => p === 1));
    assert.ok(phases.slice(firstPhase2Index).every((p) => p === 2));
    for (const phaseNum of [1, 2]) {
      const turnIndices = entries.filter((e) => e.phase === phaseNum).map((e) => e.turn_index);
      for (let i = 1; i < turnIndices.length; i += 1) {
        assert.ok((turnIndices[i] ?? -1) >= (turnIndices[i - 1] ?? -1), `turn_index must be non-decreasing within phase ${String(phaseNum)}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});



