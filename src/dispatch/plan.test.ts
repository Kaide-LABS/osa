// Implements PHASE_3_SPEC.md §1.1 -- plan.test.ts
// Covers §8 acceptance criteria #10, #11.

import { test } from "node:test";
import assert from "node:assert/strict";
import { InternalError } from "../domain/errors.ts";
import type { RunConfig } from "../domain/run.ts";
import { otherExecutorProvider, planTurnSequence } from "./plan.ts";

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    run_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    repo_dir: "/tmp/fake-repo",
    executor_providers: ["claude-code", "codex-cli"],
    reviewer_provider: null,
    turn_timeout_ms: 1_800_000,
    phase: 1,
    spec_path: "PHASE_1_SPEC.md",
    baby_prd_path: ".claude/loopr/baby_prd.md",
    context_path: ".claude/loopr/context.md",
    is_final_phase: false,
    chat_log_gitignored: true,
    ...overrides,
  };
}

test("otherExecutorProvider returns the other member of this run's active pair", () => {
  assert.equal(otherExecutorProvider(baseConfig(), "claude-code"), "codex-cli");
  assert.equal(otherExecutorProvider(baseConfig(), "codex-cli"), "claude-code");
});

test("three known identities do not collapse an unpinned run's two executor slots", () => {
  const plan = planTurnSequence(baseConfig({ executor_providers: ["claude-code", "antigravity-cli"] }));
  assert.deepStrictEqual(plan.slice(0, 2), [
    { archetype: "executor", provider: "claude-code", reviewerReviewedOwnWork: false },
    { archetype: "executor", provider: "antigravity-cli", reviewerReviewedOwnWork: false },
  ]);
});

test("otherExecutorProvider throws InternalError for an unreachable input", () => {
  assert.throws(
    // @ts-expect-error -- deliberately calling with a value outside ProviderId to exercise the defensive branch.
    () => otherExecutorProvider(baseConfig(), "not-a-real-provider"),
    InternalError,
  );
});

test("planTurnSequence produces the three-slot sequence in order, defaulting the reviewer to the non-second-executor provider", () => {
  const plan = planTurnSequence(baseConfig());
  assert.deepStrictEqual(plan, [
    { archetype: "executor", provider: "claude-code", reviewerReviewedOwnWork: false },
    { archetype: "executor", provider: "codex-cli", reviewerReviewedOwnWork: false },
    { archetype: "reviewer", provider: "claude-code", reviewerReviewedOwnWork: false },
  ]);
});

test("planTurnSequence honours an explicit non-null reviewer_provider override", () => {
  const plan = planTurnSequence(baseConfig({ reviewer_provider: "codex-cli" }));
  assert.deepStrictEqual(plan[2], { archetype: "reviewer", provider: "codex-cli", reviewerReviewedOwnWork: true });
});

test("planTurnSequence respects executor_providers' own order", () => {
  const plan = planTurnSequence(baseConfig({ executor_providers: ["codex-cli", "claude-code"] }));
  assert.deepStrictEqual(plan[0], { archetype: "executor", provider: "codex-cli", reviewerReviewedOwnWork: false });
  assert.deepStrictEqual(plan[1], { archetype: "executor", provider: "claude-code", reviewerReviewedOwnWork: false });
  assert.deepStrictEqual(plan[2], { archetype: "reviewer", provider: "codex-cli", reviewerReviewedOwnWork: false });
});

// -------------------------------------------------------------------------------------------
// PHASE_7_SPEC.md §6.1 -- role pinning. Covers every row of the worked resolution table (all
// seven valid pin states); the two RP1/RP2-rejected states are schema-level rejections, covered
// in src/cli/run.test.ts and src/domain/driver.test.ts, not reachable via planTurnSequence
// itself (§6.5: a RunConfig that reaches planTurnSequence is already known-valid).
// -------------------------------------------------------------------------------------------

