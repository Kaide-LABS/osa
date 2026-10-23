// Implements PHASE_2_SPEC.md §1.1 -- registry.test.ts
// Registry identity/completeness tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_IDS } from "../domain/run.ts";
import { ADAPTER_REGISTRY } from "./registry.ts";

test("ADAPTER_REGISTRY has exactly one entry per PROVIDER_IDS member", () => {
  assert.deepStrictEqual(Object.keys(ADAPTER_REGISTRY).sort(), [...PROVIDER_IDS].sort());
});

test("each ADAPTER_REGISTRY entry's own id matches the key it is stored under (§8 check #10)", () => {
  assert.equal(ADAPTER_REGISTRY["claude-code"].id, "claude-code");
  assert.equal(ADAPTER_REGISTRY["codex-cli"].id, "codex-cli");
  for (const id of PROVIDER_IDS) {
    assert.strictEqual(ADAPTER_REGISTRY[id].id, id);
  }
});

test("ADAPTER_REGISTRY is frozen", () => {
  assert.ok(Object.isFrozen(ADAPTER_REGISTRY));
});
