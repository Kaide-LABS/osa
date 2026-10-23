// Implements PHASE_1_SPEC.md §6.4 -- FM6 [DET]
//
// The exclusive on-disk run lock. V1's handoff model is strictly sequential, one agent active at
// a time (PRD §3 item 8); this primitive enforces that rather than assuming it. Acquisition uses
// `fs.open(path, "wx")`, an atomic filesystem primitive -- an `existsSync` check followed by a
// write would be a check-then-act race and is forbidden.
//
// Reclaiming a stale lock is the one operation here that can BREAK the invariant rather than
// enforce it, so every reclaim decision is biased toward refusing: see `reclaimIfStaleOrThrow` and
// `processLivenessVerdict` for why "the liveness probe failed" and "the lock was minted on another
// host" are both treated as held, never as stale.

import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { InternalError, LockHeldError } from "../domain/errors.ts";
import { osaDir, runLockPath } from "./paths.ts";

/** The contents of a held run lock. */
export interface LockInfo {
  readonly pid: number;
  readonly runId: string;
  readonly host: string;
  readonly acquiredAt: string;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function parseLockInfo(raw: string): LockInfo | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) {
      return null;
    }
    const d = data as Record<string, unknown>;
    if (
      typeof d["pid"] === "number" &&
      typeof d["runId"] === "string" &&
      typeof d["host"] === "string" &&
      typeof d["acquiredAt"] === "string"
    ) {
      return { pid: d["pid"], runId: d["runId"], host: d["host"], acquiredAt: d["acquiredAt"] };
    }
    return null;
  } catch {
    return null;
  }
}

