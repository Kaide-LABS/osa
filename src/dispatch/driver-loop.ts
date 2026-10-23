// Implements PHASE_6_SPEC.md §6.2, §6.4, §6.7
//
// `runDrive()` -- the impure orchestrator: constructs one `RunConfig` per phase, calls
// `runDispatch()`, inspects the filesystem, calls into `driver-state.ts`, writes the dispatch log,
// loops or returns. Mirrors `src/dispatch/run-loop.ts`'s own top-level-orchestrator role for the
// driver's own layer above it.
//
// `runDrive()` constructs a `RunConfig` and calls `runDispatch()` exactly once per loop iteration
// that reaches a `dispatch` decision -- it never calls any function inside `src/dispatch/turn.ts`,
// `src/dispatch/plan.ts`, `src/dispatch/prompt.ts`, or `src/dispatch/record.ts` directly, and never
// spawns a process itself (`node:child_process` remains imported in exactly one file project-wide,
// `src/util/exec.ts`, unchanged by this phase -- §7 FM-D4).

import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AdapterRegistry } from "../ports/provider-adapter.ts";
import type { DriveConfig, DriverLogEntry, DriverStateId } from "../domain/driver.ts";
import { ExitCode, InternalError } from "../domain/errors.ts";
import type { RunConfig } from "../domain/run.ts";
import type { RunDispatchDeps, RunResult } from "./run-loop.ts";
import { runDispatch } from "./run-loop.ts";
import { runPreflight } from "../verify/preflight.ts";
import { runProcess } from "../util/exec.ts";
import { driverLogPath, repoRelToAbs } from "../util/paths.ts";
import { nextPhaseSpecPath } from "./artifacts.ts";
import type { DriverDecision, DriverDecisionContext, DriverStepInput } from "./driver-state.ts";
import { checkDriverStartCoherence, classifyDriverState, decideDriverStep } from "./driver-state.ts";

/**
 * Narrows an unknown catch value to a Node.js `ErrnoException` -- the same shape and name
 * `src/util/lock.ts`'s own private `isNodeError` helper uses. Not imported from there: that helper
 * is not exported, and duplicating this three-line structural check locally is strictly simpler
 * than exporting a new surface from a file PHASE_6_SPEC.md §1 does not list as touched by this
 * phase.
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * [DET] `true` iff `absPath` exists on disk, `false` iff it does not (`ENOENT`). Any other error
 * (a permissions failure, a locked file) is a genuinely unexpected condition and throws
 * {@link InternalError}, propagating uncaught -- never silently read as "absent," which would
 * corrupt the very ambiguity/incoherence classification this whole phase exists to get right.
 * Lives here rather than `src/util/paths.ts` because it performs I/O, unlike every existing export
 * of that file, which are pure path-string transforms. Implements PHASE_6_SPEC.md §6.2.
 */
async function fileExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return false;
    }
    throw new InternalError(`Failed to check existence of "${absPath}": ${err instanceof Error ? err.message : String(err)}`, { absPath });
  }
}

/** What a {@link DrivePhaseHooks} callback is told about the phase it wraps. */
export interface PhaseHookContext {
  readonly phase: number;
  readonly specPath: string;
  readonly isFinalPhase: boolean;
  readonly runConfig: RunConfig;
}

/**
 * Optional before/after callbacks around every dispatched phase (OSA WS2/WS4). `beforePhase` runs before the
 * phase's `runDispatch` (OSA: verify the locked PRD hash); `afterPhase` runs after it -- whether the phase
 * succeeded or not -- with its `RunResult` (OSA: step 14). A hook that throws aborts the drive: the throw
 * propagates unmodified, which is exactly what a hard invariant (`PrdLockViolationError`) needs. A hook that
 * wants to survive its own recoverable errors must catch them itself.
 */
export interface DrivePhaseHooks {
  beforePhase?(ctx: PhaseHookContext): Promise<void>;
  afterPhase?(ctx: PhaseHookContext, result: RunResult): Promise<void>;
}

