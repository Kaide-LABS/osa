// Implements PHASE_1_SPEC.md §1.6 -- git.test.ts
//
// Direct coverage for the two primitives today's live-run bug chain turned on: `blobContentAt`, the
// commit-based content primitive `src/dispatch/record.ts` reconciles `artifacts_read` through, and
// `resetHard`, which `src/dispatch/run-loop.ts` uses to rewind the repository to the last
// known-good commit before dispatching a continuity retry. Every fixture is a real git repository
// in the test's temp dir, built via the sanctioned `runProcess` (this file never imports
// node:child_process directly -- only src/util/exec.ts may). The other primitives in `git.ts` are
// exercised by `continuity.test.ts` and `commits.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { InternalError } from "../domain/errors.ts";
import { runProcess } from "../util/exec.ts";
import { sha256File, sha256String } from "../util/hash.ts";
import { blobContentAt, blobOidAt, resetHard } from "./git.ts";

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
  // Pinned so the byte-for-byte assertions below do not depend on the host's global git config:
  // with `core.autocrlf=true` git would rewrite line endings between the working tree and the
  // object store, and a disk-vs-blob hash comparison would then be testing the host, not this code.
  await git(dir, ["config", "core.autocrlf", "false"]);
}

async function commitFile(dir: string, relPath: string, content: string, message: string): Promise<string> {
  await writeFile(`${dir}/${relPath}`, content, "utf8");
  await git(dir, ["add", relPath]);
  await git(dir, ["commit", "--quiet", "-m", message]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/osa-git-test-`);
  await initRepo(dir);
  return dir;
}

test("blobContentAt returns a path's content exactly as it existed at the given commit", async () => {
  const dir = await freshRepo();
  try {
    const v0 = "export const answer = 41;\n";
    const v1 = "export const answer = 42;\n// corrected\n";
    const commit0 = await commitFile(dir, "answer.mjs", v0, "v0");
    const commit1 = await commitFile(dir, "answer.mjs", v1, "v1");

    assert.equal(await blobContentAt(dir, commit0, "answer.mjs"), v0);
    assert.equal(await blobContentAt(dir, commit1, "answer.mjs"), v1);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("blobContentAt reads the historical version even after the working tree has moved on", async () => {
  const dir = await freshRepo();
  try {
    const v0 = "line one\nline two\n";
    const commit0 = await commitFile(dir, "notes.md", v0, "v0");

    // The exact live-run shape: the file is edited *after* the commit whose content we want.
    await writeFile(`${dir}/notes.md`, "line one\nline two\nline three (added later)\n", "utf8");

    assert.equal(await blobContentAt(dir, commit0, "notes.md"), v0);
    assert.notEqual(await sha256File(`${dir}/notes.md`), sha256String(v0));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("blobContentAt returns null for a path that did not exist at that commit", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "first.txt", "first\n", "first");
    const commit1 = await commitFile(dir, "second.txt", "second\n", "second");

    // Absent at commit0 (it is created by commit1), present at commit1 -- the `null` return is the
    // same absent signal `blobOidAt` uses, which is what `reconcileHandoffRecord` drops entries on.
    assert.equal(await blobOidAt(dir, commit0, "second.txt"), null);
    assert.equal(await blobContentAt(dir, commit0, "second.txt"), null);
    assert.equal(await blobContentAt(dir, commit1, "second.txt"), "second\n");

    // A path that never existed in the repository at all.
    assert.equal(await blobContentAt(dir, commit1, "never-existed.txt"), null);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("blobContentAt is byte-for-byte faithful: no added newline, no EOL rewriting, non-ASCII preserved", async () => {
  const dir = await freshRepo();
  try {
    // Deliberately awkward: no trailing newline, an embedded CRLF, a tab, and non-ASCII text --
    // exactly the content shapes a `git show`-based or newline-normalising implementation corrupts.
    const content = "no-trailing-newline\r\n\tindented — café 日本語";
    const commit0 = await commitFile(dir, "awkward.txt", content, "awkward");

    const fromCommit = await blobContentAt(dir, commit0, "awkward.txt");
    assert.equal(fromCommit, content);
    assert.notEqual(fromCommit, `${content}\n`);

    // The load-bearing property for reconciliation: hashing the commit-based content with
    // `sha256String` yields exactly the hash `sha256File` computes over the same bytes on disk.
    assert.equal(sha256String(fromCommit as string), await sha256File(`${dir}/awkward.txt`));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("blobContentAt returns an empty string (not null) for a file that is empty at that commit", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "empty.txt", "", "empty");
    // `""` and `null` mean different things here: present-but-empty must not be dropped as absent.
    assert.equal(await blobContentAt(dir, commit0, "empty.txt"), "");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("resetHard rewinds the branch ref, the index and the working tree, discarding later commits and staged/unstaged edits", async () => {
  const dir = await freshRepo();
  try {
    const good = await commitFile(dir, "kept.txt", "good\n", "good");
    await commitFile(dir, "kept.txt", "clobbered\n", "bad edit");
    await commitFile(dir, "added-by-bad.txt", "bad\n", "bad addition");
    // Plus residue of the other two kinds: an unstaged edit and a staged-but-uncommitted new file.
    await writeFile(`${dir}/kept.txt`, "dirty working tree\n", "utf8");
    await writeFile(`${dir}/staged.txt`, "staged\n", "utf8");
    await git(dir, ["add", "staged.txt"]);
    // And one genuinely untracked file, standing in for a run's own `.osa/` bookkeeping.
    await writeFile(`${dir}/untracked.txt`, "untracked\n", "utf8");

    await resetHard(dir, good);

    assert.equal((await git(dir, ["rev-parse", "HEAD"])).trim(), good);
    assert.equal(await readFile(`${dir}/kept.txt`, "utf8"), "good\n");
    // A file introduced only by a discarded commit is gone from the working tree, not merely
    // untracked -- `--hard` resets tracked content on both sides of the move.
    await assert.rejects(() => readFile(`${dir}/added-by-bad.txt`, "utf8"));
    // Index and working tree both match HEAD again: nothing staged, nothing modified.
    assert.equal((await git(dir, ["status", "--porcelain", "--untracked-files=no"])).trim(), "");
    // ...but `--hard` is not `git clean`: a file git never tracked survives untouched, which is
    // what keeps a run's `.osa/` bookkeeping (deliberately never committed) intact across a
    // retry rewind.
    assert.equal(await readFile(`${dir}/untracked.txt`, "utf8"), "untracked\n");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("resetHard throws InternalError for a rev that does not resolve, rather than silently leaving HEAD where it was", async () => {
  const dir = await freshRepo();
  try {
    const only = await commitFile(dir, "only.txt", "only\n", "only");
    await assert.rejects(
      () => resetHard(dir, "0".repeat(40)),
      (err: unknown) => {
        assert.ok(err instanceof InternalError);
        return true;
      },
    );
    assert.equal((await git(dir, ["rev-parse", "HEAD"])).trim(), only);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("blobContentAt throws InternalError when the path resolves to a non-blob (a directory/tree)", async () => {
  const dir = await freshRepo();
  try {
    await mkdir(`${dir}/sub`, { recursive: true });
    await writeFile(`${dir}/sub/inner.txt`, "inner\n", "utf8");
    await git(dir, ["add", "sub/inner.txt"]);
    await git(dir, ["commit", "--quiet", "-m", "add subdir"]);
    const commit0 = (await git(dir, ["rev-parse", "HEAD"])).trim();

    // `sub` resolves to a tree, so the absent signal must NOT be used -- this is an unexpected
    // condition, mirroring `sha256File`'s EISDIR raising rather than reporting "missing".
    assert.notEqual(await blobOidAt(dir, commit0, "sub"), null);
    await assert.rejects(
      () => blobContentAt(dir, commit0, "sub"),
      (err: unknown) => {
        assert.ok(err instanceof InternalError);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
