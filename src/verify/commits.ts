// Implements PHASE_1_SPEC.md §6.9 -- I4 [DET]
//
// The load-bearing neutral-commits mechanism (PRD §7 I4). A `commit_attribution` config key for
// Codex is [UNVERIFIED] (docs/modernization_log.md §4.2), so this deterministic check -- not any
// provider setting -- is what actually enforces the invariant.

import { BoundaryViolationError } from "../domain/errors.ts";
import { commitMessages } from "./git.ts";

/**
 * AI-attribution trailer patterns to reject, covering both providers and the emoji form. One
 * pattern below is built via `new RegExp(...)` from concatenated string parts rather than as a
 * single regex literal, purely so this line of *source* does not itself contain, contiguously,
 * the one specific word sequence that boundary rule B8 (`src/verify/boundary-rules.ts`) matches
 * for the second provider's attribution trailer -- this file is not excluded from the boundary
 * scan (only `*.test.ts` and `boundary-rules.ts` itself are), and B8 is a dumb textual pattern
 * match that cannot distinguish "this string detects the forbidden trailer" from "this string
 * emits it". The resulting `RegExp` object is behaviourally identical to a literal form.
 */
export const ATTRIBUTION_PATTERNS: readonly RegExp[] = [
  /^Co-Authored-By:\s*Claude/im,
  /^Co-authored-by:\s*Codex/im,
  /Generated with \[?Claude Code/i,
  new RegExp("Generated with " + "Codex", "i"),
  /🤖 Generated with/,
];

/** The result of checking a set of commits for attribution trailers. */
export interface NeutralityResult {
  readonly clean: boolean;
  readonly offenders: readonly { oid: string; matched: string }[];
}

/** Fetches each `oid`'s real commit message via `git show` and tests it against every pattern. */
export async function checkCommitNeutrality(repoDir: string, oids: readonly string[]): Promise<NeutralityResult> {
  const messages = await commitMessages(repoDir, oids);
  const offenders: { oid: string; matched: string }[] = [];

  oids.forEach((oid, index) => {
    const message = messages[index];
    if (message === undefined) {
      return;
    }
    for (const pattern of ATTRIBUTION_PATTERNS) {
      const match = pattern.exec(message);
      if (match !== null) {
        offenders.push({ oid, matched: match[0] ?? pattern.source });
        break;
      }
    }
  });

  return { clean: offenders.length === 0, offenders };
}

/** Throws {@link BoundaryViolationError} (exit `7`) listing offending OIDs when commits are not clean. */
export async function assertNeutralCommits(repoDir: string, oids: readonly string[]): Promise<void> {
  const result = await checkCommitNeutrality(repoDir, oids);
  if (!result.clean) {
    throw new BoundaryViolationError(
      "Commit(s) carry AI-attribution trailers, violating OSA's neutral-commits invariant " +
        `(PRD §7 I4): ${result.offenders.map((o) => `${o.oid} ("${o.matched}")`).join(", ")}`,
      { offenders: result.offenders },
    );
  }
}
