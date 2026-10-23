// Implements PHASE_3_SPEC.md §1.1 -- record.test.ts
// Covers §8 acceptance criteria #15, #16, #17.
//
// Reconciliation against real temp git repos: a deliberately wrong agent-authored repo/hash is
// proven overwritten, not trusted. All fixtures are real git repositories, built via the
// sanctioned `runProcess` (this file never imports node:child_process directly).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LooprArtifactBypassError, RelaySchemaError } from "../domain/errors.ts";
import type { HandoffRecord } from "../domain/relay.ts";
import { runProcess } from "../util/exec.ts";
import { sha256File, sha256String } from "../util/hash.ts";
import { checkC5ArtifactAttestation } from "../verify/continuity.ts";
import { assertLooprArtifactsReferenced } from "./artifacts.ts";
import { acceptCommitOnlyBlock, captureGroundTruthBefore, reconcileHandoffRecord } from "./record.ts";

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

async function commitFiles(dir: string, files: Readonly<Record<string, string>>, message: string): Promise<string> {
  for (const [relPath, content] of Object.entries(files)) {
    await writeFile(`${dir}/${relPath}`, content, "utf8");
    await git(dir, ["add", relPath]);
  }
  await git(dir, ["commit", "--quiet", "-m", message]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/osa-record-test-`);
  await initRepo(dir);
  return dir;
}

function draftRecord(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
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
    repo: { branch: "wrong-branch", head_before: "1".repeat(40), head_after: "2".repeat(40), commits: ["2".repeat(40)] },
    spec_ref: { path: "WRONG_SPEC.md", sha256: "3".repeat(64) },
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

test("captureGroundTruthBefore returns the real HEAD and branch", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "hello\n", "initial");
    const ground = await captureGroundTruthBefore(dir);
    assert.equal(ground.headBefore, commit0);
    assert.equal(ground.branch, "main");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("reconcileHandoffRecord replaces a deliberately-wrong agent-authored repo field with independently-computed ground truth", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const commit1 = await commitFile(dir, "foo.txt", "v1\n", "the turn's own commit");

    const draft = draftRecord();
    const reconciled = await reconcileHandoffRecord(dir, draft, {
      headBefore: commit0,
      branch: "main",
      specRef: { path: "PHASE_1_SPEC.md", sha256: "9".repeat(64) },
    });

    assert.equal(reconciled.repo.branch, "main");
    assert.equal(reconciled.repo.head_before, commit0);
    assert.equal(reconciled.repo.head_after, commit1);
    assert.deepStrictEqual(reconciled.repo.commits, [commit1]);
    assert.notEqual(reconciled.repo.branch, draft.repo.branch);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("reconcileHandoffRecord replaces a deliberately-wrong agent-authored spec_ref with the dispatch loop's own computed FileRef", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    await commitFile(dir, "foo.txt", "v1\n", "the turn's own commit");

    const draft = draftRecord();
    const trueSpecRef = { path: "PHASE_1_SPEC.md", sha256: sha256String("real spec content") };
    const reconciled = await reconcileHandoffRecord(dir, draft, {
      headBefore: commit0,
      branch: "main",
      specRef: trueSpecRef,
    });

    assert.deepStrictEqual(reconciled.spec_ref, trueSpecRef);
    assert.notDeepStrictEqual(reconciled.spec_ref, draft.spec_ref);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("reconcileHandoffRecord recomputes every artifact FileRef's sha256 from the real file, rejecting a wrong self-reported hash", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const commit1 = await commitFile(dir, "written.txt", "real content\n", "the turn's own commit");
    const trueSha = await sha256File(`${dir}/written.txt`);
    assert.notEqual(trueSha, "f".repeat(64));

    const draft = draftRecord({
      artifacts_written: [{ path: "written.txt", sha256: "f".repeat(64) }],
      repo: { branch: "main", head_before: "1".repeat(40), head_after: commit1, commits: [commit1] },
    });
    const reconciled = await reconcileHandoffRecord(dir, draft, {
      headBefore: commit0,
      branch: "main",
      specRef: { path: "PHASE_1_SPEC.md", sha256: "9".repeat(64) },
    });

    assert.equal(reconciled.artifacts_written.length, 1);
    assert.equal(reconciled.artifacts_written[0]?.sha256, trueSha);
    assert.notEqual(reconciled.artifacts_written[0]?.sha256, "f".repeat(64));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("reconcileHandoffRecord drops (does not fail on) a declared artifact path that does not exist on disk", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");

    const draft = draftRecord({
      artifacts_written: [{ path: "does-not-exist.txt", sha256: "f".repeat(64) }],
      repo: { branch: "main", head_before: "1".repeat(40), head_after: commit0, commits: [] },
      status: "blocked",
      halt: null,
    });
    const reconciled = await reconcileHandoffRecord(dir, draft, {
      headBefore: commit0,
      branch: "main",
      specRef: { path: "PHASE_1_SPEC.md", sha256: "9".repeat(64) },
    });

    assert.deepStrictEqual(reconciled.artifacts_written, []);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ---------------------------------------------------------------------------------------------
// artifacts_read is reconciled against ground.headBefore, not end-of-turn disk.
//
// These reproduce the live-run defect exactly: turn A wrote `wordcount.mjs` and
// `wordcount.test.mjs`; turn B genuinely read both, appended a test case to `wordcount.test.mjs`,
// and committed. Under the old disk-based reconciliation, turn B's `artifacts_read` entry for the
// file it also modified carried the *post-edit* hash, so `checkC5ArtifactAttestation` reported a
// stale read -- indistinguishable from never having read it. See `record.ts`'s file header.
// ---------------------------------------------------------------------------------------------

const WORDCOUNT_V1 = "export function wordcount(s) {\n  return s.split(/\\s+/).filter(Boolean).length;\n}\n";
const WORDCOUNT_TEST_V1 = "import { wordcount } from './wordcount.mjs';\ntest('counts words', () => {});\n";
const WORDCOUNT_TEST_V2 = `${WORDCOUNT_TEST_V1}test('counts an empty string', () => {});\n`;

test("reconcileHandoffRecord reconciles artifacts_read against the turn-start commit, so a file this turn also modified keeps the hash it was read at", async () => {
  const dir = await freshRepo();
  try {
    // Turn A (the prior turn): writes both files and commits them as C1.
    const base = await commitFile(dir, "README.md", "# fixture\n", "base");
    const c1 = await commitFiles(
      dir,
      { "wordcount.mjs": WORDCOUNT_V1, "wordcount.test.mjs": WORDCOUNT_TEST_V1 },
      "feat: wordcount + its test",
    );
    const shaSourceAtC1 = await sha256File(`${dir}/wordcount.mjs`);
    const shaTestAtC1 = await sha256File(`${dir}/wordcount.test.mjs`);

    const prevRecord = draftRecord({
      turn_index: 0,
      repo: { branch: "main", head_before: base, head_after: c1, commits: [c1] },
      spec_ref: { path: "PHASE_1_SPEC.md", sha256: "9".repeat(64) },
      artifacts_written: [
        { path: "wordcount.mjs", sha256: shaSourceAtC1 },
        { path: "wordcount.test.mjs", sha256: shaTestAtC1 },
      ],
    });

    // Turn B: reads both, then legitimately appends a test case to one of them and commits.
    const c2 = await commitFiles(dir, { "wordcount.test.mjs": WORDCOUNT_TEST_V2 }, "test: add an empty-string case");
    const shaTestOnDiskAfterTurnB = await sha256File(`${dir}/wordcount.test.mjs`);
    assert.notEqual(shaTestOnDiskAfterTurnB, shaTestAtC1);

    const draftB = draftRecord({
      turn_index: 1,
      // The agent's own hashes are deliberately nonsense: reconciliation must discard them entirely.
      artifacts_read: [
        { path: "wordcount.mjs", sha256: "a".repeat(64) },
        { path: "wordcount.test.mjs", sha256: "b".repeat(64) },
      ],
      artifacts_written: [{ path: "wordcount.test.mjs", sha256: "c".repeat(64) }],
      repo: { branch: "wrong", head_before: "1".repeat(40), head_after: c2, commits: [c2] },
    });

    const reconciledB = await reconcileHandoffRecord(dir, draftB, {
      headBefore: c1,
      branch: "main",
      specRef: { path: "PHASE_1_SPEC.md", sha256: "9".repeat(64) },
    });

    // artifacts_read carries the C1-era content hashes -- what turn B actually read.
    const readSource = reconciledB.artifacts_read.find((r) => r.path === "wordcount.mjs");
    const readTest = reconciledB.artifacts_read.find((r) => r.path === "wordcount.test.mjs");
    assert.equal(readSource?.sha256, shaSourceAtC1);
    assert.equal(readTest?.sha256, shaTestAtC1);
    assert.notEqual(readTest?.sha256, shaTestOnDiskAfterTurnB);

    // artifacts_written is unchanged in behaviour: still the real, final content on disk.
    assert.deepStrictEqual(reconciledB.artifacts_written, [
      { path: "wordcount.test.mjs", sha256: shaTestOnDiskAfterTurnB },
    ]);

    // The property that failed live: C5 now passes for the modified file as well as the untouched one.
    const c5 = checkC5ArtifactAttestation(prevRecord, reconciledB);
    assert.equal(c5.passed, true, JSON.stringify(c5.evidence));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("FALSIFICATION: the pre-fix, end-of-turn-disk reconciliation of artifacts_read really does fail C5 for a legitimately modified artifact", async () => {
  const dir = await freshRepo();
  try {
    const base = await commitFile(dir, "README.md", "# fixture\n", "base");
    const c1 = await commitFiles(
      dir,
      { "wordcount.mjs": WORDCOUNT_V1, "wordcount.test.mjs": WORDCOUNT_TEST_V1 },
      "feat: wordcount + its test",
    );
    const shaSourceAtC1 = await sha256File(`${dir}/wordcount.mjs`);
    const shaTestAtC1 = await sha256File(`${dir}/wordcount.test.mjs`);

    const prevRecord = draftRecord({
      turn_index: 0,
      repo: { branch: "main", head_before: base, head_after: c1, commits: [c1] },
      artifacts_written: [
        { path: "wordcount.mjs", sha256: shaSourceAtC1 },
        { path: "wordcount.test.mjs", sha256: shaTestAtC1 },
      ],
    });

    const c2 = await commitFiles(dir, { "wordcount.test.mjs": WORDCOUNT_TEST_V2 }, "test: add an empty-string case");

    // Reconstructed exactly as the pre-fix code did it: every artifacts_read hash taken from the
    // working tree at the *end* of the turn. This is the record the old implementation produced.
    const preFixReconciledB = draftRecord({
      turn_index: 1,
      repo: { branch: "main", head_before: c1, head_after: c2, commits: [c2] },
      artifacts_read: [
        { path: "wordcount.mjs", sha256: await sha256File(`${dir}/wordcount.mjs`) },
        { path: "wordcount.test.mjs", sha256: await sha256File(`${dir}/wordcount.test.mjs`) },
      ],
      artifacts_written: [{ path: "wordcount.test.mjs", sha256: await sha256File(`${dir}/wordcount.test.mjs`) }],
    });

    const c5Old = checkC5ArtifactAttestation(prevRecord, preFixReconciledB);
    assert.equal(c5Old.passed, false);
    const staleReads = (c5Old.evidence as { staleReads: { path: string; expectedSha256: string; foundSha256: string }[] })
      .staleReads;
    // Exactly one stale read, and it is the file the turn legitimately modified -- never the
    // untouched one, which attests cleanly under both the old and the new behaviour.
    assert.equal(staleReads.length, 1);
    assert.equal(staleReads[0]?.path, "wordcount.test.mjs");
    assert.equal(staleReads[0]?.expectedSha256, shaTestAtC1);
    assert.notEqual(staleReads[0]?.foundSha256, shaTestAtC1);
    assert.deepStrictEqual((c5Old.evidence as { unreadPaths: string[] }).unreadPaths, []);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("reconcileHandoffRecord drops (does not fail on) an artifacts_read path that did not exist at the turn-start commit", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "existing.txt", "v0\n", "initial");
    // The turn creates a brand-new file and then over-reports it as something it *read*. A real
    // read can only ever be of something that already existed when the turn started.
    const commit1 = await commitFile(dir, "created-by-this-turn.txt", "new\n", "the turn's own commit");

    const draft = draftRecord({
      artifacts_read: [
        { path: "existing.txt", sha256: "a".repeat(64) },
        { path: "created-by-this-turn.txt", sha256: "b".repeat(64) },
      ],
      repo: { branch: "main", head_before: commit0, head_after: commit1, commits: [commit1] },
    });
    const reconciled = await reconcileHandoffRecord(dir, draft, {
      headBefore: commit0,
      branch: "main",
      specRef: { path: "PHASE_1_SPEC.md", sha256: "9".repeat(64) },
    });

    assert.deepStrictEqual(reconciled.artifacts_read, [
      { path: "existing.txt", sha256: sha256String("v0\n") },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("assertLooprArtifactsReferenced still passes on a reconciled record under commit-based artifacts_read (loopr's static artifacts are unmodified mid-run)", async () => {
  const dir = await freshRepo();
  try {
    const base = await commitFile(dir, "README.md", "# fixture\n", "base");
    const babyPrd = "# baby prd\nthe product.\n";
    const context = "# context\nthe conventions.\n";
    const spec = "# PHASE_1_SPEC\nthe phase.\n";
    const c1 = await commitFiles(
      dir,
      { "baby_prd.md": babyPrd, "context.md": context, "PHASE_1_SPEC.md": spec },
      "loopr artifacts",
    );
    assert.notEqual(base, c1);

    // The turn reads all three loopr artifacts, does real work elsewhere, and commits.
    const c2 = await commitFiles(dir, { "impl.mjs": "export const x = 1;\n" }, "feat: the turn's work");

    const draft = draftRecord({
      artifacts_read: [
        { path: "baby_prd.md", sha256: "a".repeat(64) },
        { path: "context.md", sha256: "b".repeat(64) },
        { path: "PHASE_1_SPEC.md", sha256: "c".repeat(64) },
      ],
      artifacts_written: [{ path: "impl.mjs", sha256: "d".repeat(64) }],
      repo: { branch: "main", head_before: c1, head_after: c2, commits: [c2] },
    });
    const reconciled = await reconcileHandoffRecord(dir, draft, {
      headBefore: c1,
      branch: "main",
      specRef: { path: "PHASE_1_SPEC.md", sha256: sha256String(spec) },
    });

    // All three survive reconciliation, and -- because these artifacts are never modified mid-run --
    // their headBefore-blob hashes are identical to their end-of-turn on-disk hashes, so nothing
    // about this check's inputs changed.
    assert.equal(reconciled.artifacts_read.length, 3);
    for (const [path, content] of [
      ["baby_prd.md", babyPrd],
      ["context.md", context],
      ["PHASE_1_SPEC.md", spec],
    ] as const) {
      const entry = reconciled.artifacts_read.find((r) => r.path === path);
      assert.equal(entry?.sha256, sha256String(content));
      assert.equal(entry?.sha256, await sha256File(`${dir}/${path}`));
    }

    assert.doesNotThrow(() => {
      assertLooprArtifactsReferenced(reconciled, {
        babyPrdPath: "baby_prd.md",
        contextPath: "context.md",
        specPath: "PHASE_1_SPEC.md",
      });
    });

    // And the guard still fires when an artifact genuinely was not referenced.
    assert.throws(
      () => {
        assertLooprArtifactsReferenced(reconciled, {
          babyPrdPath: "baby_prd.md",
          contextPath: "context.md",
          specPath: "PHASE_2_SPEC.md",
        });
      },
      (err: unknown) => err instanceof LooprArtifactBypassError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("reconcileHandoffRecord throws RelaySchemaError when ground truth contradicts the agent's own report (R3: completed with zero real commits)", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    // No further commits are made -- ground truth will show zero commits between headBefore and
    // HEAD, but the agent claims status: "completed", which R3 forbids once ground truth applies.
    const draft = draftRecord({ status: "completed" });

    await assert.rejects(
      () =>
        reconcileHandoffRecord(dir, draft, {
          headBefore: commit0,
          branch: "main",
          specRef: { path: "PHASE_1_SPEC.md", sha256: "9".repeat(64) },
        }),
      (err: unknown) => {
        assert.ok(err instanceof RelaySchemaError);
        assert.equal(err.exitCode, 4);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("C5 under core.autocrlf: a file the turn wrote with CRLF is attested in the form git STORES (and the next turn reads), so a correct hand-over is not refused as a stale read (found by the live e2e run: Codex wrote CRLF files, the reviewer read the stored LF blobs, C5 failed twice and the build stopped)", async () => {
  const dir = await freshRepo();
  try {
    await git(dir, ["config", "core.autocrlf", "true"]);
    const base = await commitFile(dir, "README.md", "# fixture\n", "base");
    const crlf = "line one\r\nline two\r\nline three\r\n";
    const c1 = await commitFiles(dir, { "wordstat.py": crlf, "notes.txt": "single line no newline" }, "feat: wordstat");
    const stored = (await git(dir, ["show", "HEAD:wordstat.py"])).replace(/\r\n/g, "\n");
    assert.equal(stored, "line one\nline two\nline three\n", "git stored the LF form");
    assert.notEqual(sha256String(stored), await sha256File(`${dir}/wordstat.py`), "premise: the file on disk hashes differently from the stored form");

    const draftA = draftRecord({ turn_index: 0, repo: { branch: "main", head_before: base, head_after: c1, commits: [c1] }, artifacts_written: [{ path: "wordstat.py", sha256: "a".repeat(64) }, { path: "notes.txt", sha256: "b".repeat(64) }] });
    const recA = await reconcileHandoffRecord(dir, draftA, { headBefore: base, branch: "main", specRef: { path: "PHASE_1_SPEC.md", sha256: "9".repeat(64) } });
    assert.equal(recA.artifacts_written.find((r) => r.path === "wordstat.py")?.sha256, sha256String(stored), "attested in the stored form");
    assert.equal(recA.artifacts_written.find((r) => r.path === "notes.txt")?.sha256, await sha256File(`${dir}/notes.txt`), "an LF-only file is unaffected");

    const c2 = await commitFiles(dir, { "REVIEW.md": "ok\n" }, "review");
    const draftB = draftRecord({ turn_index: 1, repo: { branch: "main", head_before: c1, head_after: c2, commits: [c2] }, artifacts_read: [{ path: "wordstat.py", sha256: "c".repeat(64) }, { path: "notes.txt", sha256: "d".repeat(64) }] });
    const recB = await reconcileHandoffRecord(dir, draftB, { headBefore: c1, branch: "main", specRef: { path: "PHASE_1_SPEC.md", sha256: "9".repeat(64) } });
    const c5 = checkC5ArtifactAttestation(recA, recB);
    assert.equal(c5.passed, true, JSON.stringify(c5.evidence));

    // Control: a real uncommitted edit (not just line endings) is still attested as what is on disk.
    await writeFile(`${dir}/wordstat.py`, "line one\r\nCHANGED\r\n", "utf8");
    const recC = await reconcileHandoffRecord(dir, draftA, { headBefore: base, branch: "main", specRef: { path: "PHASE_1_SPEC.md", sha256: "9".repeat(64) } });
    assert.equal(recC.artifacts_written.find((r) => r.path === "wordstat.py")?.sha256, await sha256File(`${dir}/wordstat.py`), "a genuine divergence keeps the disk hash");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a 'blocked' turn whose only problem is that it could not run git commit is accepted as completed once OSA has committed its work -- and nothing else is (found by two live builds with 17 passing tests that stopped with D1_RUN_ERRORED)", () => {
  const blocked = (over: Partial<HandoffRecord> = {}): HandoffRecord => draftRecord({ status: "blocked", halt: null, work_done: "Completed Part B; all 17 tests pass. Git staging and commit were attempted but git could not create .git/index.lock: permission denied.", next_steps: ["Commit the staged changes when git write access is available."], ...over });
  const ok = acceptCommitOnlyBlock(blocked(), true);
  assert.equal(ok.status, "completed");
  assert.match(ok.work_done, /OSA note: this turn could not run git commit/);
  assert.equal(acceptCommitOnlyBlock(blocked(), false).status, "blocked", "nothing was committed by OSA: still a block");
  assert.equal(acceptCommitOnlyBlock(blocked({ halt: { code: "X", message: "stop" } }), true).status, "blocked", "an explicit halt signal is never overridden");
  assert.equal(acceptCommitOnlyBlock(blocked({ work_done: "I could not finish Part B because the spec contradicts itself.", next_steps: ["Ask the author."] }), true).status, "blocked", "a block about something else still halts the run");
  assert.equal(acceptCommitOnlyBlock(draftRecord({ status: "completed" }), true).status, "completed");
});
