// Implements PHASE_3_SPEC.md §6.3 -- [DET, DECISION Phase 3, PRD §7 I2]
//
// The central mechanism that keeps `HandoffRecord`'s correctness-critical fields out of the
// "agent's say-so" path I2 forbids, while still letting the agent be the source of the fields only
// it can know (the summary text, which paths it touched). A "compare and reject on mismatch"
// design was considered and rejected: it would require the agent's prompt instructions to get git
// plumbing and hashing exactly right merely to avoid a spurious rejection, adding fragility with
// no security benefit -- replacing outright is simpler, strictly more robust to an agent's
// git-plumbing mistakes, and is what §6.2 item 4 already tells the agent to expect.
//
// `artifacts_read` and `artifacts_written` are both replaced with ground truth, but with ground
// truth taken at **two different points in time**, and that asymmetry is load-bearing rather than an
// inconsistency:
//
//   * `artifacts_written` -- reconciled against the **working tree as the turn left it**
//     (`reconcileWrittenFileRefs`). "What this turn produced" is by definition the final content on
//     disk once the turn is over, so end-of-turn disk is the only correct reference point.
//   * `artifacts_read` -- reconciled against **`ground.headBefore`**, the commit the *prior* turn
//     produced, i.e. the repository exactly as this turn found it (`reconcileReadFileRefs`). A read
//     necessarily happened before the reading turn's own edits, so end-of-turn disk is the wrong
//     clock for it.
//
// [Live-run bug, fixed here.] Both used to be reconciled from end-of-turn disk. That silently broke
// `checkC5ArtifactAttestation` (`src/verify/continuity.ts`, correct and untouched), which proves a
// turn genuinely read what the prior turn wrote by comparing `next.artifacts_read[p].sha256`
// against `prev.artifacts_written[p].sha256`. Whenever a turn legitimately *modified* a file it had
// been handed -- reading the prior turn's test file and adding a case to it, entirely normal
// spec-following work -- the disk-based hash captured at end-of-turn was the hash of the turn's own
// edit, never of the version it read, so C5 reported a "stale read" indistinguishable from having
// never read the file at all. Observed live: turn 0 wrote `wordcount.mjs` and `wordcount.test.mjs`;
// turn 1 demonstrably read both, appended a test case to `wordcount.test.mjs`, and committed --
// the untouched file attested cleanly, the modified one failed C5. This was structural, not an
// agent-behaviour gap: no wording in any prompt can make a turn satisfy a check that compares the
// wrong point in time, and the only way to pass was to never modify a handed-over file. The overall
// philosophy is unchanged -- ground truth still fully replaces the agent's claims, and the agent's
// own hashes are still discarded outright; only *which* ground truth `artifacts_read` is replaced
// with was wrong.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { FileRef, HandoffRecord } from "../domain/relay.ts";
import { HandoffRecord as HandoffRecordSchema } from "../domain/relay.ts";
import { RelaySchemaError } from "../domain/errors.ts";
import { blobContentAt, commitsBetween, currentBranch, revParse } from "../verify/git.ts";
import { sha256File, sha256String } from "../util/hash.ts";
import { repoRelToAbs } from "../util/paths.ts";

/** The independently-computed ground truth {@link reconcileHandoffRecord} reconciles a draft against. */
export interface RecordGroundTruth {
  readonly headBefore: string;
  readonly branch: string;
  readonly specRef: FileRef;
}

/**
 * [DET] `{ headBefore: await revParse(repoDir, "HEAD"), branch: await currentBranch(repoDir) }` --
 * called immediately before spawning a turn's process, so `headBefore` is genuinely "immediately
 * before the turn started." Implements PHASE_3_SPEC.md §6.3.
 */
export async function captureGroundTruthBefore(repoDir: string): Promise<{ headBefore: string; branch: string }> {
  const headBefore = await revParse(repoDir, "HEAD");
  const branch = await currentBranch(repoDir);
  return { headBefore, branch };
}

function isEnoentError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * **`artifacts_written`'s reconciler.** Recomputes every `FileRef`'s SHA-256 from the real file on
 * disk *as the turn left it*, dropping (not failing) any entry whose declared path does not
 * actually exist -- an agent may over-report. A non-ENOENT read failure (e.g. a permissions error)
 * is not swallowed as a missing file; it propagates, since that is a genuinely unexpected condition
 * the spec's "does not exist" carve-out does not cover.
 *
 * Disk, at end of turn, is the *correct* reference point here and is unchanged by the
 * `artifacts_read` fix documented in the file header: what a turn wrote is exactly what its edits
 * finally left behind.
 */