test("planTurnSequence row 1 (role_pins absent): byte-identical to today, reviewerReviewedOwnWork always false (AC2)", () => {
  const plan = planTurnSequence(baseConfig());
  assert.deepStrictEqual(plan, [
    { archetype: "executor", provider: "claude-code", reviewerReviewedOwnWork: false },
    { archetype: "executor", provider: "codex-cli", reviewerReviewedOwnWork: false },
    { archetype: "reviewer", provider: "claude-code", reviewerReviewedOwnWork: false },
  ]);
});

test("planTurnSequence row 2: {A: executor} where A === executor_providers[0] collapses the naive reviewer default onto providers[1], which reviews its own diff (AC3)", () => {
  const plan = planTurnSequence(baseConfig({ role_pins: { "claude-code": "executor" } }));
  assert.deepStrictEqual(plan, [
    { archetype: "executor", provider: "claude-code", reviewerReviewedOwnWork: false },
    { archetype: "executor", provider: "codex-cli", reviewerReviewedOwnWork: false },
    { archetype: "reviewer", provider: "codex-cli", reviewerReviewedOwnWork: true },
  ]);
});

test("planTurnSequence row 3: {A: executor} where A === executor_providers[1] does not disturb the naive reviewer default", () => {
  const plan = planTurnSequence(baseConfig({ role_pins: { "codex-cli": "executor" } }));
  assert.deepStrictEqual(plan, [
    { archetype: "executor", provider: "claude-code", reviewerReviewedOwnWork: false },
    { archetype: "executor", provider: "codex-cli", reviewerReviewedOwnWork: false },
    { archetype: "reviewer", provider: "claude-code", reviewerReviewedOwnWork: false },
  ]);
});

test("planTurnSequence row 4: {B: reviewer} only collapses both executor slots onto the sole remaining provider", () => {
  const plan = planTurnSequence(baseConfig({ role_pins: { "codex-cli": "reviewer" } }));
  assert.deepStrictEqual(plan, [
    { archetype: "executor", provider: "claude-code", reviewerReviewedOwnWork: false },
    { archetype: "executor", provider: "claude-code", reviewerReviewedOwnWork: false },
    { archetype: "reviewer", provider: "codex-cli", reviewerReviewedOwnWork: false },
  ]);
});

test("planTurnSequence rows 5/6 (AC1): {A: executor, B: reviewer} produces clean role separation for either provider as A", () => {
  const forward = planTurnSequence(baseConfig({ role_pins: { "claude-code": "executor", "codex-cli": "reviewer" } }));
  assert.deepStrictEqual(forward, [
    { archetype: "executor", provider: "claude-code", reviewerReviewedOwnWork: false },
    { archetype: "executor", provider: "claude-code", reviewerReviewedOwnWork: false },
    { archetype: "reviewer", provider: "codex-cli", reviewerReviewedOwnWork: false },
  ]);

  const reversed = planTurnSequence(baseConfig({ role_pins: { "codex-cli": "executor", "claude-code": "reviewer" } }));
  assert.deepStrictEqual(reversed, [
    { archetype: "executor", provider: "codex-cli", reviewerReviewedOwnWork: false },
    { archetype: "executor", provider: "codex-cli", reviewerReviewedOwnWork: false },
    { archetype: "reviewer", provider: "claude-code", reviewerReviewedOwnWork: false },
  ]);
});

test("planTurnSequence row 7: {A: reviewer} only, B unpinned, produces the same clean separation as an explicit executor pin on B", () => {
  const plan = planTurnSequence(baseConfig({ role_pins: { "claude-code": "reviewer" } }));
  assert.deepStrictEqual(plan, [
    { archetype: "executor", provider: "codex-cli", reviewerReviewedOwnWork: false },
    { archetype: "executor", provider: "codex-cli", reviewerReviewedOwnWork: false },
    { archetype: "reviewer", provider: "claude-code", reviewerReviewedOwnWork: false },
  ]);
});

