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
  assert.equal(c.agents.lateralArchitectureProvider, undefined);
  assert.equal(c.agents.application, true);
  assert.equal(c.index.enabled, true);
  assert.equal(c.memory.enabled, true);
  assert.equal(c.memory.global.capture, true, "global memory capture is ON by default (memory phase 2)");
});

test("OsaConfig: memory.global.capture can be turned off and stays strict-parse", () => {
  assert.equal(OsaConfig.parse({ memory: { global: { capture: false } } }).memory.global.capture, false);
  assert.equal(OsaConfig.parse({ memory: {} }).memory.global.capture, true, "an absent global block defaults capture on");
  assert.equal(OsaConfig.safeParse({ memory: { global: { capture: true, bogus: 1 } } }).success, false, "an unknown key under memory.global is a loud error");
});

test("OsaConfig: memory.global.reuse defaults on with a 30-day window and parses strictly (memory phase 3)", () => {
  const d = defaultOsaConfig().memory.global.reuse;
  assert.deepEqual({ enabled: d.enabled, maxAgeDays: d.maxAgeDays }, { enabled: true, maxAgeDays: 30 });
  assert.equal(OsaConfig.parse({ memory: { global: { reuse: { enabled: false } } } }).memory.global.reuse.enabled, false);
  assert.equal(OsaConfig.parse({ memory: { global: { reuse: { maxAgeDays: 7 } } } }).memory.global.reuse.maxAgeDays, 7);
  assert.equal(OsaConfig.safeParse({ memory: { global: { reuse: { maxAgeDays: 0 } } } }).success, false, "maxAgeDays below 1 is refused");
  assert.equal(OsaConfig.safeParse({ memory: { global: { reuse: { maxAgeDays: 366 } } } }).success, false, "maxAgeDays above 365 is refused");
  assert.equal(OsaConfig.safeParse({ memory: { global: { reuse: { bogus: 1 } } } }).success, false, "an unknown key under reuse is a loud error");
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

test("OsaConfig: providers.pair may name one provider twice (two seats on different models); the seat and independence keys validate", () => {
  const same = OsaConfig.parse({ providers: { pair: ["codex", "codex-cli"], seatModels: ["m1", "m2"], models: { "codex-cli": ["m1", "m2"] } } });
  assert.deepEqual(same.providers.pair, ["codex-cli", "codex-cli"]);
  assert.deepEqual(same.providers.seatModels, ["m1", "m2"]);
  assert.equal(same.providers.independence, "auto");
  assert.deepEqual(OsaConfig.parse({}).providers.seatModels, [null, null]);
  assert.equal(OsaConfig.safeParse({ providers: { independence: "strict" } }).success, false, "only auto and off exist; there is no mode that refuses");
  assert.equal(OsaConfig.safeParse({ providers: { seatModels: ["x"] } }).success, false);
  assert.equal(OsaConfig.safeParse({ providers: { models: { "claude-code": [] } } }).success, false);
});
