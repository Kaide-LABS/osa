// Implements PHASE_5_SPEC.md §1.1 -- acceptance.test.ts
// Covers §8 acceptance criteria #10-18 and #28. Every AC1-3 test uses a real temporary git
// repository and real, hand-constructed `HandoffRecord` JSON files written to a real `handoff/`
// directory (`continuity.test.ts`'s and `artifacts.test.ts`'s own established pattern) -- no test in
// this file spawns a real `claude` or `codex` process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { FileRef, HandoffRecord } from "../domain/relay.ts";
import { writeHandoffRecord } from "../domain/relay.ts";
import type { ProviderId } from "../domain/run.ts";
import { RunConfig } from "../domain/run.ts";
import { runProcess } from "../util/exec.ts";
import { handoffPath } from "../util/paths.ts";
import { sha256File } from "../util/hash.ts";
import { assessAcceptanceEvidence } from "./acceptance.ts";

const GIT_TIMEOUT_MS = 120_000;
const RUN_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

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

async function removeAndCommit(dir: string, relPath: string, message: string): Promise<string> {
  await git(dir, ["rm", "--quiet", relPath]);
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

/** Fresh repo with `baby_prd.md`/`context.md`/`PHASE_1_SPEC.md` committed at the root as an
 * "operator" initial commit, mirroring `examples/toy-build/README.md` step 1 and `run.test.ts`'s own
 * `freshRepoWithSpec()`. */
async function freshRepoWithLooprArtifacts(): Promise<{ dir: string; initialSha: string; refs: LooprRefs }> {
  const dir = await mkdtemp(`${tmpdir()}/osa-acceptance-test-`);
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
  readonly status?: "completed" | "blocked" | "halted";
  readonly phase?: number;
}): HandoffRecord {
  const status = overrides.status ?? "completed";
  return {
    schema_version: 1,
    run_id: RUN_ID,
    phase: overrides.phase ?? 1,
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
    status,
    work_done: "did some work",
    next_steps: [],
    open_questions: [],
    halt: status === "halted" ? { code: "TOY_HALT", message: "halted for test purposes" } : null,
  };
}

async function writeTurn(dir: string, phase: number, rec: HandoffRecord): Promise<void> {
  await writeHandoffRecord(handoffPath(dir, RUN_ID, phase, rec.turn_index, rec.role, rec.provider), rec);
}

// -------------------------------------------------------------------------------------------
// §8 #10 -- a genuinely healthy, real 3-turn run: ok: true, all three ACs satisfied.
// -------------------------------------------------------------------------------------------

