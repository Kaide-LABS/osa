// Implements PHASE_6_SPEC.md §4.3
//
// The `drive` CLI command: reads/validates the `--config` JSON file against `DriveConfig`, calls
// `runDrive()`, assembles a `DriveReport`. Mirrors `src/cli/run.ts`'s own shape exactly: a function
// that returns `{report, exitCode}` and never calls `process.exit`.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { UsageError } from "../domain/errors.ts";
import { IsoUtc } from "../domain/relay.ts";
import { DriveConfig, DriverDecisionKindSchema, DriverStateIdSchema } from "../domain/driver.ts";
import type { DriveDispatchDeps } from "../dispatch/driver-loop.ts";
import { runDrive } from "../dispatch/driver-loop.ts";

/** The `drive --json` output shape (PHASE_6_SPEC.md §4.3). Mirrors `RunReport`'s/`EvidenceReport`'s own shape. */
export const DriveReport = z.strictObject({
  schema_version: z.literal(1),
  generated_at: IsoUtc,
  driver_run_id: z.uuid(),
  starting_phase: z.number().int().min(1),
  target_total_phases: z.number().int().min(1),
  max_phases: z.number().int().min(1),
  ok: z.boolean(),
  exit_code: z.number().int(),
  final_state_id: DriverStateIdSchema,
  phases: z.array(
    z.strictObject({
      phase: z.number().int().min(1),
      state_id: DriverStateIdSchema,
      decision_kind: DriverDecisionKindSchema,
      reason: z.string().min(1),
      dispatched_run_id: z.uuid().nullable(),
      dispatched_run_exit_code: z.number().int().nullable(),
    }),
  ),
  warnings: z.array(z.string()),
  problems: z.array(z.string()),
});

/** The inferred type of {@link DriveReport}. */
export type DriveReport = z.infer<typeof DriveReport>;

/** `drive` command options, derived from CLI flags (`src/cli/main.ts`). */
export interface DriveCommandOptions {
  readonly json: boolean;
  readonly configPath: string;
}

/**
 * Reads `opts.configPath` as UTF-8, validates it against `DriveConfig`, dispatches via
 * `runDrive()`, and assembles a {@link DriveReport}. A read/parse/validation failure is a
 * {@link UsageError} (exit `2`) -- the same distinction `src/cli/run.ts`'s own `runRunCommand()`
 * doc comment already draws between a malformed operator-supplied config and a malformed
 * inter-agent relay payload. Implements PHASE_6_SPEC.md §4.1, §4.3.
 *
 * `deps` is threaded straight through as `runDrive()`'s own second `deps` argument, mirroring
 * `runRunCommand()`'s own `deps` pass-through to `runDispatch()` one layer up. It defaults to
 * `undefined` (i.e. `runDrive`'s real production deps) when the caller doesn't supply it, so
 * `src/cli/main.ts`'s real-world call site -- which never passes `deps` -- is unaffected. Never
 * calls `process.exit`.
 */
export async function runDriveCommand(
  opts: DriveCommandOptions,
  deps?: DriveDispatchDeps,
): Promise<{ report: DriveReport; exitCode: number }> {
  let text: string;
  try {
    text = await readFile(opts.configPath, "utf8");
  } catch (err) {
    throw new UsageError(
      `Failed to read config file "${opts.configPath}": ${err instanceof Error ? err.message : String(err)}`,
      { configPath: opts.configPath },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UsageError(
      `Config file "${opts.configPath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { configPath: opts.configPath },
    );
  }

  const result = DriveConfig.safeParse(parsed);
  if (!result.success) {
    throw new UsageError(
      `Config file "${opts.configPath}" failed DriveConfig validation: ${z.prettifyError(result.error)}`,
      { configPath: opts.configPath },
    );
  }
  const config = result.data;

  const driveResult = await runDrive(config, deps);

  const report: DriveReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    driver_run_id: config.driver_run_id,
    starting_phase: config.starting_phase,
    target_total_phases: config.target_total_phases,
    max_phases: config.max_phases,
    ok: driveResult.ok,
    exit_code: driveResult.exitCode,
    final_state_id: driveResult.finalStateId,
    phases: driveResult.phases.map((p) => ({
      phase: p.phase,
      state_id: p.state_id,
      decision_kind: p.decision_kind,
      reason: p.reason,
      dispatched_run_id: p.dispatched_run_id,
      dispatched_run_exit_code: p.dispatched_run_exit_code,
    })),
    warnings: [...driveResult.warnings],
    problems: [...driveResult.problems],
  };

  return { report, exitCode: driveResult.exitCode };
}
