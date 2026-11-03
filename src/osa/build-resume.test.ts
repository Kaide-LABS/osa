// Carrying on a build that was interrupted part-way: which phase is the last finished one, where the build restarts, and what is done to the repository.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tempGitRepo } from "./fixtures.test.ts";
import { lastFinishedPhase, phaseBoundaryMessage, planBuildResume } from "./build-resume.ts";

const RUN = "abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd";
const SPEC1 = "runs/abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd/spec/PHASE_1_SPEC.md";
const SPEC = (n: number): string => `runs/${RUN}/spec/PHASE_${String(n)}_SPEC.md`;

const git = (repo: string, ...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

async function commit(repo: string, file: string, text: string, message: string): Promise<string> {
  await mkdir(`${repo}/${file.split("/").slice(0, -1).join("/") || "."}`, { recursive: true });
  await writeFile(`${repo}/${file}`, text, "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

async function writeEvents(repo: string, lines: ReadonlyArray<{ phase: number; ok: boolean }>): Promise<void> {
  await mkdir(`${repo}/.osa/runs/${RUN}`, { recursive: true });
  const text = lines.map((l) => JSON.stringify({ schema_version: 1, at: "2026-01-01T00:00:00.000Z", run_id: RUN, event: "step14_done", data: { phase: l.phase, ok: l.ok } }) + "\n").join("");
  await writeFile(`${repo}/.osa/runs/${RUN}/events.jsonl`, text, "utf8");
}

/** A repository holding the setup commit and `done` closed phases (each: its own work, the next phase's spec, then the closing commit). */
async function buildUpTo(done: number, totalPhases = 4): Promise<{ repo: string; boundary: string }> {
  const repo = await tempGitRepo();
  // as in the pipeline: the spec is committed first, then the setup commit that closes everything before phase 1
  await commit(repo, SPEC1, "# phase 1\n", "chore: spec for the run");
  let boundary = await commit(repo, ".osa-fixture/context.md", "context\n", phaseBoundaryMessage(RUN, 0));
  const events: Array<{ phase: number; ok: boolean }> = [];
  for (let p = 1; p <= done; p++) {
    await commit(repo, `src/phase${String(p)}.txt`, `work of phase ${String(p)}\n`, `phase ${String(p)} work`);
    if (p < totalPhases) await commit(repo, SPEC(p + 1), `# phase ${String(p + 1)}\n`, `phase ${String(p)} wrote the next spec`);
    boundary = await commit(repo, `.osa-fixture/phase-${String(p)}.md`, `closed ${String(p)}\n`, phaseBoundaryMessage(RUN, p));
    events.push({ phase: p, ok: true });
  }
  await writeEvents(repo, events);
  return { repo, boundary };
}

const input = (repo: string, totalPhases = 4) => ({ repoDir: repo, runId: RUN, specPath: SPEC1, totalPhases });

test("lastFinishedPhase counts phases whose closing pass said ok, from 1 and without a gap; a failed or missing phase stops the count", async () => {
  const repo = await tempGitRepo();
  assert.equal(await lastFinishedPhase(repo, RUN), 0, "no events at all");
  await writeEvents(repo, [{ phase: 1, ok: true }, { phase: 2, ok: true }, { phase: 3, ok: false }]);
  assert.equal(await lastFinishedPhase(repo, RUN), 2, "phase 3 failed");
  await writeEvents(repo, [{ phase: 2, ok: true }, { phase: 3, ok: true }]);
  assert.equal(await lastFinishedPhase(repo, RUN), 0, "phase 1 is missing, so nothing after it counts");
  await writeEvents(repo, [{ phase: 1, ok: true }, { phase: 1, ok: true }, { phase: 2, ok: true }]);
  assert.equal(await lastFinishedPhase(repo, RUN), 2, "a phase closed twice is still one phase");
});

test("an interruption after phase 2: the build restarts at phase 3, its spec path is worked out, and the half-done phase is folded back (kept, staged), not thrown away", async () => {
  const { repo, boundary } = await buildUpTo(2);
  await commit(repo, "src/phase3-part.txt", "half of phase 3\n", "phase 3 turn 1");
  await commit(repo, "src/phase3-more.txt", "more of phase 3\n", "phase 3 turn 2");
  await writeFile(`${repo}/src/phase3-loose.txt`, "uncommitted\n", "utf8");

  const plan = await planBuildResume(input(repo));
  assert.deepEqual(plan, { kind: "drive", lastFinishedPhase: 2, startingPhase: 3, startingSpecPath: SPEC(3), foldedCommits: 2 });
  assert.equal(git(repo, "rev-parse", "HEAD"), boundary, "the repository is back at the commit that closed phase 2");
  assert.equal(await readFile(`${repo}/src/phase3-part.txt`, "utf8"), "half of phase 3\n", "the interrupted phase's work is still in the tree");
  assert.equal(await readFile(`${repo}/src/phase3-loose.txt`, "utf8"), "uncommitted\n", "including what was never committed");
  assert.match(git(repo, "status", "--porcelain"), /phase3-part\.txt/, "and it is staged for the retry's commit to cover");
});

test("an interruption with nothing committed since the last closed phase changes nothing in git", async () => {
  const { repo, boundary } = await buildUpTo(1);
  const plan = await planBuildResume(input(repo));
  assert.deepEqual(plan, { kind: "drive", lastFinishedPhase: 1, startingPhase: 2, startingSpecPath: SPEC(2), foldedCommits: 0 });
  assert.equal(git(repo, "rev-parse", "HEAD"), boundary);
});

test("an interruption inside phase 1 restarts at phase 1 from the setup commit", async () => {
  const { repo } = await buildUpTo(0);
  await commit(repo, "src/phase1-part.txt", "half of phase 1\n", "phase 1 turn 1");
  const plan = await planBuildResume(input(repo));
  assert.deepEqual(plan, { kind: "drive", lastFinishedPhase: 0, startingPhase: 1, startingSpecPath: SPEC(1), foldedCommits: 1 });
  assert.equal(await readFile(`${repo}/src/phase1-part.txt`, "utf8"), "half of phase 1\n");
});

test("every phase finished and BUILD_COMPLETE.md present: only the final check and summary remain; finished but the marker missing is refused", async () => {
  const { repo } = await buildUpTo(4, 4);
  const missing = await planBuildResume(input(repo, 4));
  assert.equal(missing.kind, "refused");
  assert.match(missing.kind === "refused" ? missing.reason : "", /BUILD_COMPLETE\.md is missing/);
  await commit(repo, "BUILD_COMPLETE.md", "done\n", "build complete");
  assert.deepEqual(await planBuildResume(input(repo, 4)), { kind: "finished", lastFinishedPhase: 4 });
});

test("a refusal changes nothing: the closing commit is gone from history, or the next phase's spec is missing", async () => {
  const gone = await buildUpTo(2);
  await commit(gone.repo, "src/phase3-part.txt", "half\n", "phase 3 turn 1");
  git(gone.repo, "checkout", "-q", "--orphan", "other");
  git(gone.repo, "commit", "-q", "--allow-empty", "-m", "unrelated history");
  const headBefore = git(gone.repo, "rev-parse", "HEAD");
  const refusedGone = await planBuildResume(input(gone.repo));
  assert.equal(refusedGone.kind, "refused");
  assert.match(refusedGone.kind === "refused" ? refusedGone.reason : "", /no longer holds the commit that closed phase 2/);
  assert.equal(git(gone.repo, "rev-parse", "HEAD"), headBefore);

  const noSpec = await buildUpTo(2);
  git(noSpec.repo, "rm", "-q", SPEC(3));
  git(noSpec.repo, "commit", "-q", "-m", "someone removed the next spec");
  await commit(noSpec.repo, "src/phase3-part.txt", "half\n", "phase 3 turn 1");
  const headBeforeSpec = git(noSpec.repo, "rev-parse", "HEAD");
  const refusedSpec = await planBuildResume(input(noSpec.repo));
  assert.equal(refusedSpec.kind, "refused");
  assert.match(refusedSpec.kind === "refused" ? refusedSpec.reason : "", /spec for phase 3/);
  assert.equal(git(noSpec.repo, "rev-parse", "HEAD"), headBeforeSpec, "nothing was reset");
});
