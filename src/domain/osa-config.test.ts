import { test } from "node:test";
import assert from "node:assert/strict";
import { OsaConfig, defaultOsaConfig } from "./osa-config.ts";

test("OsaConfig: {} is valid and every directive default is applied", () => {
  const c = defaultOsaConfig();
  assert.equal(c.intake.autoLockWhenNoRisky, true);
  assert.equal(c.research.enabled, true);
  assert.equal(c.research.docsRequired, true);
  assert.equal(c.research.academic, true);
  assert.equal(c.research.openalexMailto, "");
  assert.equal(c.research.semanticScholar, false);
  assert.equal(c.research.githubLookup, true);
  assert.equal(c.research.crossProviderCheck, true);
  assert.equal(c.trim.enabled, false, "trim-1 is a plug-in that is OFF by default (WS10): it saved 0.3-2.8 % of a run in the test-hardening measurements");
  assert.equal(c.index.engine, "lexical", "the CBM code index is OFF by default (WS10)");
  assert.equal(c.intake.quoteStatedRules, false, "quoting the stated rules into the criteria is OFF by default (WS10)");
  assert.equal(c.trim.engine, "trim1");
  assert.equal(c.agents.implication, true);
  assert.equal(c.agents.lateralArchitecture, true);
  assert.equal(c.agents.lateralArchitectureProvider, "codex-cli");
  assert.equal(c.agents.application, true);
  assert.equal(c.index.enabled, true);
  assert.equal(c.memory.enabled, true);
});

test("OsaConfig: short provider aliases (codex, claude, antigravity) normalise to canonical ids", () => {
  const c = OsaConfig.parse({ agents: { lateralArchitectureProvider: "codex" }, providers: { pair: ["claude", "antigravity"] } });
  assert.equal(c.agents.lateralArchitectureProvider, "codex-cli");
  assert.deepEqual(c.providers.pair, ["claude-code", "antigravity-cli"]);
});

test("OsaConfig: an unknown key is a loud error, not silently ignored", () => {
  assert.equal(OsaConfig.safeParse({ research: { academik: true } }).success, false);
  assert.equal(OsaConfig.safeParse({ nonsense: 1 }).success, false);
});

test("OsaConfig: providers.pair must be two different providers", () => {
  assert.equal(OsaConfig.safeParse({ providers: { pair: ["codex", "codex-cli"] } }).success, false);
});