async function reconcileWrittenFileRefs(repoDir: string, headAfter: string, refs: readonly FileRef[]): Promise<readonly FileRef[]> {
  const out: FileRef[] = [];
  for (const ref of refs) {
    const absPath = repoRelToAbs(repoDir, ref.path);
    let sha256: string;
    let diskText: string;
    try {
      sha256 = await sha256File(absPath);
      diskText = await readFile(absPath, "utf8");
    } catch (err) {
      if (isEnoentError(err)) {
        continue;
      }
      throw err;
    }
    // Under core.autocrlf (the Git-for-Windows default) a file an agent wrote with CRLF is STORED with LF, and the next turn reads the stored form
    // (`reconcileReadFileRefs`). Attesting the CRLF bytes made C5 call a correct hand-over a stale read (found by the live e2e run: Codex wrote CRLF
    // files and the build stopped). When the committed form differs from the disk only by line endings, the committed form is what was handed over;
    // any other difference (a genuine uncommitted edit) keeps the disk hash exactly as before.
    const stored = await blobContentAt(repoDir, headAfter, ref.path);
    if (stored !== null && stored !== diskText && stored.replace(/\r\n/g, "\n") === diskText.replace(/\r\n/g, "\n")) sha256 = sha256String(stored);
    out.push({ path: ref.path, sha256 });
  }
  return out;
}

/**
 * **`artifacts_read`'s reconciler.** Recomputes every `FileRef`'s SHA-256 from the file's content
 * **at `headBefore`** -- the commit this turn started from, captured by
 * {@link captureGroundTruthBefore} immediately before the turn was spawned -- rather than from
 * end-of-turn disk. See the file header for why the two collections use different reference points;
 * in short, a read can only ever have been of the repository as this turn found it, and hashing
 * end-of-turn disk instead made `C5_ARTIFACT_ATTESTATION` fail for every turn that legitimately
 * modified a file the prior turn handed it.
 *
 * Hashing goes through `sha256String` on the blob's content, deliberately the same SHA-256 utility
 * `sha256File` uses for disk bytes, so a file that is byte-identical at `headBefore` and on disk
 * hashes identically by both routes -- which is what keeps `assertLooprArtifactsReferenced()`'s
 * static loopr artifacts (`baby_prd.md`, `context.md`, the phase spec, none of them modified
 * mid-run) reconciling exactly as before.
 *
 * Drop-don't-fail semantics are preserved exactly, via `blobContentAt`'s `null`-on-absent return:
 * an entry whose path did not exist at `headBefore` is dropped, mirroring the ENOENT drop above.
 * That is the right disposition and not merely a symmetry: a path absent at turn-start is one the
 * agent could not possibly have read -- typically one it is about to create itself and
 * over-reported -- which is precisely the over-report case the drop behaviour already existed for.
 * (Corollary for operators: the run's loopr artifacts must be *committed* at the run's starting
 * HEAD, not left uncommitted in the working tree, or they cannot be attested as read.)
 *
 * Known, bounded edge case -- `core.autocrlf`. `artifacts_read` now hashes *stored* bytes while
 * `artifacts_written` hashes *working-tree* bytes, and git only guarantees those are the same bytes
 * when no EOL filter is active. Under `core.autocrlf=true` (the Git-for-Windows installer default,
 * and set at *system* level on a stock Windows install) a file whose working-tree copy uses CRLF is
 * stored as LF, so the two routes would disagree for that file and C5 would see a spurious stale
 * read. It does not bite the real path: both provider CLIs write LF, so an agent-authored artifact
 * -- the only kind `artifacts_written` ever names -- is LF on disk and LF in the object store, and
 * hashes identically either way. [Verified empirically on this machine with
 * `core.autocrlf=true`: an LF-authored file's disk and blob SHA-256 are equal; a deliberately
 * CRLF-authored one's are not.] Applying git's checkout-side filters instead (`git cat-file
 * --filters`) was considered and rejected: it would fix the CRLF-on-disk case by breaking the
 * far more common LF-on-disk one, since under `autocrlf=true` git's notion of the working-tree form
 * is CRLF whether or not the file on disk actually uses it.
 */
