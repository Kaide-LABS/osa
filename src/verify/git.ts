// Implements PHASE_1_SPEC.md §6.5 -- [DET]
//
// Thin, typed wrappers over the exact git plumbing commands the deterministic verifiers need. No
// function in this module parses porcelain output; all use plumbing or explicitly stable formats
// (`-z`, `--format=%B`), because porcelain output is documented by git as subject to change.

import { ContinuityError, InternalError } from "../domain/errors.ts";
import { runProcess } from "../util/exec.ts";

const GIT_TIMEOUT_MS = 30_000;

async function git(repoDir: string, args: readonly string[]) {
  return runProcess({ command: "git", args, cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
}

/** `git --version`'s raw stdout, trimmed, or `null` if git is not found or fails to run. */
export async function gitVersion(repoDir: string): Promise<string | null> {
  const result = await git(repoDir, ["--version"]);
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.trim();
}

/** Resolves `rev` (e.g. `HEAD`, a short SHA, a ref name) to its full object id. Throws on failure. */
export async function revParse(repoDir: string, rev: string): Promise<string> {
  const result = await git(repoDir, ["rev-parse", rev]);
  if (result.exitCode !== 0) {
    throw new InternalError(`git rev-parse ${rev} failed in ${repoDir}: ${result.stderr.trim()}`, {
      repoDir,
      rev,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  return result.stdout.trim();
}

/** `git rev-parse --abbrev-ref HEAD`. Returns the literal string `HEAD` in a detached-HEAD state. */
export async function currentBranch(repoDir: string): Promise<string> {
  const result = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new InternalError(`git rev-parse --abbrev-ref HEAD failed in ${repoDir}: ${result.stderr.trim()}`, {
      repoDir,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  return result.stdout.trim();
}

/**
 * `git merge-base --is-ancestor <ancestor> <descendant>`. Exit `0` -> `true`; exit `1` -> `false`;
 * exit `128` (a malformed/unknown object) -> throws {@link ContinuityError} with
 * `code: "GIT_BAD_OBJECT"` -- a bad object must never be silently read as "not an ancestor".
 */
export async function isAncestor(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await git(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.exitCode === 0) {
    return true;
  }
  if (result.exitCode === 1) {
    return false;
  }
  throw new ContinuityError(
    `git merge-base --is-ancestor ${ancestor} ${descendant} returned exit ${String(result.exitCode)} ` +
      `(bad object) in ${repoDir}: ${result.stderr.trim()}`,
    { code: "GIT_BAD_OBJECT", repoDir, ancestor, descendant, exitCode: result.exitCode, stderr: result.stderr },
  );
}

/**
 * `git diff --name-only -z <fromOid>..<toOid>`. `-z` is mandatory: paths with spaces or
 * non-ASCII characters break the newline-separated form. Splits on `\0` and drops the trailing
 * empty element.
 */
export async function changedPaths(repoDir: string, fromOid: string, toOid: string): Promise<readonly string[]> {
  const result = await git(repoDir, ["diff", "--name-only", "-z", `${fromOid}..${toOid}`]);
  if (result.exitCode !== 0) {
    throw new InternalError(
      `git diff --name-only -z ${fromOid}..${toOid} failed in ${repoDir}: ${result.stderr.trim()}`,
      { repoDir, fromOid, toOid, exitCode: result.exitCode, stderr: result.stderr },
    );
  }
  const parts = result.stdout.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/**
 * `git rev-parse <oid>:<repoRelPath>`. Exit `0` -> the blob OID (trimmed); non-zero -> `null`
 * (the path did not exist at that commit).
 */
export async function blobOidAt(repoDir: string, oid: string, repoRelPath: string): Promise<string | null> {
  const result = await git(repoDir, ["rev-parse", `${oid}:${repoRelPath}`]);
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.trim();
}

/**
 * The content of `repoRelPath` **as it existed at commit `oid`**, or `null` if that path did not
 * exist at that commit -- deliberately mirroring {@link blobOidAt}'s `null`-on-absent convention,
 * because callers use "absent at that commit" as a real signal rather than an error (see
 * `src/dispatch/record.ts`, which drops rather than fails on such an entry).
 *
 * Built as two plumbing calls, not one: {@link blobOidAt} (`git rev-parse <oid>:<path>`) resolves
 * the blob first, which is what supplies the clean absent signal, and `git cat-file blob <blobOid>`
 * then emits that blob's stored bytes verbatim. `git show <oid>:<path>` would have collapsed both
 * steps into one command, but at the cost of the distinct absent signal and of `show`'s
 * user-facing-output remit; `cat-file blob` is the plumbing form whose entire contract is "write
 * this object's raw content, unmodified" -- it applies no smudge/EOL filter and adds no trailing
 * newline of its own, so the bytes hash identically to the file `git checkout` of that commit would
 * produce under a `core.autocrlf`-neutral configuration.
 *
 * Returned as a string rather than a `Buffer` because `src/util/exec.ts` -- the only module allowed
 * to spawn -- decodes child stdout as UTF-8. That is exact for the text artifacts OSA
 * reconciles (source files, Markdown specs, JSON), and is a deliberate, documented narrowing for a
 * genuinely binary blob, whose invalid UTF-8 sequences would decode lossily. Requesting a
 * non-blob object (e.g. a directory path, which resolves to a *tree*) throws {@link InternalError}
 * rather than returning `null`, matching how the on-disk equivalent (`sha256File` on a directory)
 * also raises rather than reporting "missing".
 */
export async function blobContentAt(repoDir: string, oid: string, repoRelPath: string): Promise<string | null> {
  const blobOid = await blobOidAt(repoDir, oid, repoRelPath);
  if (blobOid === null) {
    return null;
  }
  const result = await git(repoDir, ["cat-file", "blob", blobOid]);
  if (result.exitCode !== 0) {
    throw new InternalError(
      `git cat-file blob ${blobOid} (for "${repoRelPath}" at ${oid}) failed in ${repoDir}: ${result.stderr.trim()}`,
      { repoDir, oid, repoRelPath, blobOid, exitCode: result.exitCode, stderr: result.stderr },
    );
  }
  return result.stdout;
}

/**
 * `git rev-list --reverse <fromOid>..<toOid>`. Oldest-first list of commit ids; empty output
 * yields an empty array.
 */
export async function commitsBetween(repoDir: string, fromOid: string, toOid: string): Promise<readonly string[]> {
  const result = await git(repoDir, ["rev-list", "--reverse", `${fromOid}..${toOid}`]);
  if (result.exitCode !== 0) {
    throw new InternalError(
      `git rev-list --reverse ${fromOid}..${toOid} failed in ${repoDir}: ${result.stderr.trim()}`,
      { repoDir, fromOid, toOid, exitCode: result.exitCode, stderr: result.stderr },
    );
  }
  const trimmed = result.stdout.trim();
  return trimmed === "" ? [] : trimmed.split("\n");
}

/**
 * `git diff <fromOid>..<toOid>` -- the full unified diff body (no `--name-only`), unlike
 * {@link changedPaths}, which intentionally returns only names. Exit non-zero -> {@link InternalError},
 * matching this file's existing wrapper convention exactly. Implements PHASE_3_SPEC.md §1.6.
 */
export async function diffText(repoDir: string, fromOid: string, toOid: string): Promise<string> {
  const result = await git(repoDir, ["diff", `${fromOid}..${toOid}`]);
  if (result.exitCode !== 0) {
    throw new InternalError(`git diff ${fromOid}..${toOid} failed in ${repoDir}: ${result.stderr.trim()}`, {
      repoDir,
      fromOid,
      toOid,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  return result.stdout;
}

/**
 * Builds the pathspec list every working-tree primitive below passes after `--`: one positive
 * `:(top)` (the whole repository, resolved from its root rather than from the process cwd) followed
 * by one `:(exclude,top)` entry per caller-supplied path.
 *
 * `:(top)` is mandatory as the positive element. An `:(exclude)` pathspec only ever *subtracts*
 * from the set some positive pathspec already selected, so an exclude-only list matches nothing at
 * all. [Verified empirically on git 2.x/Windows: with `:/` used as the positive element and
 * `:(exclude):/.osa` as the exclusion, `git ls-files --others` still listed
 * `.osa/runs/x/rec.json` -- `:/` is only valid as *shorthand* magic for a whole pathspec,
 * not as a prefix inside another pathspec's `:(...)` magic, so that form silently excludes nothing.
 * `:(top)` on both sides excludes correctly.]
 */
function treePathspecs(excludeDirs: readonly string[]): readonly string[] {
  return [":(top)", ...excludeDirs.map((d) => `:(exclude,top)${d}`)];
}

/**
 * `git diff --quiet [--cached] -- <pathspecs>`. Exit `0` -> `false` (no difference); exit `1` ->
 * `true` (a difference exists); anything else -> {@link InternalError}. `--quiet` is a *plumbing-safe*
 * predicate: it produces no output to parse at all and communicates purely through its exit code,
 * which is exactly why this module uses it rather than `git status --porcelain` (see the file
 * header -- porcelain output is documented by git as subject to change; a `--quiet` exit code is not).
 */
async function diffHasChanges(repoDir: string, cached: boolean, excludeDirs: readonly string[]): Promise<boolean> {
  const args = cached
    ? ["diff", "--cached", "--quiet", "--", ...treePathspecs(excludeDirs)]
    : ["diff", "--quiet", "--", ...treePathspecs(excludeDirs)];
  const result = await git(repoDir, args);
  if (result.exitCode === 0) {
    return false;
  }
  if (result.exitCode === 1) {
    return true;
  }
  throw new InternalError(`git ${args.join(" ")} returned exit ${String(result.exitCode)} in ${repoDir}: ${result.stderr.trim()}`, {
    repoDir,
    args,
    exitCode: result.exitCode,
    stderr: result.stderr,
  });
}

/** What {@link workingTreeChanges} found, broken out by the three independent kinds of change. */
export interface WorkingTreeChanges {
  /** A tracked file differs between the working tree and the index (`git diff --quiet`). */
  readonly trackedModified: boolean;
  /** The index differs from `HEAD` -- work the agent staged but never committed (`git diff --cached --quiet`). */
  readonly staged: boolean;
  /** Repo-relative POSIX paths of new, non-ignored files git does not track yet. */
  readonly untracked: readonly string[];
  /** `true` iff any of the three above is non-empty -- the single predicate callers act on. */
  readonly hasAny: boolean;
}

/**
 * [DET] Whether `repoDir`'s working tree carries anything not yet in `HEAD`, checked across all
 * three independent kinds of change -- unstaged edits to tracked files, a staged-but-uncommitted
 * index, and brand-new untracked files. All three are required: an agent's newly created file is
 * untracked until something runs `git add`, so a tracked-only check would report a genuinely
 * productive turn as having changed nothing.
 *
 * Every probe is plumbing or an exit-code-only predicate, never `git status --porcelain`:
 * `git diff --quiet` and `git diff --cached --quiet` communicate solely through exit status (`0` =
 * no difference, `1` = difference), and `git ls-files --others --exclude-standard -z` is plumbing
 * whose `-z` NUL-separated output is an explicitly stable format. `--exclude-standard` is what makes
 * the untracked probe honour `.gitignore`/`.git/info/exclude`, so a repo's own ignored build output
 * never counts as "the agent left work behind".
 *
 * `excludeDirs` holds repo-root-relative directories to leave out of all three probes.
 */
export async function workingTreeChanges(
  repoDir: string,
  excludeDirs: readonly string[] = [],
): Promise<WorkingTreeChanges> {
  const [trackedModified, staged] = await Promise.all([
    diffHasChanges(repoDir, false, excludeDirs),
    diffHasChanges(repoDir, true, excludeDirs),
  ]);

  const listed = await git(repoDir, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...treePathspecs(excludeDirs)]);
  if (listed.exitCode !== 0) {
    throw new InternalError(`git ls-files --others --exclude-standard -z failed in ${repoDir}: ${listed.stderr.trim()}`, {
      repoDir,
      exitCode: listed.exitCode,
      stderr: listed.stderr,
    });
  }
  const parts = listed.stdout.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }

  return {
    trackedModified,
    staged,
    untracked: parts,
    hasAny: trackedModified || staged || parts.length > 0,
  };
}

/**
 * [DET] `git add -A` (optionally undoing `excludeDirs` again with `git reset`) followed by
 * `git commit -m <message>`, returning the new commit's full object id. `-A` is what makes this
 * total over all three change kinds {@link workingTreeChanges} detects -- modifications, additions
 * *and* deletions -- so the resulting commit is exactly "the working tree as the turn left it".
 *
 * The exclusion is applied as a second `git reset -- <dir>` pass rather than as an `:(exclude)`
 * pathspec on the `git add` itself, and that is a bug fix, not a stylistic choice.
 * `git add -A -- ':(top)' ':(exclude,top).osa'` **exits 1** whenever the excluded directory
 * also happens to be listed in the repo's own `.gitignore`: naming a path in *any* pathspec, even a
 * negative one, trips `git add`'s "the following paths are ignored by one of your .gitignore files"
 * check. [Observed directly against a real repo: staging was still entirely correct in every case
 * -- the excluded directory was never added -- but the non-zero exit made this wrapper throw, which
 * killed a real end-to-end run whose target repo sensibly gitignored `.osa/`. Neither
 * `-c advice.addIgnoredFile=false` nor `--ignore-errors` changes the exit code; both only suppress
 * the text.]
 *
 * `git reset -q -- <dir>` has exactly the right semantics for undoing the over-broad `add` in both
 * possible states, and was verified against both: when the directory is absent from `HEAD` its
 * entries are dropped from the index entirely (back to untracked), and when it *is* tracked in
 * `HEAD` its entries are restored to their `HEAD` state (so no spurious deletion is staged). It is
 * skipped altogether when `excludeDirs` is empty, since a bare `git reset --` with no pathspec
 * would reset the whole index.
 *
 * `message` is passed as a single `-m` argv element, never through a shell and never through a
 * file: `runProcess` spawns with `shell: false`, so no character in the message is interpretable.
 * Callers are responsible for the message's *content* being neutral (PRD §7 I4); this wrapper
 * neither composes nor inspects it.
 *
 * Throws {@link InternalError} if any step fails -- including the "nothing to commit" case, which
 * `git commit` reports as exit `1`. Callers must therefore establish that there is something to
 * commit (via {@link workingTreeChanges}) before calling this.
 */
export async function stageAllAndCommit(
  repoDir: string,
  message: string,
  excludeDirs: readonly string[] = [],
): Promise<string> {
  const added = await git(repoDir, ["add", "-A", "--", ":(top)"]);
  if (added.exitCode !== 0) {
    throw new InternalError(`git add -A failed in ${repoDir}: ${added.stderr.trim()}`, {
      repoDir,
      exitCode: added.exitCode,
      stderr: added.stderr,
    });
  }

  if (excludeDirs.length > 0) {
    const reset = await git(repoDir, ["reset", "--quiet", "--", ...excludeDirs.map((d) => `:(top)${d}`)]);
    if (reset.exitCode !== 0) {
      throw new InternalError(`git reset of excluded paths failed in ${repoDir}: ${reset.stderr.trim()}`, {
        repoDir,
        excludeDirs,
        exitCode: reset.exitCode,
        stderr: reset.stderr,
      });
    }
  }

  const committed = await git(repoDir, ["commit", "--quiet", "-m", message]);
  if (committed.exitCode !== 0) {
    throw new InternalError(`git commit failed in ${repoDir}: ${committed.stderr.trim() || committed.stdout.trim()}`, {
      repoDir,
      exitCode: committed.exitCode,
      stderr: committed.stderr,
      stdout: committed.stdout,
    });
  }

  return revParse(repoDir, "HEAD");
}

/**
 * [DET] `git reset --hard <rev>` -- moves the current branch ref to `rev` and forces **both** the
 * index and the working tree to match it, the standard destructive form. Any commit on this branch
 * beyond `rev`, and any uncommitted edit to a tracked file, is discarded outright.
 *
 * The single caller is `runTurnLoop`'s continuity-retry path (`src/dispatch/run-loop.ts`), which
 * rewinds the repository to the last known-good turn's `head_after` before dispatching a retry --
 * see that call site for the full rationale. Destroying work is the *point* there, not a tolerated
 * side effect: a non-`CONTINUED` verdict is a deterministic judgement that the attempt's work is
 * invalid.
 *
 * Untracked files are deliberately left alone (`--hard` resets tracked content only; it is not
 * `git clean`). That is the behaviour this module wants: OSA's own `.osa/` run
 * bookkeeping -- including the failed attempt's draft `HandoffRecord`, which
 * `captureTurnLeftovers()` deliberately never commits -- must survive the rewind so the run's audit
 * trail stays complete.
 *
 * A non-zero exit throws {@link InternalError}, exactly as {@link revParse} does. Every realistic
 * cause (a bad object, an unwritable index, a locked file) is a genuinely unexpected operator- or
 * environment-level condition, not a modelled outcome this wrapper should report by returning.
 */
export async function resetHard(repoDir: string, rev: string): Promise<void> {
  const result = await git(repoDir, ["reset", "--hard", "--quiet", rev]);
  if (result.exitCode !== 0) {
    throw new InternalError(`git reset --hard ${rev} failed in ${repoDir}: ${result.stderr.trim()}`, {
      repoDir,
      rev,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
}

/**
 * `git show -s --format=%B <oid>`, called once per OID (never batched with a separator, which
 * could appear inside a message body). Returns each commit's full raw message body, in the same
 * order as `oids`.
 */
export async function commitMessages(repoDir: string, oids: readonly string[]): Promise<readonly string[]> {
  const messages: string[] = [];
  for (const oid of oids) {
    const result = await git(repoDir, ["show", "-s", "--format=%B", oid]);
    if (result.exitCode !== 0) {
      throw new InternalError(`git show -s --format=%B ${oid} failed in ${repoDir}: ${result.stderr.trim()}`, {
        repoDir,
        oid,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
    messages.push(result.stdout);
  }
  return messages;
}

/**
 * Stages exactly `paths` (new or modified) and commits exactly them, leaving every other staged or
 * unstaged change alone -- unlike {@link stageAllAndCommit}, which sweeps the whole tree. Returns the
 * resulting HEAD; when `paths` introduce no change relative to HEAD, nothing is committed and the
 * current HEAD is returned. Used by OSA to commit its own artifacts (locked PRD, research, spec) so the
 * dispatch layer can attest them as read at `head_before`.
 */
export async function commitPaths(repoDir: string, message: string, paths: readonly string[]): Promise<string> {
  const added = await git(repoDir, ["add", "--", ...paths]);
  if (added.exitCode !== 0) {
    throw new InternalError(`git add failed in ${repoDir}: ${added.stderr.trim()}`, { repoDir, paths, stderr: added.stderr });
  }
  const unchanged = await git(repoDir, ["diff", "--cached", "--quiet", "--", ...paths]);
  if (unchanged.exitCode === 0) {
    return revParse(repoDir, "HEAD");
  }
  const committed = await git(repoDir, ["commit", "--quiet", "-m", message, "--", ...paths]);
  if (committed.exitCode !== 0) {
    throw new InternalError(`git commit failed in ${repoDir}: ${committed.stderr.trim() || committed.stdout.trim()}`, {
      repoDir,
      paths,
      stderr: committed.stderr,
      stdout: committed.stdout,
    });
  }
  return revParse(repoDir, "HEAD");
}

/** True iff git ignores `path` (a repo-relative path) in `repoDir` (`git check-ignore -q`: exit 0 = ignored). */
export async function isPathIgnored(repoDir: string, path: string): Promise<boolean> {
  const r = await git(repoDir, ["check-ignore", "-q", "--", path]);
  return r.exitCode === 0;
}