test("assessAcceptanceEvidence: a genuine, continued, fully-referenced 3-turn run reports ok with all three ACs satisfied", async () => {
  const { dir, initialSha, refs } = await freshRepoWithLooprArtifacts();
  try {
    const headAfter0 = await commitFile(dir, "foo.txt", "v1\n", "turn0: executor claude-code");
    const fooRef: FileRef = { path: "foo.txt", sha256: await sha256File(`${dir}/foo.txt`) };
    await writeTurn(
      dir,
      1,
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

    const headAfter1 = await commitFile(dir, "bar.txt", "v1\n", "turn1: executor codex-cli");
    const barRef: FileRef = { path: "bar.txt", sha256: await sha256File(`${dir}/bar.txt`) };
    await writeTurn(
      dir,
      1,
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

    const headAfter2 = await commitFile(dir, "BUILD_COMPLETE.md", "done\n", "turn2: reviewer claude-code");
    const completeRef: FileRef = { path: "BUILD_COMPLETE.md", sha256: await sha256File(`${dir}/BUILD_COMPLETE.md`) };
    await writeTurn(
      dir,
      1,
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

    const evidence = await assessAcceptanceEvidence(dir, RUN_ID, true);
    assert.equal(evidence.turnsFound, 3);
    assert.equal(evidence.ac1.satisfied, true);
    assert.deepStrictEqual(evidence.ac1.providerSequence, ["claude-code", "codex-cli", "claude-code"]);
    assert.equal(evidence.ac2.satisfied, true);
    assert.equal(evidence.ac3.satisfied, true);
    assert.ok(evidence.ac3.production !== null);
    assert.equal(evidence.ac3.production?.satisfied, true);
    assert.deepStrictEqual(evidence.problems, []);
  } finally {
    await cleanup(dir);
  }
});

// -------------------------------------------------------------------------------------------
// §8 #11 (amended) -- two executor turns on the SAME provider are a valid run (two seats, different models): AC1 is decided by the continuity checks.
// -------------------------------------------------------------------------------------------

test("assessAcceptanceEvidence: two executor turns reporting the same provider are not an AC1 failure by themselves -- the continuity checks decide (one provider with two models is a supported setup)", async () => {
  const { dir, initialSha, refs } = await freshRepoWithLooprArtifacts();
  try {
    const headAfter0 = await commitFile(dir, "foo.txt", "v1\n", "turn0");
    const fooRef: FileRef = { path: "foo.txt", sha256: await sha256File(`${dir}/foo.txt`) };
    await writeTurn(
      dir,
      1,
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
      1,
      record({
        turnIndex: 1,
        role: "executor",
        provider: "claude-code", // same provider as turn 0 (a different model in the second seat)
        headBefore: headAfter0,
        headAfter: headAfter1,
        commits: [headAfter1],
        specRef: refs.spec,
        artifactsRead: [refs.babyPrd, refs.context, refs.spec, fooRef],
        artifactsWritten: [barRef],
      }),
    );

    const headAfter2 = await commitFile(dir, "PHASE_2_SPEC.md", "phase 2\n", "turn2");
    const nextSpecRef: FileRef = { path: "PHASE_2_SPEC.md", sha256: await sha256File(`${dir}/PHASE_2_SPEC.md`) };
    await writeTurn(
      dir,
      1,
      record({
        turnIndex: 2,
        role: "reviewer",
        provider: "codex-cli",
        headBefore: headAfter1,
        headAfter: headAfter2,
        commits: [headAfter2],
        specRef: refs.spec,
        artifactsRead: [refs.babyPrd, refs.context, refs.spec, barRef],
        artifactsWritten: [nextSpecRef],
      }),
    );

    const evidence = await assessAcceptanceEvidence(dir, RUN_ID, false);
    assert.equal(evidence.turnsFound, 3);
    assert.equal(evidence.ac1.satisfied, true, evidence.ac1.detail);
    assert.doesNotMatch(evidence.ac1.detail, /same provider/);
    assert.equal(evidence.ac1.continuity.length, 2, "both hand-overs were verified");
    assert.equal(evidence.ac2.satisfied, true);
    assert.equal(evidence.ac3.satisfied, true);
  } finally {
    await cleanup(dir);
  }
});

// -------------------------------------------------------------------------------------------
// §8 #12 -- a genuine REDO between the two executor turns fails AC1 with verdict REDO surfaced.
// -------------------------------------------------------------------------------------------

test("assessAcceptanceEvidence: a genuine REDO between the two executor turns fails AC1 with verdict REDO in the continuity entry", async () => {
  const { dir, initialSha, refs } = await freshRepoWithLooprArtifacts();
  try {
    const headAfter0 = await commitFile(dir, "foo.txt", "v1\n", "turn0: creates foo.txt");
    const fooRef: FileRef = { path: "foo.txt", sha256: await sha256File(`${dir}/foo.txt`) };
    await writeTurn(
      dir,
      1,
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

    // turn1 reverts the only path turn0 touched (foo.txt) by deleting it -- the both-null "reverted"
    // case verifyContinuation's C3_NO_REVERT documents -- which is the literal, deterministic
    // definition of a REDO (all paths the prior turn changed were reverted).
    const headAfter1 = await removeAndCommit(dir, "foo.txt", "turn1: reverts foo.txt (a REDO)");
    await writeTurn(
      dir,
      1,
      record({
        turnIndex: 1,
        role: "executor",
        provider: "codex-cli",
        headBefore: headAfter0,
        headAfter: headAfter1,
        commits: [headAfter1],
        specRef: refs.spec,
        artifactsRead: [refs.babyPrd, refs.context, refs.spec],
        artifactsWritten: [],
      }),
    );

    const headAfter2 = await commitFile(dir, "PHASE_2_SPEC.md", "phase 2\n", "turn2");
    const nextSpecRef: FileRef = { path: "PHASE_2_SPEC.md", sha256: await sha256File(`${dir}/PHASE_2_SPEC.md`) };
    await writeTurn(
      dir,
      1,
      record({
        turnIndex: 2,
        role: "reviewer",
        provider: "claude-code",
        headBefore: headAfter1,
        headAfter: headAfter2,
        commits: [headAfter2],
        specRef: refs.spec,
        artifactsRead: [refs.babyPrd, refs.context, refs.spec],
        artifactsWritten: [nextSpecRef],
      }),
    );

    const evidence = await assessAcceptanceEvidence(dir, RUN_ID, false);
    assert.equal(evidence.ac1.satisfied, false);
    assert.equal(evidence.ac1.continuity.length, 2);
    assert.equal(evidence.ac1.continuity[0]?.verdict, "REDO");
    assert.ok(evidence.ac1.continuity[0]?.failedCheckIds.includes("C3_NO_REVERT"));
  } finally {
    await cleanup(dir);
  }
});

// -------------------------------------------------------------------------------------------
// §8 #13 -- the reviewer turn's own status "halted" fails AC2, with turnStatuses reporting it.
// -------------------------------------------------------------------------------------------

test("assessAcceptanceEvidence: the reviewer turn's own status \"halted\" fails AC2, with turnStatuses correctly reporting the halted turn", async () => {
  const { dir, initialSha, refs } = await freshRepoWithLooprArtifacts();
  try {
    const headAfter0 = await commitFile(dir, "foo.txt", "v1\n", "turn0");
    const fooRef: FileRef = { path: "foo.txt", sha256: await sha256File(`${dir}/foo.txt`) };
    await writeTurn(
      dir,
      1,
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
      1,
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

    // The reviewer halts: no commits of its own, status "halted".
    await writeTurn(
      dir,
      1,
      record({
        turnIndex: 2,
        role: "reviewer",
        provider: "claude-code",
        headBefore: headAfter1,
        headAfter: headAfter1,
        commits: [],
        specRef: refs.spec,
        artifactsRead: [refs.babyPrd, refs.context, refs.spec, barRef],
        artifactsWritten: [],
        status: "halted",
      }),
    );

    const evidence = await assessAcceptanceEvidence(dir, RUN_ID, false);
    assert.equal(evidence.turnsFound, 3);
    assert.equal(evidence.ac2.satisfied, false);
    assert.match(evidence.ac2.detail, /halted/);
    assert.deepStrictEqual(evidence.ac2.turnStatuses, [
      { turnIndex: 0, status: "completed" },
      { turnIndex: 1, status: "completed" },
      { turnIndex: 2, status: "halted" },
    ]);
  } finally {
    await cleanup(dir);
  }
});

// -------------------------------------------------------------------------------------------
// §8 #14 -- one turn's artifacts_read omits context.md fails AC3 for that turn specifically.
// -------------------------------------------------------------------------------------------

test("assessAcceptanceEvidence: a turn whose artifacts_read omits context.md fails AC3 for that turn specifically, naming it, while other turns remain independently correct", async () => {
  const { dir, initialSha, refs } = await freshRepoWithLooprArtifacts();
  try {
    const headAfter0 = await commitFile(dir, "foo.txt", "v1\n", "turn0");
    const fooRef: FileRef = { path: "foo.txt", sha256: await sha256File(`${dir}/foo.txt`) };
    await writeTurn(
      dir,
      1,
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
      1,
      record({
        turnIndex: 1,
        role: "executor",
        provider: "codex-cli",
        headBefore: headAfter0,
        headAfter: headAfter1,
        commits: [headAfter1],
        specRef: refs.spec,
        artifactsRead: [refs.babyPrd, refs.spec, fooRef], // context.md omitted
        artifactsWritten: [barRef],
      }),
    );

    const headAfter2 = await commitFile(dir, "PHASE_2_SPEC.md", "phase 2\n", "turn2");
    const nextSpecRef: FileRef = { path: "PHASE_2_SPEC.md", sha256: await sha256File(`${dir}/PHASE_2_SPEC.md`) };
    await writeTurn(
      dir,
      1,
      record({
        turnIndex: 2,
        role: "reviewer",
        provider: "claude-code",
        headBefore: headAfter1,
        headAfter: headAfter2,
        commits: [headAfter2],
        specRef: refs.spec,
        artifactsRead: [refs.babyPrd, refs.context, refs.spec, barRef],
        artifactsWritten: [nextSpecRef],
      }),
    );

    const evidence = await assessAcceptanceEvidence(dir, RUN_ID, false);
    assert.equal(evidence.ac3.satisfied, false);
    const [ref0, ref1, ref2] = evidence.ac3.references;
    assert.equal(ref0?.artifactsReferenced, true);
    assert.equal(ref1?.artifactsReferenced, false);
    assert.deepStrictEqual(ref1?.missingArtifactPaths, ["context.md"]);
    assert.equal(ref2?.artifactsReferenced, true);
  } finally {
    await cleanup(dir);
  }
});

// -------------------------------------------------------------------------------------------
// §8 #15 -- reviewer's commits never touch the computed BUILD_COMPLETE.md path: fails production.
// -------------------------------------------------------------------------------------------

test("assessAcceptanceEvidence: the reviewer declaring but never committing the final-phase artifact fails AC3's production specifically", async () => {
  const { dir, initialSha, refs } = await freshRepoWithLooprArtifacts();
  try {
    // A stale BUILD_COMPLETE.md already exists before the reviewer's own turn starts.
    await commitFile(dir, "BUILD_COMPLETE.md", "stale pre-existing content\n", "stale pre-existing build-complete");
    const staleHead = (await git(dir, ["rev-parse", "HEAD"])).trim();

    const headAfter0 = await commitFile(dir, "foo.txt", "v1\n", "turn0");
    const fooRef: FileRef = { path: "foo.txt", sha256: await sha256File(`${dir}/foo.txt`) };
    await writeTurn(
      dir,
      1,
      record({
        turnIndex: 0,
        role: "executor",
        provider: "claude-code",
        headBefore: staleHead,
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
      1,
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

    // Reviewer's own commit range only touches an unrelated file, never BUILD_COMPLETE.md.
    const headAfter2 = await commitFile(dir, "unrelated.txt", "noise\n", "turn2: never touches BUILD_COMPLETE.md");
    const staleCompleteSha256 = await sha256File(`${dir}/BUILD_COMPLETE.md`);
    await writeTurn(
      dir,
      1,
      record({
        turnIndex: 2,
        role: "reviewer",
        provider: "claude-code",
        headBefore: headAfter1,
        headAfter: headAfter2,
        commits: [headAfter2],
        specRef: refs.spec,
        artifactsRead: [refs.babyPrd, refs.context, refs.spec, barRef],
        artifactsWritten: [{ path: "BUILD_COMPLETE.md", sha256: staleCompleteSha256 }],
      }),
    );

    const evidence = await assessAcceptanceEvidence(dir, RUN_ID, true);
    assert.equal(evidence.ac3.satisfied, false);
    assert.ok(evidence.ac3.production !== null);
    assert.equal(evidence.ac3.production?.satisfied, false);
    assert.match(evidence.ac3.production?.detail ?? "", /declared.*never.*touch|not actually touch/i);
    // Reference-checking (a structurally distinct part of AC3) is unaffected by the production failure.
    assert.ok(evidence.ac3.references.every((r) => r.artifactsReferenced));
  } finally {
    await cleanup(dir);
  }
});

// -------------------------------------------------------------------------------------------
// §8 #16 -- zero persisted turns: turnsFound 0, ok false, every AC unsatisfied, never throws.
// -------------------------------------------------------------------------------------------

test("assessAcceptanceEvidence: a missing handoff/ directory returns turnsFound 0, every AC unsatisfied, and a problems entry naming the missing path -- never throws", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-acceptance-test-`);
  try {
    const evidence = await assessAcceptanceEvidence(dir, RUN_ID, false);
    assert.equal(evidence.turnsFound, 0);
    assert.equal(evidence.ac1.satisfied, false);
    assert.equal(evidence.ac2.satisfied, false);
    assert.equal(evidence.ac3.satisfied, false);
    assert.equal(evidence.problems.length, 1);
    assert.match(evidence.problems[0] ?? "", /handoff/);
  } finally {
    await cleanup(dir);
  }
});

// -------------------------------------------------------------------------------------------
// §8 #17 -- two phase subdirectories under one runId: ok false, problems names both.
// -------------------------------------------------------------------------------------------

test("assessAcceptanceEvidence: two phase subdirectories under one run id returns ok: false with a problems entry naming both phase numbers", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-acceptance-test-`);
  try {
    await mkdir(`${dir}/.osa/runs/${RUN_ID}/handoff/1`, { recursive: true });
    await mkdir(`${dir}/.osa/runs/${RUN_ID}/handoff/2`, { recursive: true });

    const evidence = await assessAcceptanceEvidence(dir, RUN_ID, false);
    assert.equal(evidence.turnsFound, 0);
    assert.equal(evidence.ac1.satisfied, false);
    assert.equal(evidence.ac2.satisfied, false);
    assert.equal(evidence.ac3.satisfied, false);
    assert.equal(evidence.problems.length, 1);
    assert.match(evidence.problems[0] ?? "", /1/);
    assert.match(evidence.problems[0] ?? "", /2/);
  } finally {
    await cleanup(dir);
  }
});

// -------------------------------------------------------------------------------------------
// §8 #18 -- finalPhase is genuinely load-bearing for the production check, not ignored.
// -------------------------------------------------------------------------------------------

test("assessAcceptanceEvidence: finalPhase: false passes production against a genuinely-produced PHASE_2_SPEC.md; finalPhase: true against the same fixture fails it", async () => {
  const { dir, initialSha, refs } = await freshRepoWithLooprArtifacts();
  try {
    const headAfter0 = await commitFile(dir, "foo.txt", "v1\n", "turn0");
    const fooRef: FileRef = { path: "foo.txt", sha256: await sha256File(`${dir}/foo.txt`) };
    await writeTurn(
      dir,
      1,
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
      1,
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

    const headAfter2 = await commitFile(dir, "PHASE_2_SPEC.md", "phase 2 content\n", "turn2: genuinely produces PHASE_2_SPEC.md");
    const nextSpecRef: FileRef = { path: "PHASE_2_SPEC.md", sha256: await sha256File(`${dir}/PHASE_2_SPEC.md`) };
    await writeTurn(
      dir,
      1,
      record({
        turnIndex: 2,
        role: "reviewer",
        provider: "claude-code",
        headBefore: headAfter1,
        headAfter: headAfter2,
        commits: [headAfter2],
        specRef: refs.spec,
        artifactsRead: [refs.babyPrd, refs.context, refs.spec, barRef],
        artifactsWritten: [nextSpecRef],
      }),
    );

    const notFinal = await assessAcceptanceEvidence(dir, RUN_ID, false);
    assert.equal(notFinal.ac3.production?.satisfied, true);

    const final = await assessAcceptanceEvidence(dir, RUN_ID, true);
    assert.equal(final.ac3.production?.satisfied, false);
  } finally {
    await cleanup(dir);
  }
});

// -------------------------------------------------------------------------------------------
// §8 #28 -- examples/toy-build/run-config.template.json parses as JSON and, with its two
// placeholders replaced by a valid UUID and an absolute path, validates against RunConfig. This is
// the one item in the "toy build fixture" acceptance-criteria section that can be checked without
// any live provider CLI -- it tests the template's own shape, not a live dispatch.
// -------------------------------------------------------------------------------------------

const RUN_CONFIG_TEMPLATE_PATH = fileURLToPath(
  new URL("../../examples/toy-build/run-config.template.json", import.meta.url),
);

test("examples/toy-build/run-config.template.json parses as JSON and, with its two placeholders filled in, validates against RunConfig", async () => {
  const raw = await readFile(RUN_CONFIG_TEMPLATE_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);
  assert.ok(typeof parsed === "object" && parsed !== null);

  const filled = {
    ...(parsed as Record<string, unknown>),
    run_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    repo_dir: process.platform === "win32" ? "C:\\tmp\\toy-build-target" : "/tmp/toy-build-target",
  };

  const config = RunConfig.parse(filled);
  assert.deepStrictEqual(config.executor_providers, ["claude-code", "codex-cli"]);
  assert.equal(config.reviewer_provider, null);
  assert.equal(config.phase, 1);
  assert.equal(config.spec_path, "loopr/PHASE_1_SPEC.md");
  assert.equal(config.baby_prd_path, "loopr/baby_prd.md");
  assert.equal(config.context_path, "loopr/context.md");
  assert.equal(config.is_final_phase, true);
  // PHASE_10_SPEC.md §8.5 AC-U4: this template is deliberately left unmodified by Phase 10, which
  // proves the two new fields' defaults parse against a real, pre-Phase-10 fixture.
  assert.equal(config.chat_log_gitignored, true);
  assert.equal(config.chat_log_id, undefined);
});