/** `wx`-creates the lock file with `info`'s contents. Returns `"exists"` on `EEXIST`. */
async function tryCreateLockFile(lockPath: string, info: LockInfo): Promise<"created" | "exists"> {
  let handle;
  try {
    // [DET] atomic exclusive create -- an existsSync-then-write race is forbidden.
    handle = await open(lockPath, "wx");
  } catch (err) {
    if (isNodeError(err) && err.code === "EEXIST") {
      return "exists";
    }
    throw new InternalError(
      `Failed to create lock file ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
      { lockPath },
    );
  }
  try {
    await handle.writeFile(JSON.stringify(info, null, 2) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return "created";
}

/**
 * Inspects the existing lock at `lockPath` (already known to exist via a prior `EEXIST`) and
 * decides whether it may be reclaimed. Throws {@link LockHeldError} when the lock must be left
 * alone; otherwise unlinks it (stale or corrupt) so the caller can retry the create exactly once.
 *
 * Reclaiming means unlinking a file another process may still be relying on, so the decision is
 * deliberately asymmetric: it unlinks only on *positive* evidence that the holder is gone. Three
 * distinct refusals, in order:
 *
 * 1. **Cross-host.** A pid is only meaningful on the machine that minted it. If `info.host` is not
 *    this machine's `hostname()` -- which happens whenever `.osa` lives on a shared or
 *    network filesystem -- there is nothing local to probe, and probing anyway would almost always
 *    report "not found" and steal a lock held by a live process on the other host. Refuse without
 *    probing, and name both hosts so an operator can actually diagnose it.
 * 2. **Alive.** The usual case: the holder's pid answers the probe.
 * 3. **Indeterminate.** The probe failed for a reason that is neither "no such process" nor
 *    "exists but not yours" (see {@link processLivenessVerdict}). A failed probe is not evidence of
 *    death, so it must never license a reclaim.
 *
 * `killFn` is a test seam only, threaded to {@link processLivenessVerdict}; it defaults to the real
 * `process.kill`, so `acquireRunLock`'s call site -- which never passes it -- is byte-identical to
 * before this parameter existed. Exported for the same reason: the indeterminate branch is
 * unreachable from `acquireRunLock`'s fixed two-argument public signature, which this hardening
 * fix is not permitted to change.
 */
export async function reclaimIfStaleOrThrow(lockPath: string, killFn: KillProbeFn = defaultKillProbe): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      // Disappeared between the EEXIST and this read -- nothing to reclaim; retry the create.
      return;
    }
    throw new InternalError(
      `Failed to read lock file ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
      { lockPath },
    );
  }

  const parsed = parseLockInfo(raw);
  if (parsed === null) {
    process.stderr.write(`osa: lock file ${lockPath} is corrupt; treating as stale.\n`);
  } else {
    const localHost = hostname();
    if (parsed.host !== localHost) {
      throw new LockHeldError(
        `Run lock at ${lockPath} was acquired on host "${parsed.host}" by pid ${parsed.pid} ` +
          `(acquired at ${parsed.acquiredAt}), but this machine is host "${localHost}". A pid from ` +
          `another host cannot be checked from here, so the lock is treated as held rather than ` +
          `reclaimed. If host "${parsed.host}" is genuinely gone, delete ${lockPath} by hand.`,
        {
          holderPid: parsed.pid,
          holderHost: parsed.host,
          localHost,
          acquiredAt: parsed.acquiredAt,
          lockPath,
          reason: "cross-host",
        },
      );
    }

    const liveness = processLivenessVerdict(parsed.pid, killFn);
    if (liveness === "alive") {
      throw new LockHeldError(
        `Run lock at ${lockPath} is held by pid ${parsed.pid} (acquired at ${parsed.acquiredAt}).`,
        { holderPid: parsed.pid, acquiredAt: parsed.acquiredAt, lockPath, reason: "holder-alive" },
      );
    }
    if (liveness === "indeterminate") {
      throw new LockHeldError(
        `Run lock at ${lockPath} is held by pid ${parsed.pid} (acquired at ${parsed.acquiredAt}) and ` +
          `its liveness could not be determined -- the process probe failed for a reason other than ` +
          `"no such process". Refusing to reclaim: a failed probe is not evidence the holder is gone. ` +
          `If pid ${parsed.pid} is genuinely gone, delete ${lockPath} by hand.`,
        {
          holderPid: parsed.pid,
          acquiredAt: parsed.acquiredAt,
          lockPath,
          reason: "liveness-indeterminate",
        },
      );
    }
  }

  try {
    await unlink(lockPath);
  } catch (err) {
    if (!(isNodeError(err) && err.code === "ENOENT")) {
      throw new InternalError(
        `Failed to unlink stale lock ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
        { lockPath },
      );
    }
  }
}

/**
 * Acquires the exclusive run lock for `repoDir`. On contention with a live holder, throws
 * {@link LockHeldError} naming the holding pid and `acquiredAt`. A lock whose pid is dead (or
 * whose contents are corrupt) is reclaimed automatically, with exactly one retry; a second
 * `EEXIST` after reclaim means another process won the race and also throws {@link LockHeldError}.
 */
export async function acquireRunLock(repoDir: string, runId: string): Promise<LockInfo> {
  await mkdir(osaDir(repoDir), { recursive: true });
  const lockPath = runLockPath(repoDir);
  const info: LockInfo = {
    pid: process.pid,
    runId,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
  };

  if ((await tryCreateLockFile(lockPath, info)) === "created") {
    return info;
  }

  await reclaimIfStaleOrThrow(lockPath);

  if ((await tryCreateLockFile(lockPath, info)) === "created") {
    return info;
  }
  throw new LockHeldError(
    `Run lock at ${lockPath} was re-acquired by another process during reclaim.`,
    { lockPath },
  );
}

/** Reads the current lock, if any. Returns `null` when absent or unparseable -- never throws for those cases. */
export async function readRunLock(repoDir: string): Promise<LockInfo | null> {
  const lockPath = runLockPath(repoDir);
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return null;
    }
    throw new InternalError(
      `Failed to read lock file ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
      { lockPath },
    );
  }
  return parseLockInfo(raw);
}

/**
 * Releases the run lock, but only if it belongs to `runId`. Releasing another run's lock throws
 * {@link InternalError}. Unlinking an already-absent (or unparseable) lock is a no-op, not an error.
 */
export async function releaseRunLock(repoDir: string, runId: string): Promise<void> {
  const lockPath = runLockPath(repoDir);
  const existing = await readRunLock(repoDir);
  if (existing === null) {
    return;
  }
  if (existing.runId !== runId) {
    throw new InternalError(
      `Refusing to release run lock at ${lockPath}: it belongs to run ${existing.runId}, not ${runId}.`,
      { lockPath, ownerRunId: existing.runId, requestedRunId: runId },
    );
  }
  try {
    await unlink(lockPath);
  } catch (err) {
    if (!(isNodeError(err) && err.code === "ENOENT")) {
      throw new InternalError(
        `Failed to unlink lock file ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
        { lockPath },
      );
    }
  }
}

/**
 * The three genuinely distinguishable outcomes of probing a pid. Note that `"indeterminate"` is
 * not a fourth shade of `"dead"`: it means the probe itself failed, which says nothing at all
 * about the process. Collapsing it into `"dead"` is what lets a lock be stolen from a live holder.
 */
export type ProcessLivenessVerdict = "alive" | "dead" | "indeterminate";

/** The `process.kill(pid, 0)`-shaped probe {@link processLivenessVerdict} uses. Injectable for tests. */
export type KillProbeFn = (pid: number, signal: 0) => void;

const defaultKillProbe: KillProbeFn = (pid, signal) => {
  process.kill(pid, signal);
};

/**
 * Classifies `pid` using `process.kill(pid, 0)`'s throws-or-not-and-errno contract:
 *
 * - no throw, or `EPERM` (the process exists but belongs to another user) => `"alive"`;
 * - `ESRCH`, the one documented "no such process" errno => `"dead"`;
 * - anything else -- a different errno, or a throw that is not a Node errno object at all =>
 *   `"indeterminate"`. The probe failed; that is a fact about the probe, not about the process.
 *
 * Only `"dead"` is positive evidence that a lock's holder is gone. {@link reclaimIfStaleOrThrow}
 * relies on that: it reclaims on `"dead"` and refuses on the other two, reporting which of the two
 * it hit. `killFn` is a test seam and defaults to the real `process.kill`.
 */
export function processLivenessVerdict(pid: number, killFn: KillProbeFn = defaultKillProbe): ProcessLivenessVerdict {
  try {
    killFn(pid, 0);
    return "alive";
  } catch (err) {
    if (!isNodeError(err)) {
      return "indeterminate";
    }
    if (err.code === "ESRCH") {
      return "dead";
    }
    if (err.code === "EPERM") {
      return "alive";
    }
    return "indeterminate";
  }
}

/**
 * True iff a process with `pid` is not known to be gone. A thin fail-safe wrapper over
 * {@link processLivenessVerdict}: only the definitive `"dead"` verdict returns `false`, so an
 * indeterminate probe reads as `true` ("can't tell" must never be actioned as "gone"). The two
 * verdicts this function already got right -- no throw or `EPERM` => `true`, `ESRCH` => `false` --
 * are unchanged. Callers needing to know *why* a pid was treated as alive should call
 * {@link processLivenessVerdict} directly.
 */
export function isProcessAlive(pid: number, killFn: KillProbeFn = defaultKillProbe): boolean {
  return processLivenessVerdict(pid, killFn) !== "dead";
}
