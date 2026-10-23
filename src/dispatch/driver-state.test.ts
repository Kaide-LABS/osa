// Implements PHASE_6_SPEC.md §1.1 -- driver-state.test.ts
// The six state-classification fixtures (baby_prd.md acceptance criteria 1/2) plus the
// decision-function fixtures, checkDriverStartCoherence fixtures, and the exhaustiveness-guard
// documentation test (§7 FM-D2). Covers §8 acceptance criteria 7, 8.

import { test } from "node:test";
import assert from "node:assert/strict";
import { InternalError } from "../domain/errors.ts";
import type { DriverStateId } from "../domain/driver.ts";
import type { DriverDecisionContext, DriverStepInput } from "./driver-state.ts";
import { checkDriverStartCoherence, classifyDriverState, decideDriverStep } from "./driver-state.ts";

// ---------------------------------------------------------------------------------------------
// checkDriverStartCoherence
// ---------------------------------------------------------------------------------------------

test("checkDriverStartCoherence returns null when BUILD_COMPLETE.md is not already present", () => {
  assert.equal(
    checkDriverStartCoherence({ buildCompleteAlreadyPresent: false, startingPhase: 1, buildCompletePath: "BUILD_COMPLETE.md" }),
    null,
  );
});

test("checkDriverStartCoherence (FM-D7) returns a non-null, on-point reason when BUILD_COMPLETE.md already exists before any dispatch", () => {
  const problem = checkDriverStartCoherence({
    buildCompleteAlreadyPresent: true,
    startingPhase: 3,
    buildCompletePath: "BUILD_COMPLETE.md",
  });
  assert.notEqual(problem, null);
  assert.ok(problem?.includes("BUILD_COMPLETE.md"));
  assert.ok(problem?.includes("3"));
});

test("checkDriverStartCoherence names the configured build_complete_path, not a hardcoded literal, in its reason", () => {
  const problem = checkDriverStartCoherence({
    buildCompleteAlreadyPresent: true,
    startingPhase: 1,
    buildCompletePath: "BUILD_COMPLETE_V3.md",
  });
  assert.notEqual(problem, null);
  assert.ok(problem?.includes("BUILD_COMPLETE_V3.md"));
  assert.ok(!problem?.includes('"BUILD_COMPLETE.md"'));
});

// ---------------------------------------------------------------------------------------------
// classifyDriverState -- the six-state fixture table (baby_prd.md acceptance criteria 1-2)
// ---------------------------------------------------------------------------------------------

test("classifyDriverState({kind:'not_dispatched'}) -> D0_NOT_STARTED", () => {
  assert.equal(classifyDriverState({ kind: "not_dispatched" }), "D0_NOT_STARTED");
});

test("classifyDriverState({kind:'run_errored'}) -> D1_RUN_ERRORED", () => {
  assert.equal(classifyDriverState({ kind: "run_errored" }), "D1_RUN_ERRORED");
});

test("classifyDriverState(run_completed, nextSpec=true, buildComplete=false) -> D2_NEXT_SPEC_PRESENT", () => {
  assert.equal(
    classifyDriverState({ kind: "run_completed", nextSpecPresent: true, buildCompletePresent: false }),
    "D2_NEXT_SPEC_PRESENT",
  );
});

test("classifyDriverState(run_completed, nextSpec=false, buildComplete=true) -> D3_BUILD_COMPLETE_PRESENT", () => {
  assert.equal(
    classifyDriverState({ kind: "run_completed", nextSpecPresent: false, buildCompletePresent: true }),
    "D3_BUILD_COMPLETE_PRESENT",
  );
});

test("classifyDriverState(run_completed, nextSpec=false, buildComplete=false) -> D4_NEITHER_PRESENT", () => {
  assert.equal(
    classifyDriverState({ kind: "run_completed", nextSpecPresent: false, buildCompletePresent: false }),
    "D4_NEITHER_PRESENT",
  );
});

test("classifyDriverState(run_completed, nextSpec=true, buildComplete=true) -> D5_BOTH_PRESENT", () => {
  assert.equal(
    classifyDriverState({ kind: "run_completed", nextSpecPresent: true, buildCompletePresent: true }),
    "D5_BOTH_PRESENT",
  );
});

// ---------------------------------------------------------------------------------------------
// decideDriverStep -- one pre-written expected decision per state (baby_prd.md acceptance criterion 2)
// ---------------------------------------------------------------------------------------------

const BASE_CTX: DriverDecisionContext = {
  currentPhase: 2,
  startingPhase: 1,
  startingSpecPath: "PHASE_1_SPEC.md",
  maxPhases: 25,
  nextSpecCandidatePath: "PHASE_3_SPEC.md",
  runProblems: [],
  runExitCode: null,
  buildCompletePath: "BUILD_COMPLETE.md",
};

test("decideDriverStep(D0_NOT_STARTED) dispatches the starting phase", () => {
  const decision = decideDriverStep("D0_NOT_STARTED", BASE_CTX);
  assert.equal(decision.kind, "dispatch");
  assert.equal(decision.nextPhase, BASE_CTX.startingPhase);
  assert.equal(decision.nextSpecPath, BASE_CTX.startingSpecPath);
  assert.equal(decision.exitCode, null);
  assert.ok(decision.reason.length > 0);
});

test("decideDriverStep(D1_RUN_ERRORED) halts with the run's own propagated exit code", () => {
  const ctx: DriverDecisionContext = { ...BASE_CTX, runProblems: ["preflight failed"], runExitCode: 3 };
  const decision = decideDriverStep("D1_RUN_ERRORED", ctx);
  assert.equal(decision.kind, "halt");
  assert.equal(decision.exitCode, 3);
  assert.ok(decision.reason.includes("preflight failed"));
});

