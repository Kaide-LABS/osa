// Implements PHASE_1_SPEC.md §6.6 -- FM3 / AC1 [DET, the single most important module in Phase 1]
//
// `verifyContinuation()` is the deterministic, five-check git/hash predicate that decides whether
// a receiving agent genuinely continued the prior agent's phase work, rather than restarting or
// ignoring it (PRD §9 FM3, AC1). Aggregation is strict logical AND (adopted from VeriMAP §2.3 per
// PRD §8.1(3)): the verdict is `CONTINUED` only when all five checks pass. All five checks always
// run -- never short-circuited -- so a non-`CONTINUED` verdict always carries the complete set of
// failing check ids as a machine-readable retry signal.

import type { HandoffRecord } from "../domain/relay.ts";
import { blobOidAt, changedPaths, isAncestor } from "./git.ts";

/** The five continuity checks, in the fixed order they always appear in a {@link ContinuityVerdict}. */
export const CONTINUITY_CHECKS = [
  "C1_ANCESTRY",
  "C2_ADVANCEMENT",
  "C3_NO_REVERT",
  "C4_SPEC_CONTINUITY",
  "C5_ARTIFACT_ATTESTATION",
] as const;

/** A member of {@link CONTINUITY_CHECKS}. */
export type ContinuityCheckId = (typeof CONTINUITY_CHECKS)[number];

