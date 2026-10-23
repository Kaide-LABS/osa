// Implements PHASE_4_SPEC.md §6.1
//
// The reference-attestation and real-production guards Phase 4 exists to add (PRD §2 AC3): that
// every dispatched turn genuinely referenced OSA's own three canonical loopr artifacts for
// the run (`baby_prd.md`, `context.md`, the phase spec), and that the reviewer turn genuinely
// produced the run's next loopr artifact rather than merely re-declaring a stale, untouched file.
// Placed in `src/dispatch/` rather than `src/verify/` because, unlike Phase 1's general-purpose
// repo verifiers, these two functions are specific to the dispatch loop's own `RunConfig`-derived
// expectations -- the same reason `record.ts`'s `reconcileHandoffRecord()` lives here too.

import type { HandoffRecord } from "../domain/relay.ts";
import { LooprArtifactBypassError } from "../domain/errors.ts";
import { changedPaths } from "../verify/git.ts";

/**
 * [DET, DECISION Phase 4] Computes the repo-relative path the reviewer turn must genuinely produce
 * next.
 * - `isFinalPhase: true` -> the literal `"BUILD_COMPLETE.md"`, the same final-phase artifact name
 *   this project's own loopr method already uses for itself, adopted as the general convention for
 *   any target build OSA drives.
 * - `isFinalPhase: false` -> `` `${dir}PHASE_${phase + 1}_SPEC.md` ``, where `dir` is `specPath`'s
 *   own directory prefix (everything up to and including its last `/`, or `""` if `specPath` has
 *   none), preserving whatever directory convention the target repo's specs already live in. The
 *   next phase number is computed from `phase` (the authoritative source of "which phase this run
 *   is") rather than by regex-parsing `specPath`'s own filename, which is not guaranteed to embed
 *   the phase number in a parseable form. Implements PHASE_4_SPEC.md §6.1.
 */
export function nextPhaseSpecPath(specPath: string, phase: number, isFinalPhase: boolean): string {
  if (isFinalPhase) {
    return "BUILD_COMPLETE.md";
  }
  const lastSlash = specPath.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : specPath.slice(0, lastSlash + 1);
  return `${dir}PHASE_${String(phase + 1)}_SPEC.md`;
}

/** The three run-specific loopr artifact paths {@link assertLooprArtifactsReferenced} checks for. */
export interface LooprArtifactPaths {
  readonly babyPrdPath: string;
  readonly contextPath: string;
  readonly specPath: string;
}

/**
 * [DET, DECISION Phase 4, PRD §2 AC3] Passes iff `record.artifacts_read` contains an entry whose
 * `path` equals each of `expected.babyPrdPath`, `expected.contextPath`, and `expected.specPath`.
 * `record` must always be the *reconciled* `HandoffRecord` (never the agent's raw draft): a
 * surviving `artifacts_read` entry is already proof the path resolved to a real file at
 * reconciliation time with a truthfully recomputed hash (`reconcileHandoffRecord()`, Phase 3,
 * unmodified, drops any entry that does not resolve) -- this function therefore needs, and accepts,
 * only expected paths, never expected hash values. On any missing path, throws
 * {@link LooprArtifactBypassError} naming every missing path, not only the first, since there is no
 * retry for this error class regardless (§7) -- completeness of the single report matters more than
 * for a retryable check. Implements PHASE_4_SPEC.md §6.1.
 */
export function assertLooprArtifactsReferenced(record: HandoffRecord, expected: LooprArtifactPaths): void {
  const required: readonly { readonly label: string; readonly path: string }[] = [
    { label: "baby_prd_path", path: expected.babyPrdPath },
    { label: "context_path", path: expected.contextPath },
    { label: "spec_path", path: expected.specPath },
  ];
  const missing = required.filter((r) => !record.artifacts_read.some((a) => a.path === r.path));
  if (missing.length === 0) {
    return;
  }
  const missingPaths = missing.map((m) => m.path);
  throw new LooprArtifactBypassError(
    `This turn's reconciled artifacts_read never references ${String(missing.length)} required ` +
      `loopr artifact path(s): ${missing.map((m) => `${m.label} ("${m.path}")`).join(", ")}. PRD ` +
      "§2 AC3 requires every dispatched turn to genuinely reference loopr's own baby_prd.md, " +
      "context.md, and the phase spec -- not merely be handed their paths.",
    { missingPaths },
  );
}

/**
 * [DET, DECISION Phase 4, PRD §2 AC3] Two-part check, both required, run only for the reviewer
 * turn:
 * 1. `record.artifacts_written` contains an entry whose `path === expectedPath`. Missing -> throws,
 *    naming this as "never declared."
 * 2. `changedPaths(repoDir, record.repo.head_before, record.repo.head_after)` (Phase 1's
 *    `src/verify/git.ts`, unmodified) includes `expectedPath`. Absent -> throws, naming this as
 *    "declared in artifacts_written but not actually touched by any commit this turn made" -- the
 *    literal, mechanical distinction between a turn that wrote the artifact for real and one that
 *    merely re-declared a stale, already-existing file to satisfy part 1 alone. Part 1 alone would
 *    let a file that already existed before this turn started, and was never touched, still pass --
 *    exactly the "bypass" AC3 exists to catch. Implements PHASE_4_SPEC.md §6.1.
 */
export async function assertNextPhaseSpecProduced(
  repoDir: string,
  record: HandoffRecord,
  expectedPath: string,
): Promise<void> {
  const declared = record.artifacts_written.some((w) => w.path === expectedPath);
  if (!declared) {
    throw new LooprArtifactBypassError(
      `The reviewer turn never declared the next loopr artifact ("${expectedPath}") in ` +
        "artifacts_written. PRD §2 AC3 requires the reviewer to genuinely produce the next phase " +
        "artifact, not merely reference an existing one.",
      { expectedPath, reason: "never_declared" },
    );
  }

  const touched = await changedPaths(repoDir, record.repo.head_before, record.repo.head_after);
  if (!touched.includes(expectedPath)) {
    throw new LooprArtifactBypassError(
      `The reviewer turn declared "${expectedPath}" in artifacts_written, but this turn's own ` +
        "commits never touched that path. A pre-existing, untouched file cannot satisfy loopr's " +
        "real-production requirement (PRD §2 AC3) by being merely re-declared.",
      { expectedPath, reason: "declared_but_not_touched" },
    );
  }
}
