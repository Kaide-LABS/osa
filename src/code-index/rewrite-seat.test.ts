// Names no concrete model (boundary rule B7): models come from the adapters' own alias list.

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyModel, knownModels } from "../adapters/model-classes.ts";
import { OsaConfig } from "../domain/osa-config.ts";
import { cheapestModel, rewriteSeatFor } from "./rewrite-seat.ts";

test("the query rewrite is on by default, only matters for the CBM engine, and CBM no longer abstains by default", () => {
  const c = OsaConfig.parse({});
  assert.equal(c.index.engine, "lexical", "the engine itself is still opt-in (it needs the CBM binary)");
  assert.deepEqual(c.index.rewrite, { enabled: true, timeoutMs: 60_000 });
  assert.equal(c.index.cbm.abstain, false);
  assert.equal(OsaConfig.parse({ index: { rewrite: { enabled: false } } }).index.rewrite.enabled, false);
  assert.throws(() => OsaConfig.parse({ index: { rewrite: { timeoutMs: 5 } } }));
  assert.throws(() => OsaConfig.parse({ index: { rewrite: { surprise: true } } }), "a typo'd key is an error");
});

test("cheapestModel: the lowest KNOWN capability band; an unrecognised model is never chosen; nothing known = null", () => {
  const picked = cheapestModel("claude-code", undefined);
  assert.ok(picked !== null && knownModels("claude-code").includes(picked));
  assert.equal(classifyModel({ provider: "claude-code", model: picked }).band, "low", "the cheapest of the provider's own aliases is its small model");
  assert.equal(cheapestModel("codex-cli", undefined), null, "Codex lists no stable aliases");
  assert.equal(cheapestModel("opencode-cli", ["mystery-model-9", "another-unknown"]), null);
  assert.equal(cheapestModel("opencode-cli", ["gpt-6-luna", "claude-opus-4-8", "claude-haiku-5-5"]), "claude-haiku-5-5", "from a configured list, by band");
});

test("rewriteSeatFor: null when switched off; otherwise the first seat's provider on its cheapest model; configured provider and model win", () => {
  const off = OsaConfig.parse({ index: { rewrite: { enabled: false } } });
  assert.equal(rewriteSeatFor(off), null);
  const claude = OsaConfig.parse({ providers: { pair: ["claude-code", "codex-cli"] } });
  const seat = rewriteSeatFor(claude);
  assert.equal(seat?.provider, "claude-code");
  assert.equal(classifyModel({ provider: "claude-code", model: seat?.model ?? null }).band, "low");
  assert.equal(seat?.timeoutMs, 60_000);
  const codex = OsaConfig.parse({ providers: { pair: ["codex-cli", "claude-code"], modelOverrides: { "codex-cli": "operator-model" } } });
  assert.deepEqual(rewriteSeatFor(codex), { provider: "codex-cli", model: "operator-model", timeoutMs: 60_000 }, "no known cheap model: the operator's override, else the default");
  const named = OsaConfig.parse({ index: { rewrite: { provider: "opencode", model: "x/y", timeoutMs: 5000 } } });
  assert.deepEqual(rewriteSeatFor(named), { provider: "opencode-cli", model: "x/y", timeoutMs: 5000 });
  const plain = OsaConfig.parse({ providers: { pair: ["codex-cli", "claude-code"] } });
  assert.equal(rewriteSeatFor(plain)?.model, null, "nothing known and no override: the provider's own default");
});