/**
 * Dependencies {@link runDrive} needs beyond `DriveConfig` itself. `adapters`/`runProcessFn`/
 * `preflightFn` are threaded straight through to `runDispatch()` (or `runDispatchFn`, when
 * supplied), mirroring `RunDispatchDeps`'s own three fields exactly one layer up.
 */
export interface DriveDispatchDeps {
  readonly adapters?: Readonly<Partial<AdapterRegistry>>;
  readonly runProcessFn?: typeof runProcess;
  readonly preflightFn?: typeof runPreflight;
  /** Test seam only, mirroring the other three's own "defaults to the real thing, so the real call site is byte-identical" pattern -- lets driver-loop.test.ts inject a fake `runDispatch` entirely for D1/D2/D3/D4/D5 fixtures that do not need a real per-phase turn dispatch. */
  readonly runDispatchFn?: typeof runDispatch;
  /** OSA: callbacks around every dispatched phase. Absent => behaviour is byte-identical to before. */
  readonly hooks?: DrivePhaseHooks;
}

/** The result of {@link runDrive}. */
export interface DriveResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly finalStateId: DriverStateId;
  readonly phases: readonly DriverLogEntry[];
  readonly problems: readonly string[];
  /**
   * Warnings collected from every phase's own `RunResult.warnings`, each prefixed with the phase it
   * came from. Always present, `[]` when there are none. Never affects `ok` or `exitCode`.
   * Implements PHASE_10_SPEC.md §4.7.
   */
  readonly warnings: readonly string[];
}

/** Input to {@link buildLogEntry}: everything needed to construct one {@link DriverLogEntry}. */
interface BuildLogEntryInput {
  readonly config: DriveConfig;
  readonly phase: number;
  readonly stateId: DriverStateId;
  readonly decision: DriverDecision;
  readonly dispatchedRunId: string | null;
  readonly dispatchedRunExitCode: number | null;
}

/** [DET] Pure construction of one {@link DriverLogEntry} from a just-made {@link DriverDecision}. Implements PHASE_6_SPEC.md §6.7. */
function buildLogEntry(input: BuildLogEntryInput): DriverLogEntry {
  return {
    schema_version: 1,
    written_at: new Date().toISOString(),
    driver_run_id: input.config.driver_run_id,
    phase: input.phase,
    state_id: input.stateId,
    decision_kind: input.decision.kind,
    reason: input.decision.reason,
    dispatched_run_id: input.dispatchedRunId,
    dispatched_run_exit_code: input.dispatchedRunExitCode,
    next_phase: input.decision.nextPhase,
    exit_code: input.decision.exitCode,
  };
}

/**
 * Appends one {@link DriverLogEntry} to the JSONL dispatch log at `logPath`, creating parent
 * directories as needed. The driver is the log's only writer, by construction -- `runDrive()`'s own
 * loop is strictly sequential (one `await` at a time, no concurrent iterations), and cross-run
 * parallelism is out of scope entirely (§9). Implements PHASE_6_SPEC.md §6.7, baby_prd.md
 * acceptance criterion 7.
 */
async function appendDriverLog(logPath: string, entry: DriverLogEntry): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
}

/**
 * Builds the `RunConfig` for one dispatched phase from `config` (the driver invocation's own
 * `DriveConfig`) plus that phase's own `phase`/`specPath`/`isFinalPhase`. A separate function so the
 * `exactOptionalPropertyTypes`-driven conditional spreads for `model_overrides`/
 * `executor_prompt_path`/`reviewer_prompt_path` (each optional on both `DriveConfig` and
 * `RunConfig`, byte-identical in shape -- PHASE_6_SPEC.md §3.1) do not clutter `runDrive()`'s own
 * control flow. Never assigns `undefined` explicitly to an optional property: under
 * `exactOptionalPropertyTypes`, an optional property must be either present-with-its-real-type or
 * entirely absent, the same constraint `run-loop.ts`'s own `buildTurnDeps` helper exists for.
 */
