// Implements PHASE_1_SPEC.md §6.3
//
// Repo-relative POSIX path helpers and the `.osa/` on-disk layout resolver. This is a
// Windows-hosted project: `toRepoRelPosix` converts `\` to `/` unconditionally rather than
// splitting on `node:path`'s host-specific `sep`, so its output does not depend on which platform
// it runs on.
//
// `isSafeRepoRelPath` implements exactly the three `RepoRelPath` refinements from
// `src/domain/relay.ts` §3.4 (not absolute, no backslash separators, no `..` traversal segment)
// and is what that schema's single `.refine()` calls, so the safety rule is defined in exactly
// one place rather than duplicated between the schema and the path layer (PHASE_1_SPEC.md §6.3).

import { relative } from "node:path";

/**
 * Converts an absolute filesystem path to a POSIX-separated, repo-relative path. Always replaces
 * `\` with `/` regardless of host platform.
 */
export function toRepoRelPosix(repoDir: string, absPath: string): string {
  const rel = relative(repoDir, absPath);
  return rel.replace(/\\/g, "/");
}

/**
 * True iff `p` is a safe repo-relative path: not absolute (POSIX `/` or Windows drive-letter
 * form), contains no backslash separators, and has no `..` traversal segment. This is the single
 * source of truth for repo-relative path safety; `src/domain/relay.ts`'s `RepoRelPath` schema
 * calls this function rather than re-implementing the check.
 */
export function isSafeRepoRelPath(p: string): boolean {
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
    return false;
  }
  if (p.includes("\\")) {
    return false;
  }
  if (p.split("/").includes("..")) {
    return false;
  }
  return true;
}

/**
 * The repo-root-relative name of the directory OSA owns within a repo. Exported as its own
 * constant (rather than only being embedded in {@link osaDir}) because callers that need it
 * as a *git pathspec* -- e.g. excluding OSA's own bookkeeping from a working-tree scan --
 * need the relative name, not the absolute path {@link osaDir} returns.
 */
export const OSA_DIR_NAME = ".osa";

/** The `.osa/` directory OSA owns within a repo. */
export function osaDir(repoDir: string): string {
  return `${repoDir}/${OSA_DIR_NAME}`;
}

/** The exclusive run-lock file path (`src/util/lock.ts`, PRD §9 FM6). */
export function runLockPath(repoDir: string): string {
  return `${osaDir(repoDir)}/run.lock`;
}

/**
 * Resolves a repo-relative POSIX path (already known-safe, i.e. it has passed
 * `isSafeRepoRelPath`/`RepoRelPath`) to an absolute path. Straight concatenation is correct and
 * sufficient here (not `node:path.join`/`resolve`) precisely because the input is already
 * constrained: no leading `/`, no drive letter, no `..` segment, POSIX separators only -- the same
 * safety guarantee every other path-builder in this file already relies on. Implements
 * PHASE_3_SPEC.md §1.5.
 */
export function repoRelToAbs(repoDir: string, repoRelPath: string): string {
  return `${repoDir}/${repoRelPath}`;
}

/**
 * The path a given turn's `HandoffRecord` is written to:
 * `<repoDir>/.osa/runs/<runId>/handoff/<phase>/<turnIndex>-<role>-<provider>.json`, with
 * `turnIndex` zero-padded to 3 digits so lexical order equals numeric order.
 */
export function handoffPath(
  repoDir: string,
  runId: string,
  phase: number,
  turnIndex: number,
  role: string,
  provider: string,
): string {
  const paddedTurnIndex = String(turnIndex).padStart(3, "0");
  return `${osaDir(repoDir)}/runs/${runId}/handoff/${phase}/${paddedTurnIndex}-${role}-${provider}.json`;
}

/** The append-only dispatch-log path for one driver invocation (PHASE_6_SPEC.md §3.5/§3.6, AC7). Mirrors {@link handoffPath}'s own `.osa/runs/<id>/...` convention, one directory level up from any individual phase's handoff records (which live under a phase-specific `RunConfig.run_id`, never `driver_run_id`). */
export function driverLogPath(repoDir: string, driverRunId: string): string {
  return `${osaDir(repoDir)}/runs/${driverRunId}/driver-log.jsonl`;
}

/**
 * The repo-root-relative name of the persistent chat log's own directory. A separate directory
 * from `.osa/runs/<id>/` (rather than alongside `driver-log.jsonl` and the handoff
 * records) so its directory-local `.gitignore` (`*`) scopes to exactly the files this feature
 * creates, never newly ignoring a run's own `HandoffRecord`s. Implements PHASE_10_SPEC.md §4.1.
 */
export const CHAT_LOG_DIR_NAME = "chat-log";

/** The `.osa/chat-log/` directory OSA owns within a repo (PHASE_10_SPEC.md §4.1). */
export function chatLogDir(repoDir: string): string {
  return `${osaDir(repoDir)}/${CHAT_LOG_DIR_NAME}`;
}

/**
 * The path one invocation's own persistent chat log is appended to:
 * `<repoDir>/.osa/chat-log/<chatLogId>.jsonl`. `chatLogId` is `RunConfig.chat_log_id ??
 * run_id` for a standalone `run`, or `DriveConfig.driver_run_id` for every phase of one `drive`, so
 * a whole multi-phase drive lands in one ordered file. Implements PHASE_10_SPEC.md §4.1.
 */
export function chatLogPath(repoDir: string, chatLogId: string): string {
  return `${chatLogDir(repoDir)}/${chatLogId}.jsonl`;
}

/** The managed, directory-local `.gitignore` path for the persistent chat log (PHASE_10_SPEC.md §4.1, §4.3). */
export function chatLogGitignorePath(repoDir: string): string {
  return `${chatLogDir(repoDir)}/.gitignore`;
}
