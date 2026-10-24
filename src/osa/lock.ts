// The lock (OSA_DIRECTIVE.md WS2.3). The single human touchpoint: show the TL;DR + baby PRD, ask
// Lock-and-run / Edit / Cancel, and on lock hash the PRD and record `prd_locked`. After that the PRD is
// immutable for the run: later stages read it, never rewrite it, and any hash mismatch is a hard failure.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ExitCode, IntakeError, PrdLockViolationError } from "../domain/errors.ts";
import { hasRiskyAssumption } from "../domain/intake.ts";
import type { Assumption, BabyPrd } from "../domain/intake.ts";
import { sha256File } from "../util/hash.ts";
import { osaDir, repoRelToAbs } from "../util/paths.ts";
import { parseBabyPrd } from "./baby-prd.ts";
import type { EventSink } from "./events.ts";

/** What the operator can answer at the lock. */
export type LockChoice = "lock" | "edit" | "cancel";

/** The terminal side of the lock; injected so tests drive it without a TTY. */
export interface LockIO {
  show(text: string): void;
  choose(): Promise<LockChoice>;
  /** Opens `absPath` for the operator to edit and resolves when they are done. */
  edit(absPath: string): Promise<void>;
}

/** Persisted at lock time: `.osa/runs/<run-id>/prd.lock.json`. */
export const PrdLockRecord = z.strictObject({
  schema_version: z.literal(1),
  run_id: z.uuid(),
  /** Repo-relative POSIX path of the locked PRD. */
  prd_path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  locked_at: z.string().min(1),
});
export type PrdLockRecord = z.infer<typeof PrdLockRecord>;

/** Where the lock record lives. */
export function prdLockRecordPath(repoDir: string, runId: string): string {
  return `${osaDir(repoDir)}/runs/${runId}/prd.lock.json`;
}

/** Options of {@link lockBabyPrd}. */
export interface LockOptions {
  readonly repoDir: string;
  readonly runId: string;
  /** Repo-relative path of the already-written `baby-prd.md`. */
  readonly prdPath: string;
  readonly io: LockIO;
  readonly events: EventSink;
  /** `--yes` / unattended: never prompt. */
  readonly unattended: boolean;
  /** `intake.autoLockWhenNoRisky`. */
  readonly autoLockWhenNoRisky: boolean;
}

/** The three ways the lock can end. */
export type LockOutcome =
  | { readonly kind: "locked"; readonly record: PrdLockRecord; readonly prd: BabyPrd }
  | { readonly kind: "cancelled" }
  | { readonly kind: "refused"; readonly risky: readonly Assumption[]; readonly message: string };

/** Exit code for a non-locked outcome. */
export function exitCodeForLockOutcome(outcome: LockOutcome): number {
  if (outcome.kind === "locked") return ExitCode.OK;
  return outcome.kind === "cancelled" ? ExitCode.LOCK_CANCELLED : ExitCode.PRD_LOCK_REFUSED;
}

async function writeLockRecord(repoDir: string, record: PrdLockRecord): Promise<void> {
  const path = prdLockRecordPath(repoDir, record.run_id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2) + "\n", "utf8");
}

async function lockNow(opts: LockOptions, prd: BabyPrd): Promise<LockOutcome> {
  const abs = repoRelToAbs(opts.repoDir, opts.prdPath);
  const record: PrdLockRecord = {
    schema_version: 1,
    run_id: opts.runId,
    prd_path: opts.prdPath,
    sha256: await sha256File(abs),
    locked_at: new Date().toISOString(),
  };
  await writeLockRecord(opts.repoDir, record);
  await opts.events.emit("prd_locked", { path: record.prd_path, sha256: record.sha256, unattended: opts.unattended });
  return { kind: "locked", record, prd };
}

/**
 * Locks the PRD already written at `opts.prdPath` with no prompt and no refusal: the lock before research is automatic, and the person's one
 * confirmation (which also decides on the risky assumptions) comes after the spec. The PRD hash, the lock record and `prd_locked` are the same.
 */
export async function autoLockBabyPrd(opts: Omit<LockOptions, "io" | "autoLockWhenNoRisky">): Promise<LockOutcome> {
  const markdown = await readFile(repoRelToAbs(opts.repoDir, opts.prdPath), "utf8");
  return lockNow({ ...opts, io: { show: () => undefined, choose: () => Promise.resolve("lock"), edit: () => Promise.resolve() }, autoLockWhenNoRisky: true }, parseBabyPrd(markdown));
}

