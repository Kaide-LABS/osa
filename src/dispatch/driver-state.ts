// Implements PHASE_6_SPEC.md §3.7, §6.1, §6.3, §6.5
//
// The driver's pure, total, side-effect-free decision core: `checkDriverStartCoherence()`,
// `classifyDriverState()`, `decideDriverStep()`. **[DET]** throughout -- no I/O, no randomness, no
// clock reads, no `try`/`catch`, no `else`/catch-all branch that reaches a decision. This is the
// classic "check coherence, then decide" split of a phase controller.
//
// FM-D4 (PHASE_6_SPEC.md §7): this file imports nothing from `src/dispatch/turn.ts`,
// `src/dispatch/prompt.ts`, `src/dispatch/record.ts`, `src/verify/continuity.ts`, `src/adapters/**`,
// or `node:child_process`, and contains no `git` string literal.
//
// Corroborating literature (OSA-PRD.md §8.5, MODERNIZATION CHANGELOG 2026-08-18 item I.4):
// Madatha, "A Deterministic Control Plane for LLM Coding Agents," arXiv:2606.26924, §3.3/§4.5 --
// independently validates a hard-coded, deterministic phase-gating control layer above an LLM agent
// harness (block-on-violation, never guess) as an actively published 2026 pattern for this problem
// class.

import type { DriverDecisionKind, DriverStateId } from "../domain/driver.ts";
import { ExitCode, InternalError } from "../domain/errors.ts";

/**
 * The three genuinely distinct shapes of input {@link classifyDriverState} accepts, discriminated
 * on `kind`. Not a wire schema: constructed in-process by `runDrive()` (`src/dispatch/driver-loop.ts`)
 * from a just-completed `RunResult` plus two filesystem-existence booleans, never parsed from
 * external input. Implements PHASE_6_SPEC.md §3.7.
 */
export type DriverStepInput =
  | { readonly kind: "not_dispatched" }
  | { readonly kind: "run_errored" }
  | {
      readonly kind: "run_completed";
      readonly nextSpecPresent: boolean;
      readonly buildCompletePresent: boolean;
    };

/** The one non-flag input {@link checkDriverStartCoherence} needs. Implements PHASE_6_SPEC.md §3.7. */
export interface DriverStartFacts {
  readonly buildCompleteAlreadyPresent: boolean;
  readonly startingPhase: number;
  /** The configured completion-marker path (`DriveConfig.build_complete_path`); named in the halt reason instead of a hardcoded literal -- see {@link DriverDecisionContext.buildCompletePath}. */
  readonly buildCompletePath: string;
}

/** Everything {@link decideDriverStep} needs beyond the classified {@link DriverStateId} itself. Implements PHASE_6_SPEC.md §3.7. */
export interface DriverDecisionContext {
  readonly currentPhase: number;
  readonly startingPhase: number;
  readonly startingSpecPath: string;
  readonly maxPhases: number;
  /** The repo-relative path `nextPhaseSpecPath(specPath, currentPhase, false)` (`src/dispatch/artifacts.ts`, reused, never reimplemented -- §7 FM-D10) computed for the just-completed phase; only meaningful, and only read, in the `D2_NEXT_SPEC_PRESENT` branch. */
  readonly nextSpecCandidatePath: string;
  /** The just-completed run's own `problems`, joined for the halt reason; only meaningful in the `D1_RUN_ERRORED` branch. */
  readonly runProblems: readonly string[];
  /** The just-completed run's own `RunResult.exitCode`, propagated verbatim as this decision's own `exitCode`; only meaningful in the `D1_RUN_ERRORED` branch. */
  readonly runExitCode: number | null;
  /**
   * The configured completion-marker path (`DriveConfig.build_complete_path`, default
   * `"BUILD_COMPLETE.md"`), threaded in purely as data so the D3/D4/D5 reason strings below name
   * the marker actually being checked -- never hardcoded here. Kept as an opaque string rather than
   * read from disk or config directly: this file stays zero-I/O and config-agnostic, the same
   * purity `classifyDriverState`/`decideDriverStep`'s own doc comments already commit to; the
   * caller (`runDrive()`) is the one place config and filesystem facts meet.
   */
  readonly buildCompletePath: string;
}

/** The pure output of {@link decideDriverStep}. Never thrown, always returned -- PHASE_6_SPEC.md §6.5. */
export interface DriverDecision {
  readonly stateId: DriverStateId;
  readonly kind: DriverDecisionKind;
  /** Mandatory, non-empty for every decision -- mirrors `DriverLogEntry.reason`'s own non-empty constraint at the persisted-record level (§7 FM-D3). */
  readonly reason: string;
  readonly nextPhase: number | null;
  readonly nextSpecPath: string | null;
  readonly exitCode: number | null;
}

/**
 * [DET] Runs first, always -- before the very first `runDispatch()` call of a driver invocation.
 * The direct TypeScript analogue of loopr's own Phase 3 controller's `check_coherence()`, adapted
 * to a genuinely different reason for existing: it guards a hazard `classifyDriverState()`'s own
 * six-state enumeration structurally cannot see, because that enumeration only classifies the
 * outcome of a phase the driver itself just dispatched (see PHASE_6_SPEC.md §6.6 for the full
 * distinction). Pure, synchronous, no I/O, no `try`/`catch`. Implements PHASE_6_SPEC.md §6.1.
 */
export function checkDriverStartCoherence(facts: DriverStartFacts): string | null {
  if (facts.buildCompleteAlreadyPresent) {
    return (
      `"${facts.buildCompletePath}" already exists at the target repository root before this driver ` +
      `invocation has dispatched anything. Starting phase ${String(facts.startingPhase)} against a ` +
      `target build that already claims to be complete is incoherent -- the driver will not guess ` +
      `whether to resume, restart, or that this is the wrong target repository. A human must decide.`
    );
  }
  return null;
}

