// Implements PHASE_1_SPEC.md §1.6 -- roles.test.ts
// Covers registry completeness, tier assignment, and absence of model names (FM4 check #3).

import { test } from "node:test";
import assert from "node:assert/strict";
import { InternalError } from "./errors.ts";
import { ARCHETYPES, getRole, ROLE_REGISTRY } from "./roles.ts";
import { MODEL_TIERS } from "./tiers.ts";

test("ROLE_REGISTRY has exactly one entry per archetype", () => {
  assert.deepStrictEqual(Object.keys(ROLE_REGISTRY).sort(), [...ARCHETYPES].sort());
});

test("every ROLE_REGISTRY entry's tier is a member of MODEL_TIERS", () => {
  for (const archetype of ARCHETYPES) {
    const role = ROLE_REGISTRY[archetype];
    assert.ok(
      (MODEL_TIERS as readonly string[]).includes(role.tier),
      `${archetype}'s tier "${role.tier}" is not a member of MODEL_TIERS`,
    );
  }
});

test("every ROLE_REGISTRY entry pins receivesPriorAgentReasoning to the literal false", () => {
  for (const archetype of ARCHETYPES) {
    assert.equal(ROLE_REGISTRY[archetype].receivesPriorAgentReasoning, false);
  }
});

test("executor is the only archetype crossProviderInV1: true (PRD §6.3)", () => {
  for (const archetype of ARCHETYPES) {
    const expected = archetype === "executor";
    assert.equal(ROLE_REGISTRY[archetype].crossProviderInV1, expected, `${archetype}.crossProviderInV1`);
  }
});

test("only executor and reviewer are instantiatedInV1 (PRD §6.3)", () => {
  const expectedInstantiated = new Set(["executor", "reviewer"]);
  for (const archetype of ARCHETYPES) {
    assert.equal(
      ROLE_REGISTRY[archetype].instantiatedInV1,
      expectedInstantiated.has(archetype),
      `${archetype}.instantiatedInV1`,
    );
  }
});

test("architect is never instantiated by OSA (the operator's own persistent session)", () => {
  assert.equal(ROLE_REGISTRY.architect.instantiatedInV1, false);
  assert.equal(ROLE_REGISTRY.architect.crossProviderInV1, false);
});

test("no profileSummary contains a concrete model name or bare tier alias (FM4)", () => {
  const forbidden = /claude-(opus|sonnet|haiku|fable)|gpt-5|\bo[34](-mini)?\b|\b(opus|sonnet|haiku|fable)\b/i;
  for (const archetype of ARCHETYPES) {
    assert.ok(
      !forbidden.test(ROLE_REGISTRY[archetype].profileSummary),
      `${archetype}'s profileSummary must not name a concrete model or tier alias`,
    );
  }
});

test("getRole returns the registry entry for every archetype", () => {
  for (const archetype of ARCHETYPES) {
    assert.strictEqual(getRole(archetype), ROLE_REGISTRY[archetype]);
  }
});

test("getRole throws InternalError on an unreachable archetype value", () => {
  assert.throws(() => {
    // Intentionally bypass the type system to exercise the runtime guard.
    getRole("not-a-real-archetype" as unknown as (typeof ARCHETYPES)[number]);
  }, InternalError);
});
