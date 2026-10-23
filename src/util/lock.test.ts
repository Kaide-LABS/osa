// Implements PHASE_1_SPEC.md §1.6 -- lock.test.ts
// Covers §8 acceptance criterion #25 and PHASE_1_SPEC.md §7 FM6's reviewer checklist.
//
// Never imports node:child_process (PHASE_1_SPEC.md §8 acceptance check #8 -- exactly one file,
// src/util/exec.ts, may). Consequently the real-OS-process cases here use processes that already
// exist -- this process (`process.pid`) and its real parent (`process.ppid`, a genuinely different
// OS process, so the cross-process path is exercised for real) -- and a "dead" pid is simulated
// with an implausibly large pid rather than by spawning and killing one. Probe *failures* other
// than ESRCH/EPERM cannot be produced on demand from a real OS at all, so those use `lock.ts`'s
// own `killFn` seam, mirroring the trailing-optional-`*Fn` injection convention used by
// `src/dispatch/run-loop.ts` and `src/cli/run.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { InternalError, LockHeldError } from "../domain/errors.ts";
import type { KillProbeFn } from "./lock.ts";
import {
  acquireRunLock,
  isProcessAlive,
  processLivenessVerdict,
  readRunLock,
  reclaimIfStaleOrThrow,
  releaseRunLock,
} from "./lock.ts";
import { osaDir, runLockPath } from "./paths.ts";

const IMPLAUSIBLE_DEAD_PID = 2_147_483_647;

async function freshRepoDir(): Promise<string> {
  return mkdtemp(`${tmpdir()}/osa-lock-test-`);
}

/** A `process.kill`-shaped probe that always fails with `code`, for the error paths a real OS will not produce on demand. */
function killProbeFailingWith(code: string): KillProbeFn {
  return () => {
    const err: NodeJS.ErrnoException = new Error(`simulated ${code} from the liveness probe`);
    err.code = code;
    throw err;
  };
}

/** Writes a lock file directly, bypassing acquireRunLock, so its `host`/`pid` can be chosen freely. */
async function writeLockFile(
  dir: string,
  info: { pid: number; runId: string; host: string; acquiredAt: string },
): Promise<void> {
  await mkdir(osaDir(dir), { recursive: true });
  await writeFile(runLockPath(dir), JSON.stringify(info, null, 2) + "\n", "utf8");
}

test("isProcessAlive is true for the current process and false for an implausible pid", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(IMPLAUSIBLE_DEAD_PID), false);
});

test("processLivenessVerdict distinguishes alive, dead, and indeterminate", () => {
  // Real OS processes: this one, and its actual parent -- a genuinely different process.
  assert.equal(processLivenessVerdict(process.pid), "alive");
  assert.equal(processLivenessVerdict(process.ppid), "alive");
  assert.equal(processLivenessVerdict(IMPLAUSIBLE_DEAD_PID), "dead");

  // ESRCH is the ONLY errno that means "no such process".
  assert.equal(processLivenessVerdict(process.pid, killProbeFailingWith("ESRCH")), "dead");
  // EPERM means the process exists but belongs to someone else.
  assert.equal(processLivenessVerdict(IMPLAUSIBLE_DEAD_PID, killProbeFailingWith("EPERM")), "alive");
  // Any other errno means the probe failed, which is not information about the process.
  for (const code of ["EIO", "EACCES", "ENOSYS", "EINVAL"]) {
    assert.equal(processLivenessVerdict(IMPLAUSIBLE_DEAD_PID, killProbeFailingWith(code)), "indeterminate");
  }
  // A throw that is not a Node errno object at all is equally uninformative.
  assert.equal(
    processLivenessVerdict(IMPLAUSIBLE_DEAD_PID, () => {
      throw new Error("probe blew up with no errno");
    }),
    "indeterminate",
  );
});