test("decideDriverStep(D1_RUN_ERRORED) falls back to INTERNAL (1) when runExitCode is null", () => {
  const decision = decideDriverStep("D1_RUN_ERRORED", BASE_CTX);
  assert.equal(decision.kind, "halt");
  assert.equal(decision.exitCode, 1);
});

test("decideDriverStep(D2_NEXT_SPEC_PRESENT) dispatches phase+1 when under the max-phases cap", () => {
  const decision = decideDriverStep("D2_NEXT_SPEC_PRESENT", BASE_CTX);
  assert.equal(decision.kind, "dispatch");
  assert.equal(decision.nextPhase, BASE_CTX.currentPhase + 1);
  assert.equal(decision.nextSpecPath, BASE_CTX.nextSpecCandidatePath);
  assert.equal(decision.exitCode, null);
});

test("decideDriverStep(D2_NEXT_SPEC_PRESENT) (FM-D6, baby_prd.md AC6) halts with DRIVER_HALTED_MAX_PHASES when the next phase would exceed the cap", () => {
  const ctx: DriverDecisionContext = { ...BASE_CTX, currentPhase: 3, maxPhases: 3 };
  const decision = decideDriverStep("D2_NEXT_SPEC_PRESENT", ctx);
  assert.equal(decision.kind, "halt");
  assert.equal(decision.exitCode, 16);
  assert.ok(decision.reason.toLowerCase().includes("cap"));
  assert.equal(decision.nextPhase, null);
});

test("decideDriverStep(D3_BUILD_COMPLETE_PRESENT) stops with exit 0", () => {
  const decision = decideDriverStep("D3_BUILD_COMPLETE_PRESENT", BASE_CTX);
  assert.equal(decision.kind, "stop");
  assert.equal(decision.exitCode, 0);
  assert.equal(decision.nextPhase, null);
});

test("decideDriverStep(D4_NEITHER_PRESENT) halts with DRIVER_HALTED_AMBIGUOUS (14)", () => {
  const decision = decideDriverStep("D4_NEITHER_PRESENT", BASE_CTX);
  assert.equal(decision.kind, "halt");
  assert.equal(decision.exitCode, 14);
  assert.ok(decision.reason.toLowerCase().includes("ambiguous"));
});

test("decideDriverStep(D5_BOTH_PRESENT) halts with DRIVER_HALTED_INCOHERENT (15)", () => {
  const decision = decideDriverStep("D5_BOTH_PRESENT", BASE_CTX);
  assert.equal(decision.kind, "halt");
  assert.equal(decision.exitCode, 15);
  assert.ok(decision.reason.toLowerCase().includes("incoherent"));
});

test("decideDriverStep(D3/D4/D5) name the configured build_complete_path in their reason, not a hardcoded literal", () => {
  const ctx: DriverDecisionContext = { ...BASE_CTX, buildCompletePath: "BUILD_COMPLETE_V3.md" };
  for (const stateId of ["D3_BUILD_COMPLETE_PRESENT", "D4_NEITHER_PRESENT", "D5_BOTH_PRESENT"] as const) {
    const decision = decideDriverStep(stateId, ctx);
    assert.ok(decision.reason.includes("BUILD_COMPLETE_V3.md"), `${stateId} reason did not name the configured marker: ${decision.reason}`);
  }
});

test("every decideDriverStep() decision carries a non-empty reason (FM-D3)", () => {
  const states: readonly DriverStateId[] = [
    "D0_NOT_STARTED",
    "D1_RUN_ERRORED",
    "D2_NEXT_SPEC_PRESENT",
    "D3_BUILD_COMPLETE_PRESENT",
    "D4_NEITHER_PRESENT",
    "D5_BOTH_PRESENT",
  ];
  for (const stateId of states) {
    const decision = decideDriverStep(stateId, BASE_CTX);
    assert.ok(decision.reason.length > 0, `${stateId} produced an empty reason`);
  }
});

// ---------------------------------------------------------------------------------------------
// FM-D2 -- non-total routing guard. `classifyDriverState`/`decideDriverStep`'s own compile-time
// exhaustiveness is enforced by the `const exhaustive: never = ...` assignment in their terminal
// `default` arm (driver-state.ts): removing a `case` for a real `DriverStepInput.kind` or
// `DriverStateId` member fails `tsc -p tsconfig.json` under `noFallthroughCasesInSwitch`/`strict`,
// which is the actual guard (not something a `node:test` run can exercise, since a failing
// compile never produces a runnable test). This runtime pair documents the compiler-enforced
// contract's other half: a value that bypasses TypeScript entirely (an unsafe cast, exactly how a
// malformed caller or a future refactor mistake could reach the `default` arm at runtime) throws
// InternalError rather than silently falling through to a decision.
// ---------------------------------------------------------------------------------------------

test("classifyDriverState throws InternalError for an input kind that bypasses TypeScript (defense in depth behind the compile-time `never` exhaustiveness proof)", () => {
  const bogus = { kind: "not_a_real_kind" } as unknown as DriverStepInput;
  assert.throws(() => classifyDriverState(bogus), InternalError);
});

test("decideDriverStep throws InternalError for a stateId that bypasses TypeScript (defense in depth behind the compile-time `never` exhaustiveness proof)", () => {
  const bogus = "D9_MADE_UP" as unknown as DriverStateId;
  assert.throws(() => decideDriverStep(bogus, BASE_CTX), InternalError);
});
