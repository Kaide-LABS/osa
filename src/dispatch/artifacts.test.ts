// Implements PHASE_4_SPEC.md §1.1 -- artifacts.test.ts
// Covers §8 acceptance criteria #10-19. `assertNextPhaseSpecProduced()`'s own tests use a real
// temporary git repository (continuity.test.ts's and record.test.ts's own established pattern) --
// no test in this file spawns a real `claude` or `codex` process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LooprArtifactBypassError } from "../domain/errors.ts";
import type { HandoffRecord } from "../domain/relay.ts";
import { runProcess } from "../util/exec.ts";
import { assertLooprArtifactsReferenced, assertNextPhaseSpecProduced, nextPhaseSpecPath } from "./artifacts.ts";
import type { LooprArtifactPaths } from "./artifacts.ts";

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

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/osa-artifacts-test-`);
  await initRepo(dir);
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const LOOPR_PATHS: LooprArtifactPaths = {
  babyPrdPath: "baby_prd.md",
  contextPath: "context.md",
  specPath: "PHASE_1_SPEC.md",
};

function baseRecord(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    schema_version: 1,
    run_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    phase: 1,
    turn_index: 0,
    role: "executor",
    provider: "claude-code",
    model_tier: "high-volume-low-effort",
    started_at: "2026-08-16T10:00:00Z",
    completed_at: "2026-08-16T10:05:00Z",
    repo: { branch: "main", head_before: "0".repeat(40), head_after: "1".repeat(40), commits: ["1".repeat(40)] },
    spec_ref: { path: "PHASE_1_SPEC.md", sha256: "1".repeat(64) },
    artifacts_read: [],
    artifacts_written: [],
    status: "completed",
    work_done: "did some work",
    next_steps: [],
    open_questions: [],
    halt: null,
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// nextPhaseSpecPath() -- §8 acceptance criteria #10-12
// -------------------------------------------------------------------------------------------

test("nextPhaseSpecPath: increments the phase number onto a root-level spec path", () => {
  assert.equal(nextPhaseSpecPath("PHASE_3_SPEC.md", 3, false), "PHASE_4_SPEC.md");
});

test("nextPhaseSpecPath: preserves the spec path's own directory prefix", () => {
  assert.equal(nextPhaseSpecPath("specs/PHASE_2_SPEC.md", 2, false), "specs/PHASE_3_SPEC.md");
});

test("nextPhaseSpecPath: isFinalPhase overrides the phase-increment branch entirely, regardless of phase's value", () => {
  assert.equal(nextPhaseSpecPath("PHASE_5_SPEC.md", 5, true), "BUILD_COMPLETE.md");
  assert.equal(nextPhaseSpecPath("specs/PHASE_9_SPEC.md", 9, true), "BUILD_COMPLETE.md");
});

// -------------------------------------------------------------------------------------------
// assertLooprArtifactsReferenced() -- §8 acceptance criteria #13-14
// -------------------------------------------------------------------------------------------

test("assertLooprArtifactsReferenced: passes when artifacts_read contains all three required paths", () => {
  const record = baseRecord({
    artifacts_read: [
      { path: "baby_prd.md", sha256: "a".repeat(64) },
      { path: "context.md", sha256: "b".repeat(64) },
      { path: "PHASE_1_SPEC.md", sha256: "c".repeat(64) },
    ],
  });
  assert.doesNotThrow(() => {
    assertLooprArtifactsReferenced(record, LOOPR_PATHS);
  });
});

test("assertLooprArtifactsReferenced: throws LooprArtifactBypassError naming every missing path when none are referenced", () => {
  const record = baseRecord({ artifacts_read: [] });
  assert.throws(
    () => {
      assertLooprArtifactsReferenced(record, LOOPR_PATHS);
    },
    (err: unknown) => {
      assert.ok(err instanceof LooprArtifactBypassError);
      assert.equal(err.exitCode, 12);
      assert.ok(err.message.includes("baby_prd.md"));
      assert.ok(err.message.includes("context.md"));
      assert.ok(err.message.includes("PHASE_1_SPEC.md"));
      assert.deepStrictEqual(err.details["missingPaths"], ["baby_prd.md", "context.md", "PHASE_1_SPEC.md"]);
      return true;
    },
  );
});

test("assertLooprArtifactsReferenced: throws naming only the paths actually missing when exactly one is present", () => {
  const record = baseRecord({
    artifacts_read: [{ path: "baby_prd.md", sha256: "a".repeat(64) }],
  });
  assert.throws(
    () => {
      assertLooprArtifactsReferenced(record, LOOPR_PATHS);
    },
    (err: unknown) => {
      assert.ok(err instanceof LooprArtifactBypassError);
      assert.ok(!err.message.includes('"baby_prd.md"'));
      assert.ok(err.message.includes("context.md"));
      assert.ok(err.message.includes("PHASE_1_SPEC.md"));
      assert.deepStrictEqual(err.details["missingPaths"], ["context.md", "PHASE_1_SPEC.md"]);
      return true;
    },
  );
});

test("assertLooprArtifactsReferenced: throws naming only the one path missing when two of three are present", () => {
  const record = baseRecord({
    artifacts_read: [
      { path: "baby_prd.md", sha256: "a".repeat(64) },
      { path: "context.md", sha256: "b".repeat(64) },
    ],
  });
  assert.throws(
    () => {
      assertLooprArtifactsReferenced(record, LOOPR_PATHS);
    },
    (err: unknown) => {
      assert.ok(err instanceof LooprArtifactBypassError);
      assert.deepStrictEqual(err.details["missingPaths"], ["PHASE_1_SPEC.md"]);
      return true;
    },
  );
});

// -------------------------------------------------------------------------------------------
// assertNextPhaseSpecProduced() -- §8 acceptance criteria #16-18 (real temp git repos)
// -------------------------------------------------------------------------------------------

test("assertNextPhaseSpecProduced: passes when artifacts_written declares the path and the turn's own commits genuinely touch it", async () => {
  const dir = await freshRepo();
  try {
    const headBefore = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const headAfter = await commitFile(dir, "PHASE_2_SPEC.md", "phase 2 content\n", "reviewer writes next spec");

    const record = baseRecord({
      role: "reviewer",
      repo: { branch: "main", head_before: headBefore, head_after: headAfter, commits: [headAfter] },
      artifacts_written: [{ path: "PHASE_2_SPEC.md", sha256: "d".repeat(64) }],
    });

    await assert.doesNotReject(() => assertNextPhaseSpecProduced(dir, record, "PHASE_2_SPEC.md"));
  } finally {
    await cleanup(dir);
  }
});

test("assertNextPhaseSpecProduced: throws LooprArtifactBypassError when the expected path is never declared in artifacts_written", async () => {
  const dir = await freshRepo();
  try {
    const headBefore = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const headAfter = await commitFile(dir, "PHASE_2_SPEC.md", "phase 2 content\n", "reviewer writes next spec");

    const record = baseRecord({
      role: "reviewer",
      repo: { branch: "main", head_before: headBefore, head_after: headAfter, commits: [headAfter] },
      artifacts_written: [],
    });

    await assert.rejects(
      () => assertNextPhaseSpecProduced(dir, record, "PHASE_2_SPEC.md"),
      (err: unknown) => {
        assert.ok(err instanceof LooprArtifactBypassError);
        assert.equal(err.exitCode, 12);
        assert.equal((err.details as { reason?: string })["reason"], "never_declared");
        return true;
      },
    );
  } finally {
    await cleanup(dir);
  }
});

test("assertNextPhaseSpecProduced: throws LooprArtifactBypassError, distinguishable from the never-declared case, when the path is declared but the turn's commits never touch it (a stale, pre-existing file merely re-declared)", async () => {
  const dir = await freshRepo();
  try {
    // PHASE_2_SPEC.md already exists BEFORE this turn starts (a stale leftover) and this turn's
    // own commit range never touches it -- only an unrelated file.
    await commitFile(dir, "PHASE_2_SPEC.md", "stale pre-existing content\n", "stale pre-existing spec");
    const headBefore = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const headAfter = await commitFile(dir, "unrelated.txt", "noise\n", "reviewer's turn (never touches PHASE_2_SPEC.md)");

    const record = baseRecord({
      role: "reviewer",
      repo: { branch: "main", head_before: headBefore, head_after: headAfter, commits: [headAfter] },
      artifacts_written: [{ path: "PHASE_2_SPEC.md", sha256: "d".repeat(64) }],
    });

    await assert.rejects(
      () => assertNextPhaseSpecProduced(dir, record, "PHASE_2_SPEC.md"),
      (err: unknown) => {
        assert.ok(err instanceof LooprArtifactBypassError);
        assert.equal(err.exitCode, 12);
        assert.equal((err.details as { reason?: string })["reason"], "declared_but_not_touched");
        return true;
      },
    );
  } finally {
    await cleanup(dir);
  }
});
