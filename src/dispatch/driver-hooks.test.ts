// Tests for the before/after-phase hook seam added to runDrive (OSA WS2/WS4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { DriveConfig } from "../domain/driver.ts";
import { PrdLockViolationError } from "../domain/errors.ts";
import type { RunResult } from "./run-loop.ts";
import { runDrive } from "./driver-loop.ts";
import type { DrivePhaseHooks, PhaseHookContext } from "./driver-loop.ts";

function config(dir: string): DriveConfig {
  return {
    repo_dir: dir,
    driver_run_id: randomUUID(),
    starting_phase: 1,
    starting_spec_path: "specs/PHASE_1_SPEC.md",
    baby_prd_path: "baby_prd.md",
    context_path: "context.md",
    target_total_phases: 2,
    max_phases: 25,
    executor_providers: ["claude-code", "codex-cli"],
    reviewer_provider: null,
    turn_timeout_ms: 1_800_000,
    build_complete_path: "BUILD_COMPLETE.md",
    chat_log_gitignored: true,
  };
}

const ok: RunResult = { ok: true, exitCode: 0, turns: [], halt: null, problems: [], warnings: [] };

/** A fake dispatch that "produces" the next artifact the way a real reviewer turn would. */
function fakeDispatch(dir: string, log: string[], result: RunResult = ok) {
  return async (rc: { phase: number; is_final_phase: boolean }): Promise<RunResult> => {
    log.push(`dispatch ${String(rc.phase)}`);
    await mkdir(`${dir}/specs`, { recursive: true });
    await writeFile(rc.is_final_phase ? `${dir}/BUILD_COMPLETE.md` : `${dir}/specs/PHASE_${String(rc.phase + 1)}_SPEC.md`, "x\n", "utf8");
    return result;
  };
}

test("hooks run before and after EVERY dispatched phase, in order, with the phase's context and result", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-hooks-`);
  const log: string[] = [];
  const hooks: DrivePhaseHooks = {
    beforePhase: (c: PhaseHookContext) => {
      log.push(`before ${String(c.phase)} final=${String(c.isFinalPhase)} spec=${c.specPath}`);
      return Promise.resolve();
    },
    afterPhase: (c: PhaseHookContext, r: RunResult) => {
      log.push(`after ${String(c.phase)} ok=${String(r.ok)}`);
      return Promise.resolve();
    },
  };
  const result = await runDrive(config(dir), { runDispatchFn: fakeDispatch(dir, log) as never, hooks });
  assert.equal(result.ok, true);
  assert.deepEqual(log, [
    "before 1 final=false spec=specs/PHASE_1_SPEC.md",
    "dispatch 1",
    "after 1 ok=true",
    "before 2 final=true spec=specs/PHASE_2_SPEC.md",
    "dispatch 2",
    "after 2 ok=true",
  ]);
});

test("afterPhase also runs when the phase FAILED (step 14 must report a failed phase too)", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-hooks-`);
  const seen: boolean[] = [];
  const failing = (): Promise<RunResult> => Promise.resolve({ ok: false, exitCode: 6, turns: [], halt: null, problems: ["continuity failed"], warnings: [] });
  const result = await runDrive(config(dir), {
    runDispatchFn: failing as never,
    hooks: {
      afterPhase: (_c, r) => {
        seen.push(r.ok);
        return Promise.resolve();
      },
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(seen, [false]);
});

test("a hook that throws aborts the drive with that exact error, before any further phase is dispatched (hard invariant)", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-hooks-`);
  const log: string[] = [];
  await assert.rejects(
    runDrive(config(dir), {
      runDispatchFn: fakeDispatch(dir, log) as never,
      hooks: {
        beforePhase: (c) => {
          if (c.phase === 2) throw new PrdLockViolationError("PRD changed");
          return Promise.resolve();
        },
      },
    }),
    PrdLockViolationError,
  );
  assert.deepEqual(log, ["dispatch 1"], "phase 2 was never dispatched");
});

test("without hooks the drive behaves exactly as before", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-hooks-`);
  const log: string[] = [];
  const result = await runDrive(config(dir), { runDispatchFn: fakeDispatch(dir, log) as never });
  assert.equal(result.ok, true);
  assert.deepEqual(log, ["dispatch 1", "dispatch 2"]);
});