async function reconcileReadFileRefs(
  repoDir: string,
  headBefore: string,
  refs: readonly FileRef[],
): Promise<readonly FileRef[]> {
  const out: FileRef[] = [];
  for (const ref of refs) {
    const content = await blobContentAt(repoDir, headBefore, ref.path);
    if (content === null) {
      continue;
    }
    out.push({ path: ref.path, sha256: sha256String(content) });
  }
  return out;
}

/**
 * [DET, DECISION Phase 3, PRD §7 I2] Overwrites the agent-authored draft's `repo`, `spec_ref`, and
 * every artifact `FileRef`'s `sha256` with OSA's own independently-computed ground truth,
 * discarding the agent's own claims entirely -- they were never trustworthy ground truth in the
 * first place. The two artifact collections are reconciled against ground truth taken at
 * *different* points in time -- `artifacts_written` from end-of-turn disk
 * ({@link reconcileWrittenFileRefs}), `artifacts_read` from `ground.headBefore`
 * ({@link reconcileReadFileRefs}) -- which the file header explains in full and which is deliberate,
 * not an oversight. Re-validates the fully reconciled object: this can fail even though `draft` itself
 * parsed successfully (e.g. the agent claimed `status: "completed"` but ground truth shows zero
 * real commits, violating R3). On failure, throws {@link RelaySchemaError} naming this as a
 * reconciliation inconsistency rather than a raw schema defect. Implements PHASE_3_SPEC.md §6.3.
 */
export async function reconcileHandoffRecord(
  repoDir: string,
  draft: HandoffRecord,
  ground: RecordGroundTruth,
): Promise<HandoffRecord> {
  const headAfter = await revParse(repoDir, "HEAD");
  const commits = await commitsBetween(repoDir, ground.headBefore, headAfter);

  const artifactsRead = await reconcileReadFileRefs(repoDir, ground.headBefore, draft.artifacts_read);
  const artifactsWritten = await reconcileWrittenFileRefs(repoDir, headAfter, draft.artifacts_written);

  const reconciled = {
    ...draft,
    repo: { branch: ground.branch, head_before: ground.headBefore, head_after: headAfter, commits: [...commits] },
    spec_ref: { path: ground.specRef.path, sha256: ground.specRef.sha256 },
    artifacts_read: artifactsRead,
    artifacts_written: artifactsWritten,
  };

  const result = HandoffRecordSchema.safeParse(reconciled);
  if (!result.success) {
    throw new RelaySchemaError(
      `HandoffRecord failed re-validation after ground-truth reconciliation (this is a ` +
        `reconciliation inconsistency -- ground truth contradicts the agent's own report -- not a ` +
        `raw schema defect): ${z.prettifyError(result.error)}`,
      { stage: "reconciliation" },
    );
  }
  return result.data;
}

const COMMIT_BLOCK = /\b(?:git\s+(?:add|commit|index|staging)|index\.lock|\.git\b|could not (?:create a )?commit|unable to commit|commit(?:s|ting)?\s+(?:was|were|is|are)?\s*(?:blocked|denied|failed|not possible)|staging and commit)/i;

/**
 * A turn that did all its work but could not run `git commit` in its sandbox (Codex's workspace-write sandbox on Windows makes `.git` unwritable;
 * the agent reports `blocked`, "git could not create .git/index.lock: permission denied") has not failed: OSA's own leftover capture has already
 * committed the working tree. Such a turn is accepted as `completed`, with a note saying so. Only when ALL hold: the agent reports `blocked` with no
 * halt signal, OSA captured and committed leftovers, and the agent's own words are about committing. Any other block still halts the run. Found by
 * the live e2e runs: two finished builds (17 passing tests each) stopped with D1_RUN_ERRORED for exactly this. Pure.
 */
export function acceptCommitOnlyBlock(draft: HandoffRecord, leftoversCommitted: boolean): HandoffRecord {
  if (draft.status !== "blocked" || draft.halt !== null || !leftoversCommitted) return draft;
  const said = [draft.work_done, ...draft.next_steps, ...draft.open_questions].join("\n");
  if (!COMMIT_BLOCK.test(said)) return draft;
  return { ...draft, status: "completed", work_done: `${draft.work_done} (OSA note: this turn could not run git commit in its sandbox; OSA committed its working-tree changes for it.)` };
}
