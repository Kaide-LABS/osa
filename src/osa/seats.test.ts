// Seat planning. This file names no concrete model (boundary rule B7): models come from the adapters' own alias list or from a synthetic classifier.

import assert from "node:assert/strict";
import { test } from "node:test";
import { knownModels } from "../adapters/model-classes.ts";
import { UsageError } from "../domain/errors.ts";
import type { ModelClass, ModelClassifier, Seat } from "../domain/independence.ts";
import { OsaConfig } from "../domain/osa-config.ts";
import type { ProviderId } from "../domain/run.ts";
import { AUTO_PROVIDERS, PROVIDER_PREFERENCE, applySeatPlan, healthyProviders, liveProbe, modelFor, planSeats, probeProviders } from "./seats.ts";

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

test("probeProviders: only providers that answer a test call stay; a probe that throws counts as 'did not answer'; all are asked in parallel", async () => {
  const asked: string[] = [];
  const r = await probeProviders(["claude-code", "codex-cli", "opencode-cli"], async (p) => {
    asked.push(p);
    if (p === "codex-cli") return "codex-cli: the model is not available to this account";
    if (p === "opencode-cli") throw new Error("boom");
    return null;
  });
  assert.deepEqual(r.live, ["claude-code"]);
  assert.deepEqual(r.skipped.map((s) => [s.provider, s.reason]), [["codex-cli", "codex-cli: the model is not available to this account"], ["opencode-cli", "boom"]]);
  assert.deepEqual(asked.sort(), ["claude-code", "codex-cli", "opencode-cli"]);
});

test("liveProbe asks one tiny question with no tools and no web, and reports the plain failure message; the model override is honoured", async () => {
  const seen: { provider: string; model: string | null; web: boolean; purpose: string }[] = [];
  const call = ((provider: ProviderId, req: { modelOverride: string | null; webSearch: boolean; prompt: string }, purpose: string) => {
    seen.push({ provider, model: req.modelOverride, web: req.webSearch, purpose });
    return Promise.resolve(provider === "codex-cli" ? { provider, outcome: { ok: false, text: null, failure: new Error("codex-cli: stopped with an error") }, durationMs: 1 } : { provider, outcome: { ok: true, text: "OK", failure: null }, durationMs: 1 });
  }) as never;
  const probe = liveProbe({ cwd: "/r", textCall: call, modelOverrides: { "claude-code": "m-1" } });
  assert.equal(await probe("claude-code"), null);
  assert.equal(await probe("codex-cli"), "codex-cli: stopped with an error");
  assert.deepEqual(seen, [
    { provider: "claude-code", model: "m-1", web: false, purpose: "provider-probe" },
    { provider: "codex-cli", model: null, web: false, purpose: "provider-probe" },
  ]);
});

test("a provider that failed its test call is left out and the notes say so and how to fix it; if none answers the error carries every reason", () => {
  const skipped = [{ provider: "codex-cli" as const, reason: "codex-cli: The AI provider stopped with an error (it exited with code 1)." }];
  const plan = planSeats({ config: cfg(), pairSet: false, healthy: ["claude-code"], skipped });
  assert.deepEqual(plan.pair, ["claude-code", "claude-code"]);
  assert.match(plan.notes.join(" "), /codex-cli is installed and signed in but did not answer a test call.*left out.*providers\.modelOverrides/);
  assert.throws(
    () => planSeats({ config: cfg(), pairSet: false, healthy: [], skipped }),
    (e: unknown) => e instanceof UsageError && /No AI provider answered a test call \(codex-cli: The AI provider stopped/.test(e.message) && /providers\.modelOverrides/.test(e.message),
  );
  const named = planSeats({ config: cfg({ pair: ["codex-cli", "claude-code"] }), pairSet: true, healthy: [], skipped });
  assert.deepEqual(named.pair, ["codex-cli", "claude-code"], "a pair the person wrote is never second-guessed by a probe");
});

test("automatic choice sticks to providers OSA has run builds on (Claude Code, Codex); the others are named in providers.pair, or used when nothing else is usable", () => {
  const withOthers = planSeats({ config: cfg(), pairSet: false, healthy: ["claude-code", "opencode-cli", "antigravity-cli"] });
  assert.deepEqual(withOthers.pair, ["claude-code", "claude-code"], "Claude Code alone, on two models, beats an unproven second provider");
  assert.equal(withOthers.review.level, "different-class");
  assert.match(withOthers.notes.join(" "), /opencode-cli and antigravity-cli also answered, but OSA only chooses providers it has run builds on.*providers\.pair/);
  assert.match(withOthers.notes.join(" "), /Only claude-code is among the providers OSA chooses on its own/);
  assert.deepEqual(AUTO_PROVIDERS, ["claude-code", "codex-cli"]);
  // nothing proven is usable: the others are chosen after all
  const onlyOthers = planSeats({ config: cfg(), pairSet: false, healthy: ["opencode-cli", "antigravity-cli"] });
  assert.deepEqual([...onlyOthers.pair].sort(), ["antigravity-cli", "opencode-cli"]);
  assert.doesNotMatch(onlyOthers.notes.join(" "), /also answered/);
  // a pair the person wrote is used whatever it contains
  assert.deepEqual(planSeats({ config: cfg({ pair: ["claude-code", "opencode-cli"] }), pairSet: true, healthy: [] }).pair, ["claude-code", "opencode-cli"]);
});
