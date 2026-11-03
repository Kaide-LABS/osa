// Carrying on a build that was interrupted part-way.
//
// A build is a series of phases. Each phase the driver dispatches ends, in the pipeline's `afterPhase` hook, with step 14: a hand-over note, a
// plain-language summary, a commit ("chore: step 14 handoff for phase N of OSA run <id>") and a `step14_done` event carrying `ok`. A phase counts as
// FINISHED only when that closing pass ran and said ok -- a phase with commits but no closing pass was interrupted, and a phase whose closing pass
// said "not ok" failed (the driver halts on it).
//
// To carry on, the repository is put back to the commit that closed the last finished phase with a SOFT reset: the interrupted phase's commits are
// folded back into the working tree (kept, staged) rather than discarded, so the retry's first commit covers them and the reviewer's diff still
// starts before them -- the same idea as the one-retry recovery of a turn that ended without its hand-over record. Nothing is thrown away: the old
// commits stay reachable through the reflog.

import { readFile, stat } from "node:fs/promises";
import { nextPhaseSpecPath } from "../dispatch/artifacts.ts";
import { repoRelToAbs } from "../util/paths.ts";
import { commitsBetween, findCommitByMessage, isAncestor, resetSoft, revParse } from "../verify/git.ts";
import { eventsPath } from "./events.ts";

/** The phases whose closing pass ran and said ok, counted from 1 without a gap: 3 means phases 1, 2 and 3 are finished. 0 when none is. */
export async function lastFinishedPhase(repoDir: string, runId: string): Promise<number> {
  let lines: string[];
  try {
    lines = (await readFile(eventsPath(repoDir, runId), "utf8")).split("\n");
  } catch {
    return 0;
  }
  const ok = new Set<number>();
  for (const line of lines) {
    if (line === "") continue;
    try {
      const e = JSON.parse(line) as { event?: unknown; data?: { phase?: unknown; ok?: unknown } };
      if (e.event === "step14_done" && e.data?.ok === true && typeof e.data.phase === "number") ok.add(e.data.phase);
    } catch {
      // skip a damaged line
    }
  }
  let k = 0;
  while (ok.has(k + 1)) k += 1;
  return k;
}

/** The commit message that closes phase `phase` (`0` = the initial context commit, made before the first phase). */
export function phaseBoundaryMessage(runId: string, phase: number): string {
  return phase === 0 ? `chore: initial phase context for OSA run ${runId}` : `chore: step 14 handoff for phase ${String(phase)} of OSA run ${runId}`;
}

/** What to do with an interrupted build. */
export type BuildResumePlan =
  | { readonly kind: "drive"; readonly lastFinishedPhase: number; readonly startingPhase: number; readonly startingSpecPath: string; readonly foldedCommits: number }
  | { readonly kind: "finished"; readonly lastFinishedPhase: number }
  | { readonly kind: "refused"; readonly reason: string };

export interface BuildResumeInput {
  readonly repoDir: string;
  readonly runId: string;
  /** Repo-relative path of phase 1's spec. */
  readonly specPath: string;
  readonly totalPhases: number;
  readonly buildCompletePath?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides where an interrupted build carries on from, and puts the repository there. A refusal changes nothing. Soft-resets the repository to the commit
 * that closed the last finished phase when the interrupted phase left commits behind.
 */
export async function planBuildResume(input: BuildResumeInput): Promise<BuildResumePlan> {
  const { repoDir, runId, totalPhases } = input;
  const buildComplete = input.buildCompletePath ?? "BUILD_COMPLETE.md";
  const k = await lastFinishedPhase(repoDir, runId);

  if (k >= totalPhases) {
    if (await exists(repoRelToAbs(repoDir, buildComplete))) return { kind: "finished", lastFinishedPhase: k };
    return { kind: "refused", reason: `All ${String(totalPhases)} phases are recorded as finished, but ${buildComplete} is missing, so the build cannot be told apart from an unfinished one. Nothing was changed.` };
  }

  const boundary = await findCommitByMessage(repoDir, phaseBoundaryMessage(runId, k));
  if (boundary === null) {
    return { kind: "refused", reason: `The repository history no longer holds the commit that closed ${k === 0 ? "the setup before phase 1" : `phase ${String(k)}`}, so the build cannot be carried on safely. Nothing was changed.` };
  }
  const head = await revParse(repoDir, "HEAD");
  if (!(await isAncestor(repoDir, boundary, head))) {
    return { kind: "refused", reason: `The current branch no longer contains the commit that closed ${k === 0 ? "the setup before phase 1" : `phase ${String(k)}`} (it was reset or switched), so the build cannot be carried on safely. Nothing was changed.` };
  }

  let startingSpecPath = input.specPath;
  for (let p = 1; p <= k; p++) startingSpecPath = nextPhaseSpecPath(startingSpecPath, p, false);
  if (!(await exists(repoRelToAbs(repoDir, startingSpecPath)))) {
    return { kind: "refused", reason: `Phase ${String(k)} finished but the spec for phase ${String(k + 1)} (${startingSpecPath}) is not in the repository, so there is nothing to carry on from. Nothing was changed.` };
  }

  const folded = (await commitsBetween(repoDir, boundary, head)).length;
  if (folded > 0) await resetSoft(repoDir, boundary);
  return { kind: "drive", lastFinishedPhase: k, startingPhase: k + 1, startingSpecPath, foldedCommits: folded };
}
