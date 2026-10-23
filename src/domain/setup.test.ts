// Implements PHASE_9_SPEC.md §1.5
// Covers the closed enumerations and schemas in src/domain/setup.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPTIONAL_SERVER_STATES,
  OptionalServerStateSchema,
  ServerSetupResult,
  SETUP_LAUNCHER_KINDS,
  SETUP_OUTCOMES,
  SETUP_SERVER_IDS,
  SetupLauncherKindSchema,
  SetupOutcomeSchema,
  SetupServerIdSchema,
} from "./setup.ts";

test("SETUP_SERVER_IDS is exactly OSA's own server (the optional research servers were removed)", () => {
  assert.deepStrictEqual(SETUP_SERVER_IDS, ["osa"]);
  for (const id of SETUP_SERVER_IDS) {
    assert.equal(SetupServerIdSchema.safeParse(id).success, true);
  }
  assert.equal(SetupServerIdSchema.safeParse("arxiv-mcp").success, false);
});

test("SETUP_LAUNCHER_KINDS and SETUP_OUTCOMES are exactly the specified closed sets", () => {
  assert.deepStrictEqual(SETUP_LAUNCHER_KINDS, ["node"]);
  assert.deepStrictEqual(SETUP_OUTCOMES, [
    "registered",
    "registered-unverified",
    "already-registered",
    "failed",
    "skipped-launcher-unavailable",
    "skipped-no-agent-cli",
    "indeterminate",
  ]);
  for (const k of SETUP_LAUNCHER_KINDS) {
    assert.equal(SetupLauncherKindSchema.safeParse(k).success, true);
  }
  for (const o of SETUP_OUTCOMES) {
    assert.equal(SetupOutcomeSchema.safeParse(o).success, true);
  }
});

test("OPTIONAL_SERVER_STATES is exactly the three-state precedent", () => {
  assert.deepStrictEqual(OPTIONAL_SERVER_STATES, ["present", "absent", "indeterminate"]);
  for (const s of OPTIONAL_SERVER_STATES) {
    assert.equal(OptionalServerStateSchema.safeParse(s).success, true);
  }
});

test("ServerSetupResult accepts a well-formed object and rejects an unknown key (strict, extra=forbid)", () => {
  const valid = {
    id: "osa",
    required: true,
    outcome: "registered",
    launcher: "node",
    command: "node",
    args: ["/abs/main.js", "mcp"],
    detail: "registered and confirmed present",
    remediation: null,
  };
  const result = ServerSetupResult.safeParse(valid);
  assert.equal(result.success, true);

  const withExtra = { ...valid, extraField: "should not be allowed" };
  assert.equal(ServerSetupResult.safeParse(withExtra).success, false);
});

test("ServerSetupResult rejects an invalid outcome enum value", () => {
  const invalid = {
    id: "osa",
    required: true,
    outcome: "working", // not a member of SETUP_OUTCOMES
    launcher: "node",
    command: "node",
    args: [],
    detail: "x",
    remediation: null,
  };
  assert.equal(ServerSetupResult.safeParse(invalid).success, false);
});
