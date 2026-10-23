// Implements PHASE_1_SPEC.md §1.6 -- continuity.test.ts
// Covers §8 acceptance criteria #22 and #23. All five fixtures are real git repositories created
// in the test's temp dir, built via the sanctioned `runProcess` (this file never imports
// node:child_process directly -- only src/util/exec.ts may).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { ContinuityError } from "../domain/errors.ts";
import type { HandoffRecord } from "../domain/relay.ts";
import { runProcess } from "../util/exec.ts";
import { sha256File, sha256String } from "../util/hash.ts";
import { CONTINUITY_CHECKS, verifyContinuation } from "./continuity.ts";
import { changedPaths, commitsBetween, currentBranch, revParse, stageAllAndCommit, workingTreeChanges } from "./git.ts";

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

async function commitFiles(dir: string, files: Readonly<Record<string, string>>, message: string): Promise<string> {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = `${dir}/${relPath}`;
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    await git(dir, ["add", relPath]);
  }
  await git(dir, ["commit", "--quiet", "-m", message]);
  const head = await git(dir, ["rev-parse", "HEAD"]);
  return head.trim();
}

function baseRecord(): HandoffRecord {
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
    repo: { branch: "main", head_before: "0".repeat(40), head_after: "0".repeat(40), commits: [] },
    spec_ref: { path: "PHASE_1_SPEC.md", sha256: "1".repeat(64) },
    artifacts_read: [],
    artifacts_written: [],
    status: "completed",
    work_done: "did some work",
    next_steps: [],
    open_questions: [],
    halt: null,
  };
}

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/osa-continuity-test-`);
  await initRepo(dir);
  return dir;
}

test("all five CONTINUITY_CHECKS always appear, in order, on a passing run", async () => {
  const dir = await freshRepo();
  try {
    const fooA = "foo changed by A\n";
    const commit0 = await commitFiles(dir, { "foo.txt": "original foo\n" }, "initial");
    const commitA = await commitFiles(dir, { "foo.txt": fooA }, "A's turn");
    const commitB = await commitFiles(dir, { "bar.txt": "bar by B\n" }, "B's turn");

    const prev: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commit0, head_after: commitA, commits: [commitA] },
      artifacts_written: [{ path: "foo.txt", sha256: sha256String(fooA) }],
    };
    const next: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commitA, head_after: commitB, commits: [commitB] },
      artifacts_read: [{ path: "foo.txt", sha256: sha256String(fooA) }],
    };

    const verdict = await verifyContinuation(dir, prev, next);
    assert.equal(verdict.verdict, "CONTINUED");
    assert.deepStrictEqual(verdict.failedCheckIds, []);
    assert.deepStrictEqual(
      verdict.checks.map((c) => c.id),
      [...CONTINUITY_CHECKS],
    );
    assert.ok(verdict.checks.every((c) => c.passed));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("REDO: the next turn reverts every path the prior turn touched", async () => {
  const dir = await freshRepo();
  try {
    const original = "original foo\n";
    const fooA = "foo changed by A\n";
    const commit0 = await commitFiles(dir, { "foo.txt": original }, "initial");
    const commitA = await commitFiles(dir, { "foo.txt": fooA }, "A's turn");
    const commitB = await commitFiles(dir, { "foo.txt": original }, "B reverts A's change");

    const prev: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commit0, head_after: commitA, commits: [commitA] },
      artifacts_written: [{ path: "foo.txt", sha256: sha256String(fooA) }],
    };
    const next: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commitA, head_after: commitB, commits: [commitB] },
      artifacts_read: [{ path: "foo.txt", sha256: sha256String(fooA) }],
    };

    const verdict = await verifyContinuation(dir, prev, next);
    assert.equal(verdict.verdict, "REDO");
    assert.deepStrictEqual(verdict.failedCheckIds, ["C3_NO_REVERT"]);
    assert.equal(verdict.checks.length, 5);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("PARTIAL_REVERT: the next turn reverts some but not all of the prior turn's paths", async () => {
  const dir = await freshRepo();
  try {
    const originalFoo = "original foo\n";
    const fooA = "foo changed by A\n";
    const bazA = "baz created by A\n";
    const commit0 = await commitFiles(dir, { "foo.txt": originalFoo }, "initial");
    const commitA = await commitFiles(dir, { "foo.txt": fooA, "baz.txt": bazA }, "A's turn (two files)");
    // B reverts foo.txt but leaves baz.txt exactly as A left it.
    const commitB = await commitFiles(dir, { "foo.txt": originalFoo }, "B reverts only foo.txt");

    const prev: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commit0, head_after: commitA, commits: [commitA] },
      artifacts_written: [
        { path: "foo.txt", sha256: sha256String(fooA) },
        { path: "baz.txt", sha256: sha256String(bazA) },
      ],
    };
    const next: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commitA, head_after: commitB, commits: [commitB] },
      artifacts_read: [
        { path: "foo.txt", sha256: sha256String(fooA) },
        { path: "baz.txt", sha256: sha256String(bazA) },
      ],
    };

    const verdict = await verifyContinuation(dir, prev, next);
    assert.equal(verdict.verdict, "PARTIAL_REVERT");
    assert.deepStrictEqual(verdict.failedCheckIds, ["C3_NO_REVERT"]);
    const c3 = verdict.checks.find((c) => c.id === "C3_NO_REVERT");
    assert.deepStrictEqual(c3?.evidence["revertedPaths"], ["foo.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("IGNORED: the next turn never reads back an artifact the prior turn wrote (C5)", async () => {
  const dir = await freshRepo();
  try {
    const fooA = "foo changed by A\n";
    const commit0 = await commitFiles(dir, { "foo.txt": "original foo\n" }, "initial");
    const commitA = await commitFiles(dir, { "foo.txt": fooA }, "A's turn");
    const commitB = await commitFiles(dir, { "bar.txt": "bar by B\n" }, "B's turn, never reads foo.txt");

    const prev: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commit0, head_after: commitA, commits: [commitA] },
      artifacts_written: [{ path: "foo.txt", sha256: sha256String(fooA) }],
    };
    const next: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commitA, head_after: commitB, commits: [commitB] },
      artifacts_read: [],
    };

    const verdict = await verifyContinuation(dir, prev, next);
    assert.equal(verdict.verdict, "IGNORED");
    assert.deepStrictEqual(verdict.failedCheckIds, ["C5_ARTIFACT_ATTESTATION"]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("IGNORED: the next turn never advances HEAD (C2)", async () => {
  const dir = await freshRepo();
  try {
    const fooA = "foo changed by A\n";
    const commit0 = await commitFiles(dir, { "foo.txt": "original foo\n" }, "initial");
    const commitA = await commitFiles(dir, { "foo.txt": fooA }, "A's turn");

    const prev: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commit0, head_after: commitA, commits: [commitA] },
      artifacts_written: [{ path: "foo.txt", sha256: sha256String(fooA) }],
    };
    const next: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commitA, head_after: commitA, commits: [] },
      artifacts_read: [{ path: "foo.txt", sha256: sha256String(fooA) }],
      status: "blocked",
    };

    const verdict = await verifyContinuation(dir, prev, next);
    assert.equal(verdict.verdict, "IGNORED");
    assert.deepStrictEqual(verdict.failedCheckIds, ["C2_ADVANCEMENT"]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("DIVERGED: the next turn worked a different (or mutated) phase spec (C4), all else consistent", async () => {
  const dir = await freshRepo();
  try {
    const fooA = "foo changed by A\n";
    const commit0 = await commitFiles(dir, { "foo.txt": "original foo\n" }, "initial");
    const commitA = await commitFiles(dir, { "foo.txt": fooA }, "A's turn");
    const commitB = await commitFiles(dir, { "bar.txt": "bar by B\n" }, "B's turn");

    const prev: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commit0, head_after: commitA, commits: [commitA] },
      spec_ref: { path: "PHASE_1_SPEC.md", sha256: "1".repeat(64) },
      artifacts_written: [{ path: "foo.txt", sha256: sha256String(fooA) }],
    };
    const next: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commitA, head_after: commitB, commits: [commitB] },
      spec_ref: { path: "PHASE_1_SPEC.md", sha256: "2".repeat(64) },
      artifacts_read: [{ path: "foo.txt", sha256: sha256String(fooA) }],
    };

    const verdict = await verifyContinuation(dir, prev, next);
    assert.equal(verdict.verdict, "DIVERGED");
    assert.deepStrictEqual(verdict.failedCheckIds, ["C4_SPEC_CONTINUITY"]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a malformed/unknown git object OID throws ContinuityError with code GIT_BAD_OBJECT, not a false verdict", async () => {
  const dir = await freshRepo();
  try {
    // Only next.repo.head_after (C1's descendant argument) is bogus. C1 (isAncestor) and C3
    // (changedPaths/blobOidAt) run concurrently inside verifyContinuation; if the bogus OID were
    // instead placed in a field C3 also reads (e.g. prev.repo.head_after), C3's own git call would
    // independently fail too -- with a different, undocumented error type -- racing C1's documented
    // ContinuityError for which one wins the Promise.all rejection. Keeping prev's own
    // head_before/head_after both valid isolates the exception to C1 alone.
    const commit0 = await commitFiles(dir, { "foo.txt": "original foo\n" }, "initial");
    const commitA = await commitFiles(dir, { "foo.txt": "changed by A\n" }, "A's turn");
    const bogusOid = "f".repeat(40);

    const prev: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commit0, head_after: commitA, commits: [commitA] },
    };
    const next: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commitA, head_after: bogusOid, commits: [bogusOid] },
    };

    await assert.rejects(
      () => verifyContinuation(dir, prev, next),
      (err: unknown) => {
        assert.ok(err instanceof ContinuityError);
        assert.equal(err.details["code"], "GIT_BAD_OBJECT");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("C3 passes vacuously when the prior turn changed no paths", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFiles(dir, { "foo.txt": "original foo\n" }, "initial");
    // "Prior turn" that produced a commit identical in tree content to its parent is contrived,
    // but exercised here purely to drive the changedPaths()-returns-empty branch: use head_before
    // === head_after (no commits at all in the prior turn is a different, C2-covered case), so
    // instead simulate a genuine no-op amend-free "turn" by pointing head_before at the same
    // commit as head_after with an empty commits list is C2's job; here we cover the "prior turn
    // touched zero paths but still advanced" shape via an empty commit.
    await git(dir, ["commit", "--quiet", "--allow-empty", "-m", "A's no-op turn"]);
    const commitA = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const commitB = await commitFiles(dir, { "bar.txt": "bar by B\n" }, "B's turn");

    const prev: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commit0, head_after: commitA, commits: [commitA] },
    };
    const next: HandoffRecord = {
      ...baseRecord(),
      repo: { branch: "main", head_before: commitA, head_after: commitB, commits: [commitB] },
    };

    const verdict = await verifyContinuation(dir, prev, next);
    const c3 = verdict.checks.find((c) => c.id === "C3_NO_REVERT");
    assert.equal(c3?.passed, true);
    assert.equal(c3?.evidence["reason"], "vacuous");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// Additional coverage for the other [DET] git.ts plumbing wrappers and the hash.ts file-hashing
// primitive, which the continuity-verdict tests above exercise only indirectly (isAncestor,
// changedPaths, blobOidAt).

test("sha256File matches sha256String for the same bytes on disk", async () => {
  const dir = await freshRepo();
  try {
    const content = "the quick brown fox\n";
    const filePath = `${dir}/sample.txt`;
    await writeFile(filePath, content, "utf8");
    const fromFile = await sha256File(filePath);
    assert.equal(fromFile, sha256String(content));
    assert.match(fromFile, /^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("revParse resolves a ref to its full OID and throws on an unknown ref", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFiles(dir, { "foo.txt": "hello\n" }, "initial");
    const resolved = await revParse(dir, "HEAD");
    assert.equal(resolved, commit0);
    await assert.rejects(() => revParse(dir, "not-a-real-ref"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("currentBranch returns the branch name, and HEAD when detached", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFiles(dir, { "foo.txt": "hello\n" }, "initial");
    assert.equal(await currentBranch(dir), "main");
    await git(dir, ["checkout", "--quiet", "--detach", commit0]);
    assert.equal(await currentBranch(dir), "HEAD");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("commitsBetween returns an oldest-first list, and an empty array for an empty range", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFiles(dir, { "foo.txt": "v0\n" }, "commit 0");
    const commit1 = await commitFiles(dir, { "foo.txt": "v1\n" }, "commit 1");
    const commit2 = await commitFiles(dir, { "foo.txt": "v2\n" }, "commit 2");

    assert.deepStrictEqual(await commitsBetween(dir, commit0, commit2), [commit1, commit2]);
    assert.deepStrictEqual(await commitsBetween(dir, commit2, commit2), []);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// -------------------------------------------------------------------------------------------
// workingTreeChanges / stageAllAndCommit -- the working-tree primitives runTurn()'s step 5.5
// fallback commit is built on. Every case below uses a real, disposable git repo, and every probe
// under test is plumbing or an exit-code-only predicate (`git diff --quiet`, `git ls-files
// --others -z`), never `git status --porcelain` -- see git.ts's file header.
// -------------------------------------------------------------------------------------------