/** The outcome of one continuity check. */
export interface CheckResult {
  readonly id: ContinuityCheckId;
  readonly passed: boolean;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** The possible continuity verdict labels. */
export type ContinuityVerdictLabel = "CONTINUED" | "REDO" | "PARTIAL_REVERT" | "IGNORED" | "DIVERGED";

/** The aggregated result of {@link verifyContinuation}. */
export interface ContinuityVerdict {
  readonly verdict: ContinuityVerdictLabel;
  /** Always all five checks, in {@link CONTINUITY_CHECKS} order. */
  readonly checks: readonly CheckResult[];
  readonly failedCheckIds: readonly ContinuityCheckId[];
}

/**
 * **C1_ANCESTRY.** `prev.repo.head_after` must be a git ancestor of `next.repo.head_after`. May
 * throw {@link ContinuityError} (via `isAncestor`) if either OID is malformed -- that is the one
 * exception {@link verifyContinuation} propagates rather than folding into a failing check.
 */
export async function checkC1Ancestry(
  repoDir: string,
  prev: HandoffRecord,
  next: HandoffRecord,
): Promise<CheckResult> {
  const ancestor = prev.repo.head_after;
  const descendant = next.repo.head_after;
  const passed = await isAncestor(repoDir, ancestor, descendant);
  return {
    id: "C1_ANCESTRY",
    passed,
    detail: passed
      ? `${ancestor} is an ancestor of ${descendant}`
      : `${ancestor} is not an ancestor of ${descendant}`,
    evidence: { ancestor, descendant },
  };
}

/**
 * **C2_ADVANCEMENT.** HEAD must have moved and the next turn must have recorded at least one
 * commit -- a failure here means the receiving agent produced nothing.
 */
export function checkC2Advancement(prev: HandoffRecord, next: HandoffRecord): CheckResult {
  const advanced = next.repo.head_after !== prev.repo.head_after;
  const hasCommits = next.repo.commits.length >= 1;
  const passed = advanced && hasCommits;
  return {
    id: "C2_ADVANCEMENT",
    passed,
    detail: passed
      ? "HEAD advanced and the next turn recorded at least one commit"
      : `HEAD ${advanced ? "advanced" : "did not advance"}; next turn recorded ` +
        `${String(next.repo.commits.length)} commit(s)`,
    evidence: {
      prevHeadAfter: prev.repo.head_after,
      nextHeadAfter: next.repo.head_after,
      nextCommitCount: next.repo.commits.length,
    },
  };
}

/**
 * **C3_NO_REVERT.** The literal, deterministic definition of "not a redo": for every path the
 * prior turn touched, compare its blob OID immediately before the prior turn against its blob OID
 * after the next turn. A path is "reverted" when those OIDs match (including the both-`null` case
 * -- created by the prior turn, then deleted by the next). All-reverted fails toward `REDO`;
 * some-but-not-all-reverted fails toward `PARTIAL_REVERT`; no paths changed passes vacuously.
 */
export async function checkC3NoRevert(
  repoDir: string,
  prev: HandoffRecord,
  next: HandoffRecord,
): Promise<CheckResult> {
  const changed = await changedPaths(repoDir, prev.repo.head_before, prev.repo.head_after);
  if (changed.length === 0) {
    return {
      id: "C3_NO_REVERT",
      passed: true,
      detail: "prior turn changed no paths",
      evidence: { changedPaths: [], reason: "vacuous" },
    };
  }

  const revertedPaths: string[] = [];
  const unrevertedPaths: string[] = [];
  for (const p of changed) {
    const beforeOid = await blobOidAt(repoDir, prev.repo.head_before, p);
    const afterOid = await blobOidAt(repoDir, next.repo.head_after, p);
    if (beforeOid === afterOid) {
      revertedPaths.push(p);
    } else {
      unrevertedPaths.push(p);
    }
  }

  if (revertedPaths.length === changed.length) {
    return {
      id: "C3_NO_REVERT",
      passed: false,
      detail: `all ${String(changed.length)} path(s) the prior turn changed were reverted to their pre-turn state`,
      evidence: { revertedPaths, reason: "all_reverted" },
    };
  }
  if (revertedPaths.length > 0) {
    return {
      id: "C3_NO_REVERT",
      passed: false,
      detail: `${String(revertedPaths.length)} of ${String(changed.length)} path(s) the prior turn changed were reverted`,
      evidence: { revertedPaths, unrevertedPaths, reason: "partial_revert" },
    };
  }
  return {
    id: "C3_NO_REVERT",
    passed: true,
    detail: "no path the prior turn changed was reverted",
    evidence: { changedPaths: changed, reason: "no_revert" },
  };
}

/**
 * **C4_SPEC_CONTINUITY.** The next turn must have worked the same `PHASE_N_SPEC.md`, unmodified:
 * same path and same SHA-256 as the prior turn recorded.
 */
export function checkC4SpecContinuity(prev: HandoffRecord, next: HandoffRecord): CheckResult {
  const pathMatches = next.spec_ref.path === prev.spec_ref.path;
  const hashMatches = next.spec_ref.sha256 === prev.spec_ref.sha256;
  const passed = pathMatches && hashMatches;
  return {
    id: "C4_SPEC_CONTINUITY",
    passed,
    detail: passed
      ? "next turn worked the same, unmodified phase spec"
      : "next turn's spec_ref differs from the prior turn's spec_ref (path and/or hash mismatch)",
    evidence: { prevSpecRef: prev.spec_ref, nextSpecRef: next.spec_ref },
  };
}

/**
 * **C5_ARTIFACT_ATTESTATION.** Every artifact the prior turn wrote must appear, by path and
 * SHA-256, among the artifacts the next turn read. This is AC3's mechanical form.
 */
export function checkC5ArtifactAttestation(prev: HandoffRecord, next: HandoffRecord): CheckResult {
  const unreadPaths: string[] = [];
  const staleReads: { path: string; expectedSha256: string; foundSha256: string }[] = [];

  for (const written of prev.artifacts_written) {
    const readBack = next.artifacts_read.find((r) => r.path === written.path);
    if (readBack === undefined) {
      unreadPaths.push(written.path);
    } else if (readBack.sha256 !== written.sha256) {
      staleReads.push({ path: written.path, expectedSha256: written.sha256, foundSha256: readBack.sha256 });
    }
  }

  const passed = unreadPaths.length === 0 && staleReads.length === 0;
  return {
    id: "C5_ARTIFACT_ATTESTATION",
    passed,
    detail: passed
      ? "every artifact the prior turn wrote was read back by the next turn with a matching hash"
      : `${String(unreadPaths.length)} unread path(s), ${String(staleReads.length)} stale read(s)`,
    evidence: { unreadPaths, staleReads },
  };
}

/**
 * Runs all five continuity checks and aggregates them with a strict logical AND. Verdict-label
 * selection is deterministic, evaluated in this fixed order (first match wins):
 * 1. all five pass -> `CONTINUED`
 * 2. C3 failed with the all-reverted condition -> `REDO`
 * 3. C3 failed with the some-reverted condition -> `PARTIAL_REVERT`
 * 4. C2 or C5 failed -> `IGNORED`
 * 5. otherwise -> `DIVERGED`
 *
 * Throws nothing except {@link ContinuityError} propagated from C1's `isAncestor` bad-object path
 * (git exit `128`); every other failing check is folded into the returned verdict, never thrown.
 * The caller maps a non-`CONTINUED` verdict to exit `6`.
 */
export async function verifyContinuation(
  repoDir: string,
  prev: HandoffRecord,
  next: HandoffRecord,
): Promise<ContinuityVerdict> {
  const [c1, c3] = await Promise.all([
    checkC1Ancestry(repoDir, prev, next),
    checkC3NoRevert(repoDir, prev, next),
  ]);
  const c2 = checkC2Advancement(prev, next);
  const c4 = checkC4SpecContinuity(prev, next);
  const c5 = checkC5ArtifactAttestation(prev, next);

  const checks: readonly CheckResult[] = [c1, c2, c3, c4, c5];
  const failedCheckIds = checks.filter((c) => !c.passed).map((c) => c.id);

  let verdict: ContinuityVerdictLabel;
  if (failedCheckIds.length === 0) {
    verdict = "CONTINUED";
  } else if (!c3.passed && c3.evidence["reason"] === "all_reverted") {
    verdict = "REDO";
  } else if (!c3.passed && c3.evidence["reason"] === "partial_revert") {
    verdict = "PARTIAL_REVERT";
  } else if (!c2.passed || !c5.passed) {
    verdict = "IGNORED";
  } else {
    verdict = "DIVERGED";
  }

  return { verdict, checks, failedCheckIds };
}