/**
 * [DET] Total over `DriverStepInput`'s three-member `kind` discriminant, and total again over the
 * `run_completed` case's own 2x2 boolean space (all four combinations return; none falls through).
 * No `else`/catch-all branch reaches a return; the `default` arm exists solely for the
 * compiler-enforced totality proof (§7 FM-D2) and is unreachable by construction -- every real call
 * site constructs one of the three `kind` variants, never a fourth. Zero I/O, zero randomness, zero
 * clock reads, no `try`/`catch`. Implements PHASE_6_SPEC.md §6.3.
 */
export function classifyDriverState(input: DriverStepInput): DriverStateId {
  switch (input.kind) {
    case "not_dispatched":
      return "D0_NOT_STARTED";
    case "run_errored":
      return "D1_RUN_ERRORED";
    case "run_completed": {
      if (input.nextSpecPresent && input.buildCompletePresent) {
        return "D5_BOTH_PRESENT";
      }
      if (input.nextSpecPresent) {
        return "D2_NEXT_SPEC_PRESENT";
      }
      if (input.buildCompletePresent) {
        return "D3_BUILD_COMPLETE_PRESENT";
      }
      return "D4_NEITHER_PRESENT";
    }
    default: {
      const exhaustive: never = input;
      throw new InternalError(`classifyDriverState: unreachable input kind`, { input: exhaustive });
    }
  }
}

/**
 * [DET] Total over all six {@link DriverStateId} members; the terminal `default` arm's
 * `const exhaustive: never = stateId` is `typing.assert_never`'s exact TypeScript analogue and is
 * unreachable by construction once `DRIVER_STATE_IDS` is exhaustively switched over -- removing a
 * `case` arm makes this a compile error under `noFallthroughCasesInSwitch`/`strict`, not a silent
 * runtime fall-through (§7 FM-D2). No `try`/`catch` anywhere in this function; no `else`; every arm
 * returns. The `D2_NEXT_SPEC_PRESENT` arm's max-phases cap check is a second, still-total decision
 * nested inside that one outer match arm (a nested split, not a new state) -- not a seventh top-level state; the
 * six-member state set stays exactly six, per baby_prd.md acceptance criterion 1 and
 * PHASE_6_SPEC.md §6.5. Implements PHASE_6_SPEC.md §6.5.
 */
export function decideDriverStep(stateId: DriverStateId, ctx: DriverDecisionContext): DriverDecision {
  switch (stateId) {
    case "D0_NOT_STARTED":
      return {
        stateId,
        kind: "dispatch",
        reason: `No phase has been dispatched yet this invocation; dispatching the starting phase ${String(ctx.startingPhase)}.`,
        nextPhase: ctx.startingPhase,
        nextSpecPath: ctx.startingSpecPath,
        exitCode: null,
      };
    case "D1_RUN_ERRORED":
      return {
        stateId,
        kind: "halt",
        reason: `Phase ${String(ctx.currentPhase)}'s own runDispatch() call did not complete successfully: ${ctx.runProblems.join("; ") || "no further detail reported"}.`,
        nextPhase: null,
        nextSpecPath: null,
        exitCode: ctx.runExitCode ?? ExitCode.INTERNAL,
      };
    case "D2_NEXT_SPEC_PRESENT": {
      const nextPhase = ctx.currentPhase + 1;
      if (nextPhase > ctx.maxPhases) {
        return {
          stateId,
          kind: "halt",
          reason: `Phase ${String(ctx.currentPhase)} completed and produced a next phase spec, but dispatching phase ${String(nextPhase)} would exceed the configured max-phases cap (${String(ctx.maxPhases)}). Stopping because of the cap, not because the build finished.`,
          nextPhase: null,
          nextSpecPath: null,
          exitCode: ExitCode.DRIVER_HALTED_MAX_PHASES,
        };
      }
      return {
        stateId,
        kind: "dispatch",
        reason: `Phase ${String(ctx.currentPhase)} completed and produced "${ctx.nextSpecCandidatePath}"; dispatching phase ${String(nextPhase)}.`,
        nextPhase,
        nextSpecPath: ctx.nextSpecCandidatePath,
        exitCode: null,
      };
    }
    case "D3_BUILD_COMPLETE_PRESENT":
      return {
        stateId,
        kind: "stop",
        reason: `Phase ${String(ctx.currentPhase)} completed and produced "${ctx.buildCompletePath}". The target build is complete.`,
        nextPhase: null,
        nextSpecPath: null,
        exitCode: ExitCode.OK,
      };
    case "D4_NEITHER_PRESENT":
      return {
        stateId,
        kind: "halt",
        reason: `Phase ${String(ctx.currentPhase)} completed, but neither a next phase spec nor "${ctx.buildCompletePath}" is present. This is ambiguous; the driver will not guess, retry, or exit as if successful.`,
        nextPhase: null,
        nextSpecPath: null,
        exitCode: ExitCode.DRIVER_HALTED_AMBIGUOUS,
      };
    case "D5_BOTH_PRESENT":
      return {
        stateId,
        kind: "halt",
        reason: `Phase ${String(ctx.currentPhase)} completed, and both a next phase spec and "${ctx.buildCompletePath}" are present. This is incoherent; the driver will not pick one.`,
        nextPhase: null,
        nextSpecPath: null,
        exitCode: ExitCode.DRIVER_HALTED_INCOHERENT,
      };
    default: {
      const exhaustive: never = stateId;
      throw new InternalError(`decideDriverStep: unreachable state id`, { stateId: exhaustive });
    }
  }
}