test("workingTreeChanges reports a genuinely clean tree as having nothing at all", async () => {
  const dir = await freshRepo();
  try {
    await commitFiles(dir, { "foo.txt": "v0\n" }, "initial");

    const changes = await workingTreeChanges(dir);
    assert.equal(changes.hasAny, false);
    assert.equal(changes.trackedModified, false);
    assert.equal(changes.staged, false);
    assert.deepStrictEqual(changes.untracked, []);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("workingTreeChanges detects each of the three change kinds independently: unstaged, staged, untracked", async () => {
  const dir = await freshRepo();
  try {
    await commitFiles(dir, { "foo.txt": "v0\n" }, "initial");

    // 1. An unstaged edit to a tracked file.
    await writeFile(`${dir}/foo.txt`, "v1\n", "utf8");
    let changes = await workingTreeChanges(dir);
    assert.deepStrictEqual(
      { trackedModified: changes.trackedModified, staged: changes.staged, untracked: changes.untracked },
      { trackedModified: true, staged: false, untracked: [] },
    );
    assert.equal(changes.hasAny, true);

    // 2. The same edit, now staged but not committed -- a different probe entirely (--cached).
    await git(dir, ["add", "foo.txt"]);
    changes = await workingTreeChanges(dir);
    assert.deepStrictEqual(
      { trackedModified: changes.trackedModified, staged: changes.staged, untracked: changes.untracked },
      { trackedModified: false, staged: true, untracked: [] },
    );

    // 3. A brand-new file git does not track yet -- invisible to both diff probes above, which is
    // exactly why the untracked probe is not optional: an agent's newly created file lands here.
    await mkdir(`${dir}/deep`, { recursive: true });
    await writeFile(`${dir}/deep/new.txt`, "brand new\n", "utf8");
    changes = await workingTreeChanges(dir);
    assert.deepStrictEqual(changes.untracked, ["deep/new.txt"]);
    assert.equal(changes.hasAny, true);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("workingTreeChanges sees an untracked file alone as a change, with both diff probes clean", async () => {
  const dir = await freshRepo();
  try {
    await commitFiles(dir, { "foo.txt": "v0\n" }, "initial");
    await writeFile(`${dir}/only-new.txt`, "new\n", "utf8");

    const changes = await workingTreeChanges(dir);
    assert.equal(changes.trackedModified, false);
    assert.equal(changes.staged, false);
    assert.deepStrictEqual(changes.untracked, ["only-new.txt"]);
    assert.equal(changes.hasAny, true);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("workingTreeChanges honours .gitignore via --exclude-standard, and excludeDirs via an exclude pathspec", async () => {
  const dir = await freshRepo();
  try {
    await commitFiles(dir, { ".gitignore": "ignored-build/\n" }, "initial");
    await mkdir(`${dir}/ignored-build`, { recursive: true });
    await writeFile(`${dir}/ignored-build/out.bin`, "junk\n", "utf8");
    await mkdir(`${dir}/.osa/runs/r/handoff/1`, { recursive: true });
    await writeFile(`${dir}/.osa/runs/r/handoff/1/000-executor-codex-cli.json`, "{}\n", "utf8");

    // .gitignore'd output never counts, and .osa/ is excluded by pathspec -- so a repo
    // whose only "changes" are OSA's own bookkeeping still reads as clean.
    assert.equal((await workingTreeChanges(dir, [".osa"])).hasAny, false);
    // Without the exclusion, the same tree does show OSA's own draft record.
    assert.deepStrictEqual((await workingTreeChanges(dir)).untracked, [
      ".osa/runs/r/handoff/1/000-executor-codex-cli.json",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("stageAllAndCommit commits modifications, additions and deletions in one commit, leaving the tree clean", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFiles(dir, { "foo.txt": "v0\n", "gone.txt": "delete me\n" }, "initial");
    await writeFile(`${dir}/foo.txt`, "v1\n", "utf8");
    await rm(`${dir}/gone.txt`);
    await mkdir(`${dir}/deep/nest`, { recursive: true });
    await writeFile(`${dir}/deep/nest/added.txt`, "added\n", "utf8");
    await writeFile(`${dir}/with space.txt`, "spaces in the name\n", "utf8");

    const oid = await stageAllAndCommit(dir, "chore: capture leftovers");

    assert.match(oid, /^[0-9a-f]{40}$/);
    assert.equal(oid, await revParse(dir, "HEAD"));
    assert.deepStrictEqual(await commitsBetween(dir, commit0, oid), [oid]);
    assert.deepStrictEqual([...(await changedPaths(dir, commit0, oid))].sort(), [
      "deep/nest/added.txt",
      "foo.txt",
      "gone.txt",
      "with space.txt",
    ]);
    assert.equal((await workingTreeChanges(dir)).hasAny, false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("stageAllAndCommit leaves excludeDirs entirely untouched -- neither staged nor committed", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFiles(dir, { "foo.txt": "v0\n" }, "initial");
    await writeFile(`${dir}/work.txt`, "real work\n", "utf8");
    await mkdir(`${dir}/.osa/runs/r`, { recursive: true });
    await writeFile(`${dir}/.osa/runs/r/rec.json`, "{}\n", "utf8");

    const oid = await stageAllAndCommit(dir, "chore: capture leftovers", [".osa"]);

    assert.deepStrictEqual(await changedPaths(dir, commit0, oid), ["work.txt"]);
    // The excluded directory is still untracked afterwards -- it was never added to the index.
    assert.deepStrictEqual((await workingTreeChanges(dir)).untracked, [".osa/runs/r/rec.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("stageAllAndCommit succeeds when the excluded directory is ALSO listed in the repo's own .gitignore", async () => {
  // Regression, found in a real end-to-end run: staging via
  // `git add -A -- ':(top)' ':(exclude,top).osa'` exits 1 when `.osa/` is gitignored
  // too, because naming a path in any pathspec -- even a negative one -- trips git add's
  // "the following paths are ignored by one of your .gitignore files" check. Staging was correct
  // regardless, but the non-zero exit made stageAllAndCommit throw and killed the run. Excluding
  // the target repo's `.osa/` in .gitignore is the sensible thing for an operator to do,
  // so this configuration must be the well-trodden path, not the broken one.
  const dir = await freshRepo();
  try {
    const commit0 = await commitFiles(dir, { ".gitignore": ".osa/\n", "foo.txt": "v0\n" }, "initial");
    await writeFile(`${dir}/work.txt`, "real work\n", "utf8");
    await mkdir(`${dir}/.osa/runs/r`, { recursive: true });
    await writeFile(`${dir}/.osa/runs/r/rec.json`, "{}\n", "utf8");

    const oid = await stageAllAndCommit(dir, "chore: capture leftovers", [".osa"]);

    assert.deepStrictEqual(await changedPaths(dir, commit0, oid), ["work.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("stageAllAndCommit stages no deletion for an excluded directory that is genuinely tracked in HEAD", async () => {
  // The other half of the `git reset` undo pass: when the excluded directory already exists in
  // HEAD, `git add -A` stages its working-tree state and the reset must restore it to HEAD -- not
  // drop it from the index, which would commit a spurious deletion of tracked files.
  const dir = await freshRepo();
  try {
    const commit0 = await commitFiles(
      dir,
      { "foo.txt": "v0\n", ".osa/tracked.txt": "tracked before the turn\n" },
      "initial",
    );
    await writeFile(`${dir}/work.txt`, "real work\n", "utf8");
    await writeFile(`${dir}/.osa/tracked.txt`, "modified during the turn\n", "utf8");

    const oid = await stageAllAndCommit(dir, "chore: capture leftovers", [".osa"]);

    assert.deepStrictEqual(await changedPaths(dir, commit0, oid), ["work.txt"]);
    // Still tracked, and its in-tree modification is still uncommitted -- untouched either way.
    assert.equal((await workingTreeChanges(dir)).trackedModified, true);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("stageAllAndCommit throws rather than creating an empty commit when there is nothing to commit", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFiles(dir, { "foo.txt": "v0\n" }, "initial");

    await assert.rejects(() => stageAllAndCommit(dir, "chore: nothing to do"));
    // HEAD is unmoved: no empty commit was slipped in before the failure.
    assert.equal(await revParse(dir, "HEAD"), commit0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
