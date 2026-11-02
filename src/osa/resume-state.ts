// What a run needs to carry on from its post-spec gate without redoing intake, research and spec.
//
// The spec files, the locked PRD and `spec-gate.json` are already on disk, but the build and the run summary also use a handful of values the
// research and spec stages only held in memory (the spec's path and phase count, the research counts, the architecture decision, the approval
// TL;DR ...). They are saved here, in `.osa/runs/<run-id>/resume-state.json`, the moment the run reaches the gate, so a run lost to a server restart
// while it waited for the person's approval can be approved and built from what is on disk. The spec's integrity is NOT taken from this file: the
// resumed run re-verifies the spec-gate hashes (`verifySpecGate`) before anything is built.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { osaDir } from "../util/paths.ts";

export const ResumeState = z.strictObject({
  schema_version: z.literal(1),
  run_id: z.uuid(),
  spec: z.strictObject({
    specPath: z.string().min(1),
    contextPath: z.string().min(1),
    totalPhases: z.number().int().positive(),
    specAssumptions: z.array(z.string()),
  }),
  research: z.strictObject({
    skipped: z.boolean(),
    items: z.number().int().nonnegative(),
    docSources: z.number().int().nonnegative(),
    papers: z.number().int().nonnegative(),
    repos: z.number().int().nonnegative(),
    crossChecked: z.boolean(),
    degradedCheck: z.boolean(),
    flaggedClaims: z.array(z.string()),
    failedItems: z.array(z.strictObject({ slug: z.string(), problem: z.string() })),
  }),
  architecture: z.strictObject({ chosen: z.string(), why: z.string(), provider: z.string() }).nullable(),
  implications: z.strictObject({ acceptanceAdded: z.number().int().nonnegative(), outOfScopeAdded: z.number().int().nonnegative() }).nullable(),
  /** The deterministic approval TL;DR, one entry per line. */
  tldr: z.array(z.string()),
  created_at: z.string().min(1),
});
export type ResumeState = z.infer<typeof ResumeState>;

/** Where the resume state of a run lives. */
export function resumeStatePath(repoDir: string, runId: string): string {
  return `${osaDir(repoDir)}/runs/${runId}/resume-state.json`;
}

export async function writeResumeState(repoDir: string, state: ResumeState): Promise<void> {
  const path = resumeStatePath(repoDir, state.run_id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** The saved state, or null when there is none for this run or it cannot be read. */
export async function readResumeState(repoDir: string, runId: string): Promise<ResumeState | null> {
  try {
    const state = ResumeState.parse(JSON.parse(await readFile(resumeStatePath(repoDir, runId), "utf8")));
    return state.run_id === runId ? state : null;
  } catch {
    return null;
  }
}
