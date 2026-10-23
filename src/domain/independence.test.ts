// The independence ladder, with a synthetic classifier: this file knows no real model names (boundary rule B7).

import assert from "node:assert/strict";
import { test } from "node:test";
import { INDEPENDENCE_LEVELS, bandRank, chooseReviewerSeat, describeIndependence, independenceOf, independenceRank } from "./independence.ts";
import type { ModelClass, ModelClassifier, Seat } from "./independence.ts";

// "<family>-<band>" model names; null model -> the provider's default (family guessed from the provider; band unknown).
const classify: ModelClassifier = (s: Seat): ModelClass => {
  if (s.model === null) return s.provider === "antigravity-cli" ? { family: "unknown", band: "unknown" } : { family: s.provider === "claude-code" ? "alpha" : "beta", band: "unknown" };
  const [family, band] = s.model.toLowerCase().split("-");
  const known = family === "alpha" || family === "beta" || family === "gamma";
  return known ? { family, band: (band as ModelClass["band"] | undefined) ?? "unknown" } : { family: "unknown", band: "unknown" };
};
const seat = (provider: Seat["provider"], model: string | null): Seat => ({ provider, model });

test("the ladder runs from the most independent check to the least, and every level has a rank", () => {
  assert.deepEqual([...INDEPENDENCE_LEVELS], ["different-family", "different-class", "different-provider", "different-model", "unverified", "same-model"]);
  const ranks = INDEPENDENCE_LEVELS.map(independenceRank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a));
  assert.equal(new Set(ranks).size, ranks.length);
  assert.ok(bandRank("high") > bandRank("mid") && bandRank("mid") > bandRank("low") && bandRank("low") > bandRank("unknown"));
});

test("independenceOf: family beats class beats model; a vendor's tool is not the unit, the model is", () => {
  assert.equal(independenceOf(seat("claude-code", "alpha-mid"), seat("codex-cli", "beta-mid"), classify), "different-family");
  assert.equal(independenceOf(seat("claude-code", "alpha-mid"), seat("claude-code", "beta-mid"), classify), "different-family", "same tool, different family");
  assert.equal(independenceOf(seat("claude-code", "alpha-mid"), seat("claude-code", "alpha-high"), classify), "different-class");
  assert.equal(independenceOf(seat("claude-code", "alpha-mid"), seat("codex-cli", "alpha-high"), classify), "different-class", "same family reached through another tool");
  assert.equal(independenceOf(seat("claude-code", "alpha-mid-v1"), seat("claude-code", "alpha-mid-v2"), classify), "different-model");
  assert.equal(independenceOf(seat("claude-code", "alpha-mid"), seat("claude-code", "alpha-mid"), classify), "same-model");
  assert.equal(independenceOf(seat("claude-code", "ALPHA-mid"), seat("codex-cli", "alpha-mid"), classify), "same-model", "same model through a different tool shares the bias");
});

test("independenceOf: a seat on the CLI's default model is 'unverified' against an explicit model of the same provider, 'same-model' against itself", () => {
  assert.equal(independenceOf(seat("claude-code", null), seat("claude-code", "alpha-high"), classify), "unverified");
  assert.equal(independenceOf(seat("claude-code", "alpha-high"), seat("claude-code", null), classify), "unverified", "symmetric");
  assert.equal(independenceOf(seat("claude-code", null), seat("claude-code", null), classify), "same-model");
  assert.equal(independenceOf(seat("claude-code", null), seat("codex-cli", null), classify), "different-family");
});

test("independenceOf: when a family cannot be recognised, differing providers still count as 'different-provider'", () => {
  assert.equal(independenceOf(seat("claude-code", "alpha-mid"), seat("antigravity-cli", null), classify), "different-provider");
  assert.equal(independenceOf(seat("antigravity-cli", null), seat("antigravity-cli", null), classify), "same-model");
  assert.equal(independenceOf(seat("antigravity-cli", "zzz"), seat("antigravity-cli", "yyy"), classify), "different-model");
});

test("chooseReviewerSeat: picks the most independent candidate, prefers the more capable on a tie, and never returns a refusal", () => {
  const author = seat("claude-code", "alpha-mid");
  const pick = chooseReviewerSeat(author, [seat("claude-code", "alpha-low"), seat("claude-code", "alpha-high"), seat("claude-code", "alpha-mid")], classify);
  assert.deepEqual(pick, { seat: seat("claude-code", "alpha-high"), level: "different-class" }, "high beats low on the same level");
  const cross = chooseReviewerSeat(author, [seat("claude-code", "alpha-high"), seat("codex-cli", "beta-low")], classify);
  assert.equal(cross?.level, "different-family", "a different family outranks a more capable same-family model");
  // only the author's own seat exists: the answer is the weakest level, not an error
  assert.deepEqual(chooseReviewerSeat(author, [author], classify), { seat: author, level: "same-model" });
  assert.equal(chooseReviewerSeat(author, [], classify), null);
  // earlier candidate wins a full tie
  const tie = chooseReviewerSeat(author, [seat("codex-cli", "beta-mid"), seat("antigravity-cli", "gamma-mid")], classify);
  assert.equal(tie?.seat.provider, "codex-cli");
});

test("describeIndependence: plain language for every level, naming both seats; the weak levels say what would improve the check", () => {
  const a = seat("claude-code", "alpha-mid");
  const r = seat("claude-code", null);
  for (const level of INDEPENDENCE_LEVELS) {
    const text = describeIndependence(level, a, r);
    assert.match(text, /claude-code \(alpha-mid\)/);
    assert.match(text, /^claude-code reviewed work written by/);
    assert.doesNotMatch(text, /refus|must not|forbidden/i);
  }
  assert.match(describeIndependence("same-model", a, a), /second model, ideally from another family/);
  assert.match(describeIndependence("unverified", a, r), /Name a model for each seat/);
});
