import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseReviewerSeat, independenceOf } from "../domain/independence.ts";
import { classifyModel, classifyModelName, knownModels } from "./model-classes.ts";

test("classifyModelName: family and capability band from the model's own name, wherever it is reached from", () => {
  assert.deepEqual(classifyModelName("claude-opus-4-8"), { family: "claude", band: "high" });
  assert.deepEqual(classifyModelName("anthropic/claude-sonnet-5-5"), { family: "claude", band: "mid" });
  assert.deepEqual(classifyModelName("claude-haiku-5-5"), { family: "claude", band: "low" });
  assert.deepEqual(classifyModelName("claude-fable-5-1"), { family: "claude", band: "high" });
  assert.deepEqual(classifyModelName("opus"), { family: "claude", band: "high" }, "the CLI's short alias");
  assert.deepEqual(classifyModelName("sonnet"), { family: "claude", band: "mid" });
  assert.deepEqual(classifyModelName("gpt-6-luna"), { family: "gpt", band: "mid" });
  assert.deepEqual(classifyModelName("openai/gpt-5.5-mini"), { family: "gpt", band: "low" });
  assert.deepEqual(classifyModelName("gpt-5-pro"), { family: "gpt", band: "high" });
  assert.deepEqual(classifyModelName("o3"), { family: "gpt", band: "high" });
  assert.deepEqual(classifyModelName("google/gemini-3-pro"), { family: "gemini", band: "high" });
  assert.deepEqual(classifyModelName("gemini-3-flash"), { family: "gemini", band: "mid" });
  assert.deepEqual(classifyModelName("opencode/deepseek-v4.1-flash-free"), { family: "deepseek", band: "low" });
  assert.deepEqual(classifyModelName("opencode/nemotron-3.5-lightning-free"), { family: "nemotron", band: "low" });
  assert.deepEqual(classifyModelName("opencode/big-pickle"), { family: "unknown", band: "unknown" }, "an unrecognised name is unknown, never an error");
  assert.deepEqual(classifyModelName("anthropic/claude-opus-5#high"), { family: "claude", band: "high" }, "a #variant suffix is ignored");
});

test("classifyModel: an explicit model is classified by name; a default model only by what the provider is known to serve", () => {
  assert.deepEqual(classifyModel({ provider: "opencode-cli", model: "anthropic/claude-opus-4-8" }), { family: "claude", band: "high" });
  assert.deepEqual(classifyModel({ provider: "claude-code", model: null }), { family: "claude", band: "unknown" });
  assert.deepEqual(classifyModel({ provider: "codex-cli", model: null }), { family: "gpt", band: "unknown" });
  assert.deepEqual(classifyModel({ provider: "opencode-cli", model: null }), { family: "unknown", band: "unknown" }, "a router serves any vendor");
});

test("a person with ONE provider still gets a more independent reviewer: Claude Code alone offers a different capability class", () => {
  const seats = knownModels("claude-code").map((model) => ({ provider: "claude-code" as const, model }));
  assert.ok(seats.length >= 2, "Claude Code's own aliases give more than one model");
  const author = { provider: "claude-code" as const, model: "sonnet" };
  const pick = chooseReviewerSeat(author, seats, classifyModel);
  assert.deepEqual(pick, { seat: { provider: "claude-code", model: "opus" }, level: "different-class" });
  assert.equal(independenceOf(author, { provider: "codex-cli", model: null }, classifyModel), "different-family");
  assert.deepEqual(knownModels("codex-cli"), [], "no stable aliases: its models are named in the config");
});