function buildPhaseRunConfig(config: DriveConfig, phase: number, specPath: string, isFinalPhase: boolean): RunConfig {
  return {
    run_id: randomUUID(),
    repo_dir: config.repo_dir,
    executor_providers: config.executor_providers,
    reviewer_provider: config.reviewer_provider,
    turn_timeout_ms: config.turn_timeout_ms,
    phase,
    spec_path: specPath,
    baby_prd_path: config.baby_prd_path,
    context_path: config.context_path,
    is_final_phase: isFinalPhase,
    // PHASE_10_SPEC.md §6.2: unconditional, not a conditional spread -- every phase of one drive
    // carries the same `chat_log_id` (the driver's own `driver_run_id`), so all of them append to
    // one file, and `chat_log_gitignored` is always defined post-parse (like `turn_timeout_ms`).
    chat_log_id: config.driver_run_id,
    chat_log_gitignored: config.chat_log_gitignored,
    ...(config.model_overrides !== undefined ? { model_overrides: config.model_overrides } : {}),
    ...(config.seat_models !== undefined ? { seat_models: config.seat_models } : {}),
    ...(config.executor_prompt_path !== undefined ? { executor_prompt_path: config.executor_prompt_path } : {}),
    ...(config.reviewer_prompt_path !== undefined ? { reviewer_prompt_path: config.reviewer_prompt_path } : {}),
    ...(config.role_pins !== undefined ? { role_pins: config.role_pins } : {}),
  };
}

/**
 * The orchestrator: dispatches a target build's own loopr phases sequentially by calling
 * OSA's existing, unmodified `runDispatch()` once per phase, inspecting the target
 * repository's filesystem after each call, and either dispatching the next phase, stopping cleanly
 * on a genuine `BUILD_COMPLETE.md`, or halting loudly on anything ambiguous or incoherent.
 *
 * **Reused, unmodified:** `runDispatch` (`src/dispatch/run-loop.ts`), `nextPhaseSpecPath`
 * (`src/dispatch/artifacts.ts`), `repoRelToAbs`/`driverLogPath` (`src/util/paths.ts`), `RunConfig`
 * (`src/domain/run.ts`), `ExitCode`/`InternalError` (`src/domain/errors.ts`).
 *
 * A load-bearing correctness detail (PHASE_6_SPEC.md §6.4's own pseudocode elides it, but flags it
 * as real and load-bearing rather than stylistic): the `runProblems`/`runExitCode` values from a
 * `D1_RUN_ERRORED` classification, and the `nextSpecCandidatePath` from a `D2_NEXT_SPEC_PRESENT`
 * classification, must describe the *just-completed* phase's own outcome -- the phase `stateId`
 * classifies -- never the phase about to be dispatched next. This function threads them across loop
 * iterations via the `pending*`-prefixed local variables below (mirroring the same class of care
 * `run-loop.ts`'s own retry path takes with `firstTurnHeadBefore`/`prevRecord` threading), rather
 * than recomputing or guessing them from the current iteration alone. Implements PHASE_6_SPEC.md
 * §6.4.
 */
