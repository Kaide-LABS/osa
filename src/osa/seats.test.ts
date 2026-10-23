// Seat planning. This file names no concrete model (boundary rule B7): models come from the adapters' own alias list or from a synthetic classifier.

import assert from "node:assert/strict";
import { test } from "node:test";
import { knownModels } from "../adapters/model-classes.ts";
import { UsageError } from "../domain/errors.ts";
import type { ModelClass, ModelClassifier, Seat } from "../domain/independence.ts";
import { OsaConfig } from "../domain/osa-config.ts";
import type { ProviderId } from "../domain/run.ts";
import { PROVIDER_PREFERENCE, applySeatPlan, healthyProviders, modelFor, planSeats } from "./seats.ts";

const [TOP, MID] = knownModels("claude-code"); // the strongest and the mid-size alias the Claude Code adapter knows
const cfg = (providers: object = {}): OsaConfig => OsaConfig.parse({ providers });

test("ONE provider is enough: both seats go to it and the review is separated by model class (mid-size writes, the strongest reviews)", () => {
  const plan = planSeats({ config: cfg(), pairSet: false, healthy: ["claude-code"] });
  assert.deepEqual(plan.pair, ["claude-code", "claude-code"]);
  assert.equal(plan.seatModels[1], MID, "seat 1 writes the second executor turn");
  assert.equal(plan.seatModels[0], TOP, "seat 0 reviews it, on the stronger model");
  assert.equal(plan.review.level, "different-class");
  assert.equal(plan.auto, true);
  assert.match(plan.notes.join(" "), /Only claude-code is installed and signed in/);
  assert.doesNotMatch(plan.notes.join(" "), /second provider/, "a different-class review needs no apology");
});

test("one provider whose models OSA cannot list: still runs, says the review is weak, and says how to improve it", () => {
  const plan = planSeats({ config: cfg(), pairSet: false, healthy: ["codex-cli"] });
  assert.deepEqual(plan.pair, ["codex-cli", "codex-cli"]);
  assert.deepEqual(plan.seatModels, [null, null]);
  assert.equal(plan.review.level, "same-model");
  assert.match(plan.notes.join(" "), /install a second provider/);
  assert.match(plan.notes.join(" "), /providers\.models\.codex-cli/);
});

test("models named in the config are used (providers.models), classified by the supplied classifier", () => {
  const classify: ModelClassifier = (s: Seat): ModelClass => {
    const [family, band] = (s.model ?? "").split("-");
    return family === "zed" ? { family, band: band as ModelClass["band"] } : { family: "unknown", band: "unknown" };
  };
  const plan = planSeats({ config: cfg({ models: { "codex-cli": ["zed-low", "zed-mid", "zed-high"] } }), pairSet: false, healthy: ["codex-cli"], classify });
  assert.deepEqual(plan.seatModels, ["zed-high", "zed-mid"]);
  assert.equal(plan.review.level, "different-class");
});

test("two usable providers: the pair is the most independent one (different model families), in preference order", () => {
  // `healthy` arrives in preference order (healthyProviders sorts it), so among equally independent pairs the verified-first providers win
  const plan = planSeats({ config: cfg(), pairSet: false, healthy: ["claude-code", "codex-cli", "antigravity-cli"] });
  assert.deepEqual(plan.pair, ["claude-code", "codex-cli"]);
  assert.equal(plan.review.level, "different-family");
  assert.match(plan.notes.join(" "), /OSA chose/);
  // a router whose models are not recognised ranks below a pair of known, different families
  const router = planSeats({ config: cfg(), pairSet: false, healthy: ["opencode-cli", "codex-cli", "claude-code"].sort((a, b) => PROVIDER_PREFERENCE.indexOf(a as ProviderId) - PROVIDER_PREFERENCE.indexOf(b as ProviderId)) as ProviderId[] });
  assert.deepEqual(router.pair, ["claude-code", "codex-cli"]);
});

