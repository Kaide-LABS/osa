// Implements PHASE_5_SPEC.md §1.2 -- evidence.test.ts
// Covers §8 acceptance criteria #19-22. Mirrors `run.test.ts`'s own coverage shape: direct calls to
// `runEvidenceCommand()` for flag-independent report-assembly behaviour, plus a handful of
// subprocess-spawned `node src/cli/main.ts evidence ...` invocations for the CLI-level argv-parsing
// and `--json` plumbing. No test in this file spawns a real `claude` or `codex` process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { FileRef, HandoffRecord } from "../domain/relay.ts";
import { writeHandoffRecord } from "../domain/relay.ts";
import type { ProviderId } from "../domain/run.ts";
import { runProcess } from "../util/exec.ts";
import { handoffPath } from "../util/paths.ts";
import { sha256File } from "../util/hash.ts";
import { runEvidenceCommand, EvidenceReport } from "./evidence.ts";

const MAIN_TS_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));
const EVIDENCE_TS_PATH = fileURLToPath(new URL("./evidence.ts", import.meta.url));
const RUN_TIMEOUT_MS = 120_000;
const RUN_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

async function runMain(args: readonly string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await runProcess({
    command: process.execPath,
    args: [MAIN_TS_PATH, ...args],
    cwd: process.cwd(),
    timeoutMs: RUN_TIMEOUT_MS,
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const result = await runProcess({ command: "git", args, cwd: repoDir, timeoutMs: RUN_TIMEOUT_MS });
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

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

interface LooprRefs {
  readonly babyPrd: FileRef;
  readonly context: FileRef;
  readonly spec: FileRef;
}

async function freshRepoWithLooprArtifacts(): Promise<{ dir: string; initialSha: string; refs: LooprRefs }> {
  const dir = await mkdtemp(`${tmpdir()}/osa-evidence-test-`);
  await initRepo(dir);
  await writeFile(`${dir}/baby_prd.md`, "baby prd content\n", "utf8");
  await writeFile(`${dir}/context.md`, "context content\n", "utf8");
  await writeFile(`${dir}/PHASE_1_SPEC.md`, "spec content\n", "utf8");
  await git(dir, ["add", "baby_prd.md", "context.md", "PHASE_1_SPEC.md"]);
  await git(dir, ["commit", "--quiet", "-m", "initial loopr artifacts"]);
  const initialSha = (await git(dir, ["rev-parse", "HEAD"])).trim();
  const refs: LooprRefs = {
    babyPrd: { path: "baby_prd.md", sha256: await sha256File(`${dir}/baby_prd.md`) },
    context: { path: "context.md", sha256: await sha256File(`${dir}/context.md`) },
    spec: { path: "PHASE_1_SPEC.md", sha256: await sha256File(`${dir}/PHASE_1_SPEC.md`) },
  };
  return { dir, initialSha, refs };
}

function record(overrides: {
  readonly turnIndex: number;
  readonly role: "executor" | "reviewer";
  readonly provider: ProviderId;
  readonly headBefore: string;
  readonly headAfter: string;
  readonly commits: readonly string[];
  readonly specRef: FileRef;
  readonly artifactsRead: readonly FileRef[];
  readonly artifactsWritten: readonly FileRef[];
}): HandoffRecord {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    phase: 1,
    turn_index: overrides.turnIndex,
    role: overrides.role,
    provider: overrides.provider,
    model_tier: "high-volume-low-effort",
    started_at: "2026-08-16T10:00:00Z",
    completed_at: "2026-08-16T10:05:00Z",
    repo: { branch: "main", head_before: overrides.headBefore, head_after: overrides.headAfter, commits: [...overrides.commits] },
    spec_ref: overrides.specRef,
    artifacts_read: [...overrides.artifactsRead],
    artifacts_written: [...overrides.artifactsWritten],
    status: "completed",
    work_done: "did some work",
    next_steps: [],
    open_questions: [],
    halt: null,
  };
}

async function writeTurn(dir: string, rec: HandoffRecord): Promise<void> {
  await writeHandoffRecord(handoffPath(dir, RUN_ID, 1, rec.turn_index, rec.role, rec.provider), rec);
}

/** Builds the same genuinely healthy 3-turn fixture `acceptance.test.ts`'s own §8 #10 test builds. */
async function buildHealthyFixture(): Promise<string> {
  const { dir, initialSha, refs } = await freshRepoWithLooprArtifacts();

  const headAfter0 = await commitFile(dir, "foo.txt", "v1\n", "turn0");
  const fooRef: FileRef = { path: "foo.txt", sha256: await sha256File(`${dir}/foo.txt`) };
  await writeTurn(
    dir,
    record({
      turnIndex: 0,
      role: "executor",
      provider: "claude-code",
      headBefore: initialSha,
      headAfter: headAfter0,
      commits: [headAfter0],
      specRef: refs.spec,
      artifactsRead: [refs.babyPrd, refs.context, refs.spec],
      artifactsWritten: [fooRef],
    }),
  );

  const headAfter1 = await commitFile(dir, "bar.txt", "v1\n", "turn1");
  const barRef: FileRef = { path: "bar.txt", sha256: await sha256File(`${dir}/bar.txt`) };
  await writeTurn(
    dir,
    record({
      turnIndex: 1,
      role: "executor",
      provider: "codex-cli",
      headBefore: headAfter0,
      headAfter: headAfter1,
      commits: [headAfter1],
      specRef: refs.spec,
      artifactsRead: [refs.babyPrd, refs.context, refs.spec, fooRef],
      artifactsWritten: [barRef],
    }),
  );

  const headAfter2 = await commitFile(dir, "BUILD_COMPLETE.md", "done\n", "turn2");
  const completeRef: FileRef = { path: "BUILD_COMPLETE.md", sha256: await sha256File(`${dir}/BUILD_COMPLETE.md`) };
  await writeTurn(
    dir,
    record({
      turnIndex: 2,
      role: "reviewer",
      provider: "claude-code",
      headBefore: headAfter1,
      headAfter: headAfter2,
      commits: [headAfter2],
      specRef: refs.spec,
      artifactsRead: [refs.babyPrd, refs.context, refs.spec, barRef],
      artifactsWritten: [completeRef],
    }),
  );

  return dir;
}

// -------------------------------------------------------------------------------------------
// runEvidenceCommand() -- direct calls
// -------------------------------------------------------------------------------------------

test("runEvidenceCommand: against a genuinely healthy fixture returns exit 0 and a report satisfying EvidenceReport with ok: true", async () => {
  const dir = await buildHealthyFixture();
  try {
    const { report, exitCode } = await runEvidenceCommand({ repoDir: dir, runId: RUN_ID, finalPhase: true, json: false });
    assert.equal(exitCode, 0);
    assert.equal(report.exit_code, 0);
    assert.equal(report.ok, true);
    assert.equal(report.turns_found, 3);
    EvidenceReport.parse(report);
  } finally {
    await cleanup(dir);
  }
});

test("runEvidenceCommand: against a repo with no persisted run returns exit 13 (ACCEPTANCE_INCOMPLETE), never throwing", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-evidence-test-`);
  try {
    const { report, exitCode } = await runEvidenceCommand({ repoDir: dir, runId: RUN_ID, finalPhase: false, json: false });
    assert.equal(exitCode, 13);
    assert.equal(report.exit_code, 13);
    assert.equal(report.ok, false);
    assert.equal(report.turns_found, 0);
    assert.ok(report.problems.length > 0);
    EvidenceReport.parse(report);
  } finally {
    await cleanup(dir);
  }
});

test("runEvidenceCommand: never calls process.exit (confirmed by direct source read, mirroring PHASE_1_SPEC.md §6.10's check for runDoctor())", async () => {
  const source = await readFile(EVIDENCE_TS_PATH, "utf8");
  // Checks for the actual call syntax, not the doc comment's own prose mention of "process.exit".
  assert.ok(!source.includes("process.exit("));
});

// -------------------------------------------------------------------------------------------
// CLI-level: `OSA evidence ...` -- §8 #19-21
// -------------------------------------------------------------------------------------------

test("CLI: OSA evidence --repo-dir <path> --run-id <uuid> --final-phase --json against the healthy fixture exits 0 and validates against EvidenceReport", async () => {
  const dir = await buildHealthyFixture();
  try {
    const { exitCode, stdout } = await runMain(["evidence", "--repo-dir", dir, "--run-id", RUN_ID, "--final-phase", "--json"]);
    assert.equal(exitCode, 0);
    const parsed: unknown = JSON.parse(stdout);
    const report = EvidenceReport.parse(parsed);
    assert.equal(report.ok, true);
    assert.equal(report.exit_code, 0);
  } finally {
    await cleanup(dir);
  }
});

test("CLI: OSA evidence with no --repo-dir exits 2", async () => {
  const { exitCode, stdout, stderr } = await runMain(["evidence", "--run-id", RUN_ID]);
  assert.equal(exitCode, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /--repo-dir/);
});

test("CLI: OSA evidence with no --run-id exits 2", async () => {
  const { exitCode, stdout, stderr } = await runMain(["evidence", "--repo-dir", "/tmp/does-not-matter"]);
  assert.equal(exitCode, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /--run-id/);
});

test("CLI: OSA evidence with an unknown flag exits 2", async () => {
  const { exitCode, stderr } = await runMain([
    "evidence",
    "--repo-dir",
    "/tmp/does-not-matter",
    "--run-id",
    RUN_ID,
    "--not-a-real-flag",
  ]);
  assert.equal(exitCode, 2);
  assert.match(stderr, /Unknown flag/);
});

test("CLI: OSA evidence against a repo with no persisted run exits 13", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-evidence-test-`);
  try {
    const { exitCode, stdout } = await runMain(["evidence", "--repo-dir", dir, "--run-id", RUN_ID, "--json"]);
    assert.equal(exitCode, 13);
    const report = EvidenceReport.parse(JSON.parse(stdout));
    assert.equal(report.exit_code, 13);
    assert.equal(report.ok, false);
  } finally {
    await cleanup(dir);
  }
});

test("CLI: OSA evidence without --json prints a human-readable report mentioning AC1/AC2/AC3", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-evidence-test-`);
  try {
    const { exitCode, stdout } = await runMain(["evidence", "--repo-dir", dir, "--run-id", RUN_ID]);
    assert.equal(exitCode, 13);
    assert.match(stdout, /^osa evidence --/);
    assert.match(stdout, /AC1/);
    assert.match(stdout, /AC2/);
    assert.match(stdout, /AC3/);
  } finally {
    await cleanup(dir);
  }
});
