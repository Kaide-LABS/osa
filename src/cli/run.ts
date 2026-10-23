// Implements PHASE_3_SPEC.md §6.6
//
// The `run` CLI command: reads/validates the `--config` JSON file against `RunConfig`, calls
// `runDispatch()`, renders the result. Mirrors `src/cli/doctor.ts`'s existing shape (own zod
// report schema, a function that returns `{report, exitCode}` and never calls `process.exit`).

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { UsageError } from "../domain/errors.ts";
import { HaltSignal, IsoUtc, RunId } from "../domain/relay.ts";
import { ProviderIdSchema, RunConfig } from "../domain/run.ts";
import type { RunDispatchDeps } from "../dispatch/run-loop.ts";
import { runDispatch } from "../dispatch/run-loop.ts";

/** The `run --json` output shape (PHASE_3_SPEC.md §3.5). Mirrors `DoctorReport`'s own shape. */
export const RunReport = z.strictObject({
  schema_version: z.literal(1),
  generated_at: IsoUtc,
  run_id: RunId,
  phase: z.number().int().min(1),
  ok: z.boolean(),
  exit_code: z.number().int(),
  turns: z.array(
    z.strictObject({
      turn_index: z.number().int().min(0),
      archetype: z.enum(["executor", "reviewer"]),
      provider: ProviderIdSchema,
      status: z.enum(["completed", "blocked", "halted", "failed"]),
      continuity_verdict: z.enum(["CONTINUED", "REDO", "PARTIAL_REVERT", "IGNORED", "DIVERGED"]).nullable(),
      retried: z.boolean(),
    }),
  ),
  halt: HaltSignal.nullable(),
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
});

/** The inferred type of {@link RunReport}. */
export type RunReport = z.infer<typeof RunReport>;

/** `run` command options, derived from CLI flags (`src/cli/main.ts`). */
export interface RunCommandOptions {
  readonly json: boolean;
  readonly configPath: string;
}

/**
 * Reads `opts.configPath` as UTF-8, validates it against `RunConfig`, dispatches via
 * `runDispatch()`, and assembles a {@link RunReport}. A read/parse/validation failure is a
 * {@link UsageError} (exit `2`) -- distinct from `RELAY_SCHEMA_INVALID` (exit `4`), which is
 * reserved for the inter-agent `HandoffRecord` payload specifically; a malformed operator-supplied
 * run config is squarely "the CLI invocation itself was malformed." Implements
 * PHASE_3_SPEC.md §6.6.
 *
 * `deps` is threaded straight through as `runDispatch()`'s own second `deps` argument, mirroring
 * `runDispatch`'s own `RunDispatchDeps` injection seam one level up rather than inventing a new
 * one. It defaults to `undefined` (i.e. `runDispatch`'s real production deps: real `runPreflight`,
 * real `ADAPTER_REGISTRY`, real `runProcess`) when the caller doesn't supply it, so
 * `src/cli/main.ts`'s real-world call site -- which never passes `deps` -- is byte-identical to
 * before this parameter existed. This is a test seam only, not a behaviour change.
 */
export async function runRunCommand(
  opts: RunCommandOptions,
  deps?: RunDispatchDeps,
): Promise<{ report: RunReport; exitCode: number }> {
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

  const result = RunConfig.safeParse(parsed);
  if (!result.success) {
    throw new UsageError(
      `Config file "${opts.configPath}" failed RunConfig validation: ${z.prettifyError(result.error)}`,
      { configPath: opts.configPath },
    );
  }
  const config = result.data;

  const dispatchResult = await runDispatch(config, deps);

  const report: RunReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    run_id: config.run_id,
    phase: config.phase,
    ok: dispatchResult.ok,
    exit_code: dispatchResult.exitCode,
    turns: dispatchResult.turns.map((t) => ({
      turn_index: t.turnIndex,
      archetype: t.archetype,
      provider: t.provider,
      status: t.status,
      continuity_verdict: t.continuityVerdict,
      retried: t.retried,
    })),
    halt: dispatchResult.halt,
    problems: [...dispatchResult.problems],
    warnings: [...dispatchResult.warnings],
  };

  return { report, exitCode: dispatchResult.exitCode };
}