/**
 * Runs the lock flow against the PRD already written at `opts.prdPath`.
 *
 * - Interactive: shows the PRD, then loops on Lock / Edit / Cancel. Edit opens the file, re-parses it
 *   (a malformed edit is reported in plain language and the editor re-opens -- never a crash), and
 *   re-shows it. No other question is ever asked.
 * - Unattended (`--yes`): locks automatically **only** when `autoLockWhenNoRisky` and there are zero
 *   `risky` assumptions; otherwise stops at the lock and returns `refused` (exit 19) without dispatching.
 */
export async function lockBabyPrd(opts: LockOptions): Promise<LockOutcome> {
  const abs = repoRelToAbs(opts.repoDir, opts.prdPath);
  const read = async (): Promise<{ markdown: string; prd: BabyPrd }> => {
    const markdown = await readFile(abs, "utf8");
    return { markdown, prd: parseBabyPrd(markdown) };
  };

  let current = await read();
  opts.io.show(current.markdown);

  if (opts.unattended) {
    const risky = current.prd.assumptions.filter((a) => a.risk === "risky");
    if (opts.autoLockWhenNoRisky && risky.length === 0) {
      return lockNow(opts, current.prd);
    }
    const message = opts.autoLockWhenNoRisky
      ? `Stopped at the lock: ${String(risky.length)} risky assumption(s) need a human look. Run again without --yes to review and lock, or edit ${opts.prdPath}.`
      : "Stopped at the lock: intake.autoLockWhenNoRisky is false, so unattended runs never lock automatically.";
    await opts.events.emit("prd_lock_refused", { risky: risky.map((a) => a.text), reason: message });
    return { kind: "refused", risky, message };
  }

  for (;;) {
    const choice = await opts.io.choose();
    if (choice === "cancel") {
      await opts.events.emit("prd_lock_cancelled", {});
      return { kind: "cancelled" };
    }
    if (choice === "lock") {
      return lockNow(opts, current.prd);
    }
    // edit
    for (;;) {
      await opts.io.edit(abs);
      try {
        current = await read();
        break;
      } catch (err) {
        if (!(err instanceof IntakeError)) throw err;
        opts.io.show(`\nThat edit can't be used: ${err.message}\nOpening the file again so you can fix it.\n`);
      }
    }
    opts.io.show(current.markdown);
    if (hasRiskyAssumption(current.prd)) {
      opts.io.show("(There are still risky assumptions above -- they are listed first.)");
    }
  }
}

/** The hash and path of the PRD as the running process saw them at lock time (never read back from disk). */
export interface PinnedLock {
  readonly sha256: string;
  readonly prd_path: string;
}

/** The terminal side of the gate (show text, ask y/N). Simpler than LockIO: no edit loop. */
export interface GateIO {
  show(text: string): void;
  confirm(): Promise<boolean>; // y/N, default false on empty/EOF
}

/** A {@link GateIO} backed by the older {@link LockIO}: showing is the same, and choosing "lock" is approval (anything else, including "edit", is not). */
export function gateIoFromLockIo(io: LockIO): GateIO {
  return { show: (text) => io.show(text), confirm: async () => (await io.choose()) === "lock" };
}

/** How the gate should behave. */
export type GateMode =
  | { readonly kind: "auto-lock" }
  | { readonly kind: "unattended"; readonly acceptRisky: boolean }
  | { readonly kind: "interactive" };

/** Input of {@link runGate}. */
export interface GateInput {
  readonly repoDir: string;
  readonly runId: string;
  /** Repo-relative path of the artifact being gated (e.g., `runs/<id>/baby-prd.md`). */
  readonly artifactPath: string;
  /** The risky assumptions that force a human (empty = nothing risky). */
  readonly risky: readonly Assumption[];
  readonly io: GateIO;
  readonly events: EventSink;
  readonly mode: GateMode;
}

/** The three ways the gate can end. */
export type GateOutcome =
  | { readonly kind: "locked"; readonly sha256: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "refused"; readonly message: string };

/** Exit code for a gate outcome (mirrors LockOutcome). */
export function exitCodeForGateOutcome(outcome: GateOutcome): number {
  if (outcome.kind === "locked") return ExitCode.OK;
  return outcome.kind === "cancelled" ? ExitCode.LOCK_CANCELLED : ExitCode.PRD_LOCK_REFUSED;
}