test("no usable provider is the only thing that stops seat planning, with a message that says what to install", () => {
  assert.throws(() => planSeats({ config: cfg(), pairSet: false, healthy: [] }), (e: unknown) => e instanceof UsageError && /install and sign in to at least one/.test(e.message));
});

test("a pair written in the config is honoured and NEVER refused: the same provider twice, even the same model twice", () => {
  const same = planSeats({ config: cfg({ pair: ["claude-code", "claude-code"] }), pairSet: true, healthy: [] });
  assert.deepEqual(same.pair, ["claude-code", "claude-code"]);
  assert.equal(same.seatModels[0], TOP, "independence auto: the open models are chosen for a different class");
  assert.equal(same.seatModels[1], MID);
  const off = planSeats({ config: cfg({ pair: ["claude-code", "claude-code"], independence: "off" }), pairSet: true, healthy: [] });
  assert.deepEqual(off.seatModels, [null, null], "independence off: exactly as written");
  assert.equal(off.review.level, "same-model");
  const pinned = planSeats({ config: cfg({ pair: ["claude-code", "claude-code"], seatModels: [MID as string, MID as string] }), pairSet: true, healthy: [] });
  assert.deepEqual(pinned.seatModels, [MID, MID], "the person's own models are never overridden");
  assert.equal(pinned.review.level, "same-model");
  assert.match(pinned.notes.join(" "), /the same model\. This works/);
  const half = planSeats({ config: cfg({ pair: ["claude-code", "claude-code"], seatModels: [null, TOP as string] }), pairSet: true, healthy: [] });
  assert.equal(half.seatModels[1], TOP);
  assert.notEqual(half.seatModels[0], TOP, "the open seat is filled with a different model");
});

test("two different providers written in the config are used as written (providers differ, so the default models are fine)", () => {
  const plan = planSeats({ config: cfg({ pair: ["codex-cli", "claude-code"] }), pairSet: true, healthy: [] });
  assert.deepEqual(plan.pair, ["codex-cli", "claude-code"]);
  assert.deepEqual(plan.seatModels, [null, null]);
  assert.equal(plan.review.level, "different-family");
  assert.equal(plan.auto, false);
});

test("candidates: every usable provider on each of its models, the two seats first, no duplicates", () => {
  const plan = planSeats({ config: cfg(), pairSet: false, healthy: ["claude-code", "codex-cli"] });
  const keys = plan.candidates.map((s) => `${s.provider}|${s.model ?? ""}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(plan.candidates.some((s) => s.provider === "claude-code" && s.model === TOP));
  assert.ok(plan.candidates.some((s) => s.provider === "codex-cli" && s.model === null));
});

test("applySeatPlan writes the seats into the config; modelFor gives each provider the model of the seat it holds", () => {
  const config = applySeatPlan(cfg({ modelOverrides: { "codex-cli": "override-model" } }), planSeats({ config: cfg(), pairSet: false, healthy: ["claude-code"] }));
  assert.deepEqual(config.providers.pair, ["claude-code", "claude-code"]);
  assert.equal(modelFor(config, "claude-code"), TOP, "the planner seat by default");
  assert.equal(modelFor(config, "claude-code", 1), MID);
  assert.equal(modelFor(config, "codex-cli"), "override-model", "a provider in no seat: the per-provider override");
  assert.equal(modelFor(config, "opencode-cli"), null);
});

test("healthyProviders: the usable ones, in the verified-first order, whatever order they were probed in", () => {
  const rep = (provider: ProviderId, ok: boolean) => ({ provider, cliFound: true, version: "1", versionInRange: true, authenticated: ok, authState: ok ? ("authenticated" as const) : ("unauthenticated" as const), problems: ok ? [] : ["x"] });
  const order = healthyProviders({ providers: [rep("antigravity-cli", true), rep("codex-cli", false), rep("opencode-cli", true), rep("claude-code", true)] });
  assert.deepEqual(order, ["claude-code", "opencode-cli", "antigravity-cli"]);
  assert.deepEqual([...PROVIDER_PREFERENCE].sort(), [...new Set(PROVIDER_PREFERENCE)].sort());
});