test("isProcessAlive fails safe: an indeterminate probe reads as alive, not dead", () => {
  // The pid is one that genuinely does not exist -- the ONLY reason to answer true here is that
  // the probe failed and so cannot be trusted to say otherwise.
  assert.equal(isProcessAlive(IMPLAUSIBLE_DEAD_PID, killProbeFailingWith("EIO")), true);
  assert.equal(isProcessAlive(IMPLAUSIBLE_DEAD_PID, killProbeFailingWith("EPERM")), true);
  assert.equal(isProcessAlive(IMPLAUSIBLE_DEAD_PID, killProbeFailingWith("ESRCH")), false);
});

test("acquireRunLock creates a readable lock, then releaseRunLock removes it", async () => {
  const dir = await freshRepoDir();
  try {
    const runId = randomUUID();
    const info = await acquireRunLock(dir, runId);
    assert.equal(info.runId, runId);
    assert.equal(info.pid, process.pid);

    const read = await readRunLock(dir);
    assert.deepStrictEqual(read, info);

    await releaseRunLock(dir, runId);
    assert.equal(await readRunLock(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a second acquire in the same directory while the holder is alive throws LockHeldError (exit 8)", async () => {
  const dir = await freshRepoDir();
  try {
    const first = randomUUID();
    await acquireRunLock(dir, first);

    const second = randomUUID();
    await assert.rejects(
      () => acquireRunLock(dir, second),
      (err: unknown) => {
        assert.ok(err instanceof LockHeldError);
        assert.equal(err.exitCode, 8);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a lock whose pid is dead on THIS host is reclaimed automatically", async () => {
  // `host` must be this machine's own hostname: a dead pid is only positive evidence of a gone
  // holder when the pid was minted here. (This test previously used "some-other-host", which the
  // implementation ignored -- see the cross-host test below.)
  const dir = await freshRepoDir();
  try {
    await writeLockFile(dir, {
      pid: IMPLAUSIBLE_DEAD_PID,
      runId: randomUUID(),
      host: hostname(),
      acquiredAt: new Date(0).toISOString(),
    });

    const newRunId = randomUUID();
    const info = await acquireRunLock(dir, newRunId);
    assert.equal(info.runId, newRunId);
    assert.equal(info.pid, process.pid);
    assert.equal(info.host, hostname());
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a lock recorded on a DIFFERENT host is refused, not reclaimed, even when its pid is dead here", async () => {
  // FM6 / shared-filesystem case: a pid number means nothing across machines. Probing the local
  // process table for a pid minted elsewhere reads "not found" essentially always, which would
  // steal a lock held by a live process on the other host.
  const dir = await freshRepoDir();
  try {
    const foreignHost = `not-${hostname()}-${randomUUID().slice(0, 8)}`;
    const staleInfo = {
      pid: IMPLAUSIBLE_DEAD_PID,
      runId: randomUUID(),
      host: foreignHost,
      acquiredAt: new Date(0).toISOString(),
    };
    await writeLockFile(dir, staleInfo);

    await assert.rejects(
      () => acquireRunLock(dir, randomUUID()),
      (err: unknown) => {
        assert.ok(err instanceof LockHeldError);
        assert.equal(err.exitCode, 8);
        // The message must name the actual mismatch, not just "lock held".
        assert.ok(err.message.includes(foreignHost), `message should name the holding host: ${err.message}`);
        assert.ok(err.message.includes(hostname()), `message should name this host: ${err.message}`);
        return true;
      },
    );

    // The foreign lock is still on disk, byte-for-byte its original owner's.
    const stillThere = await readRunLock(dir);
    assert.deepStrictEqual(stillThere, staleInfo);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("an indeterminate liveness probe refuses the reclaim instead of stealing the lock", async () => {
  // The pid here is genuinely dead and the host is genuinely this one, so EVERY other signal says
  // "reclaim me". The only thing standing between this lock and being unlinked is the probe
  // failing with an errno that is not ESRCH -- which the old code collapsed into "dead".
  const dir = await freshRepoDir();
  try {
    const info = {
      pid: IMPLAUSIBLE_DEAD_PID,
      runId: randomUUID(),
      host: hostname(),
      acquiredAt: new Date(0).toISOString(),
    };
    await writeLockFile(dir, info);
    const lockPath = runLockPath(dir);

    await assert.rejects(
      () => reclaimIfStaleOrThrow(lockPath, killProbeFailingWith("EIO")),
      (err: unknown) => {
        assert.ok(err instanceof LockHeldError);
        assert.equal(err.exitCode, 8);
        // It must say WHY it refused, not merely that it did.
        assert.ok(
          err.message.includes("could not be determined"),
          `message should explain the indeterminate probe: ${err.message}`,
        );
        return true;
      },
    );

    // Not unlinked: the untouched lock file is the actual assertion.
    assert.deepStrictEqual(await readRunLock(dir), info);

    // Control: the identical lock with a working probe IS reclaimed, proving the refusal above is
    // caused by the probe failure alone and nothing else about this fixture.
    await assert.doesNotReject(() => reclaimIfStaleOrThrow(lockPath));
    assert.equal(await readRunLock(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a corrupt lock file is treated as stale and reclaimed", async () => {
  const dir = await freshRepoDir();
  try {
    await mkdir(osaDir(dir), { recursive: true });
    await writeFile(runLockPath(dir), "{ this is not valid json", "utf8");

    const newRunId = randomUUID();
    const info = await acquireRunLock(dir, newRunId);
    assert.equal(info.runId, newRunId);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("after a stale reclaim, a live second holder still loses the retry (LockHeldError)", async () => {
  const dir = await freshRepoDir();
  try {
    // Same-host, dead pid -- the reclaimable case (previously written as "some-other-host", which
    // the implementation ignored; it is now refused rather than reclaimed).
    await writeLockFile(dir, {
      pid: IMPLAUSIBLE_DEAD_PID,
      runId: randomUUID(),
      host: hostname(),
      acquiredAt: new Date(0).toISOString(),
    });

    // First acquire reclaims the stale lock and holds it (its pid is now the live current process).
    const holder = randomUUID();
    await acquireRunLock(dir, holder);

    // A second acquire now contends with a genuinely live holder and must fail.
    await assert.rejects(() => acquireRunLock(dir, randomUUID()), LockHeldError);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("releasing another run's lock throws InternalError and leaves the lock in place", async () => {
  const dir = await freshRepoDir();
  try {
    const owner = randomUUID();
    await acquireRunLock(dir, owner);

    await assert.rejects(() => releaseRunLock(dir, randomUUID()), InternalError);
    const stillThere = await readRunLock(dir);
    assert.equal(stillThere?.runId, owner);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("releasing an already-absent lock is a no-op, not an error", async () => {
  const dir = await freshRepoDir();
  try {
    await assert.doesNotReject(() => releaseRunLock(dir, randomUUID()));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("readRunLock returns null for a directory with no lock at all", async () => {
  const dir = await freshRepoDir();
  try {
    assert.equal(await readRunLock(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("acquireRunLock does not use a check-then-act race (existsSync-style pattern)", async () => {
  // Behavioural proxy for the "wx atomic open, never existsSync-then-write" requirement: two
  // concurrent acquire calls in the same directory must never both succeed.
  const dir = await freshRepoDir();
  try {
    const results = await Promise.allSettled([acquireRunLock(dir, randomUUID()), acquireRunLock(dir, randomUUID())]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    assert.equal(succeeded.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("the lock file on disk matches the LockInfo shape", async () => {
  const dir = await freshRepoDir();
  try {
    const runId = randomUUID();
    await acquireRunLock(dir, runId);
    const raw = await readFile(runLockPath(dir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    assert.deepStrictEqual(Object.keys(parsed as Record<string, unknown>).sort(), [
      "acquiredAt",
      "host",
      "pid",
      "runId",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