/** Runs the generalised gate logic. */
export async function runGate(input: GateInput): Promise<GateOutcome> {
  const abs = repoRelToAbs(input.repoDir, input.artifactPath);
  const content = await readFile(abs, "utf8");
  const artifactHash = await sha256File(abs);

  if (input.mode.kind === "auto-lock") {
    // auto-lock: always lock, never refuse (risky gate moves to spec gate).
    await input.events.emit("prd_locked", { path: input.artifactPath, sha256: artifactHash, unattended: false });
    return { kind: "locked", sha256: artifactHash };
  }

  if (input.mode.kind === "unattended") {
    // unattended: lock only when zero risky, otherwise refuse.
    if (input.mode.acceptRisky === false && input.risky.length > 0) {
      const message = `Stopped at the gate: ${String(input.risky.length)} risky assumption(s) need review. ` +
        `Rerun with \`--accept-risky\` to proceed, or refine your prompt and try again.`;
      await input.events.emit("prd_lock_refused", { risky: input.risky.map((a) => a.text), reason: message });
      return { kind: "refused", message };
    }
    // acceptRisky===true or no risky: lock now (hands-off).
    await input.events.emit("prd_locked", { path: input.artifactPath, sha256: artifactHash, unattended: true });
    return { kind: "locked", sha256: artifactHash };
  }

  // interactive: show TL;DR, ask y/N.
  input.io.show(content);
  const confirmed = await input.io.confirm();
  if (confirmed) {
    await input.events.emit("prd_locked", { path: input.artifactPath, sha256: artifactHash, unattended: false });
    return { kind: "locked", sha256: artifactHash };
  }
  await input.events.emit("prd_lock_cancelled", {});
  return { kind: "cancelled" };
}

/**
 * Hard-fails if the locked PRD changed (or vanished) since `prd_locked`. Call before every build phase and
 * at the end of the run. The mismatch is {@link PrdLockViolationError}: never retried, never repaired.
 */
export async function assertPrdUnchanged(repoDir: string, runId: string, where: string, events?: EventSink, pinned?: PinnedLock): Promise<PrdLockRecord> {
  let record: PrdLockRecord;
  try {
    record = PrdLockRecord.parse(JSON.parse(await readFile(prdLockRecordPath(repoDir, runId), "utf8")));
  } catch (err) {
    throw new PrdLockViolationError(`No valid PRD lock record exists for run ${runId}: ${err instanceof Error ? err.message : String(err)}`, { runId, where });
  }
  let actual: string;
  try {
    actual = await sha256File(repoRelToAbs(repoDir, record.prd_path));
  } catch (err) {
    throw new PrdLockViolationError(`The locked PRD "${record.prd_path}" can no longer be read (${where}): ${err instanceof Error ? err.message : String(err)}`, {
      runId,
      where,
    });
  }
  // The lock record is a file in the repository, beside the PRD it protects -- an agent that rewrites the PRD can rewrite the record
  // to match. The hash the PROCESS saw at lock time (`pinned`, held in OSA's memory) is the one an agent cannot reach.
  if (pinned !== undefined && (record.sha256 !== pinned.sha256 || record.prd_path !== pinned.prd_path)) {
    throw new PrdLockViolationError(
      `The lock record for run ${runId} no longer matches the hash and path pinned when the PRD was locked (${where}): the record claims sha256 ${record.sha256} at "${record.prd_path}", but the PRD was locked as ${pinned.sha256} at "${pinned.prd_path}". Something rewrote the lock record.`,
      { runId, where, pinned: pinned.sha256, record: record.sha256 },
    );
  }
  if (pinned !== undefined && actual !== pinned.sha256) {
    throw new PrdLockViolationError(
      `The locked PRD "${pinned.prd_path}" changed after it was locked (${where}): pinned sha256 ${pinned.sha256}, found ${actual}. The locked PRD is immutable for the run; later phases may read it but never rewrite it.`,
      { runId, where, expected: pinned.sha256, actual },
    );
  }
  if (actual !== record.sha256) {
    throw new PrdLockViolationError(
      `The locked PRD "${record.prd_path}" changed after it was locked (${where}): expected sha256 ${record.sha256}, found ${actual}. ` +
        "The locked PRD is immutable for the run; later phases may read it but never rewrite it.",
      { runId, where, expected: record.sha256, actual },
    );
  }
  await events?.emit("prd_integrity_verified", { where, sha256: actual });
  return record;
}