export async function runDrive(config: DriveConfig, deps?: DriveDispatchDeps): Promise<DriveResult> {
  const runDispatchFn = deps?.runDispatchFn ?? runDispatch;
  const logPath = driverLogPath(config.repo_dir, config.driver_run_id);
  const entries: DriverLogEntry[] = [];

  const startCoherenceProblem = checkDriverStartCoherence({
    buildCompleteAlreadyPresent: await fileExists(repoRelToAbs(config.repo_dir, config.build_complete_path)),
    startingPhase: config.starting_phase,
    buildCompletePath: config.build_complete_path,
  });
  if (startCoherenceProblem !== null) {
    const entry = buildLogEntry({
      config,
      phase: config.starting_phase,
      stateId: "D0_NOT_STARTED",
      decision: {
        stateId: "D0_NOT_STARTED",
        kind: "halt",
        reason: startCoherenceProblem,
        nextPhase: null,
        nextSpecPath: null,
        exitCode: ExitCode.DRIVER_START_INCOHERENT,
      },
      dispatchedRunId: null,
      dispatchedRunExitCode: null,
    });
    await appendDriverLog(logPath, entry);
    return {
      ok: false,
      exitCode: ExitCode.DRIVER_START_INCOHERENT,
      finalStateId: "D0_NOT_STARTED",
      phases: [entry],
      problems: [startCoherenceProblem],
      warnings: [],
    };
  }

  let currentPhase = config.starting_phase;
  let stateInput: DriverStepInput = { kind: "not_dispatched" };
  let lastDispatchedRunId: string | null = null;
  let lastDispatchedRunExitCode: number | null = null;
  // Describes the just-completed phase's outcome that produced the current `stateInput`; only
  // meaningful when `stateInput.kind === "run_errored"` / classifies to D1, or when the run
  // completed with `nextSpecPresent`, classifying to D2 or D5 -- see the doc comment above.
  let pendingNextSpecCandidatePath = "";
  let pendingRunProblems: readonly string[] = [];
  const warnings: string[] = [];

  for (;;) {
    const stateId = classifyDriverState(stateInput);

    const decisionCtx: DriverDecisionContext = {
      currentPhase,
      startingPhase: config.starting_phase,
      startingSpecPath: config.starting_spec_path,
      maxPhases: config.max_phases,
      nextSpecCandidatePath: pendingNextSpecCandidatePath,
      runProblems: pendingRunProblems,
      runExitCode: lastDispatchedRunExitCode,
      buildCompletePath: config.build_complete_path,
    };
    const decision = decideDriverStep(stateId, decisionCtx);

    const entry = buildLogEntry({
      config,
      phase: currentPhase,
      stateId,
      decision,
      dispatchedRunId: lastDispatchedRunId,
      dispatchedRunExitCode: lastDispatchedRunExitCode,
    });
    entries.push(entry);
    await appendDriverLog(logPath, entry);

    if (decision.kind !== "dispatch") {
      return {
        ok: decision.kind === "stop",
        exitCode: decision.exitCode ?? ExitCode.INTERNAL,
        finalStateId: stateId,
        phases: entries,
        problems: decision.kind === "halt" ? [decision.reason] : [],
        warnings: [...warnings],
      };
    }

    // decision.kind === "dispatch": build and dispatch this phase's own RunConfig.
    const phase = decision.nextPhase as number;
    const specPath = decision.nextSpecPath as string;
    const isFinalPhase = phase >= config.target_total_phases;
    const runConfig = buildPhaseRunConfig(config, phase, specPath, isFinalPhase);

    const hookCtx: PhaseHookContext = { phase, specPath, isFinalPhase, runConfig };
    await deps?.hooks?.beforePhase?.(hookCtx);
    const dispatchResult = await runDispatchFn(runConfig, deps);
    await deps?.hooks?.afterPhase?.(hookCtx, dispatchResult);
    for (const w of dispatchResult.warnings) {
      warnings.push(`phase ${String(phase)}: ${w}`);
    }
    lastDispatchedRunId = runConfig.run_id;
    lastDispatchedRunExitCode = dispatchResult.exitCode;
    currentPhase = phase;

    if (!dispatchResult.ok) {
      stateInput = { kind: "run_errored" };
      pendingRunProblems = dispatchResult.problems;
      pendingNextSpecCandidatePath = "";
      continue;
    }

    const nextSpecCandidate = nextPhaseSpecPath(specPath, phase, false);
    const [nextSpecPresent, buildCompletePresent] = await Promise.all([
      fileExists(repoRelToAbs(config.repo_dir, nextSpecCandidate)),
      fileExists(repoRelToAbs(config.repo_dir, config.build_complete_path)),
    ]);
    stateInput = { kind: "run_completed", nextSpecPresent, buildCompletePresent };
    pendingNextSpecCandidatePath = nextSpecCandidate;
    pendingRunProblems = [];
  }
}
