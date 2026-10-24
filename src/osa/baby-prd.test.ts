import { test } from "node:test";
import assert from "node:assert/strict";
import { IntakeError } from "../domain/errors.ts";
import { applyRiskBackstop, parseBabyPrd, renderBabyPrd } from "./baby-prd.ts";
import { samplePrd } from "./fixtures.test.ts";

test("renderBabyPrd follows the directive's section order, risky assumptions first", () => {
  const md = renderBabyPrd({ ...samplePrd({ risky: true }), assumptions: [{ text: "safe one", risk: "safe" }, { text: "risky one", risk: "risky" }] });
  const order = ["## TL;DR", "## Baby PRD", "### Problem", "### Users / who it's for", "### In scope", "### Out of scope", "### Acceptance criteria", "### Constraints", "### Research plan", "## Assumptions"].map((h) => md.indexOf(h));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > (order[i - 1] as number))), `sections out of order: ${order.join(",")}`);
  assert.ok(md.indexOf("[risky] risky one") < md.indexOf("[safe] safe one"));
  assert.match(md, /^1\. Running the tool on a file with 5 words prints 5\.$/m, "acceptance criteria are numbered");
});

test("parseBabyPrd(renderBabyPrd(x)) round-trips", () => {
  const prd = samplePrd({ risky: true });
  const back = parseBabyPrd(renderBabyPrd(prd));
  // Assumption order changes (risky listed first) -- compare as sets, everything else exactly.
  assert.deepEqual({ ...back, assumptions: [] }, { ...prd, assumptions: [] });
  assert.deepEqual(
    [...back.assumptions].sort((a, b) => a.text.localeCompare(b.text)),
    [...prd.assumptions].sort((a, b) => a.text.localeCompare(b.text)),
  );
});

test("parseBabyPrd round-trips empty lists via the (none) marker", () => {
  const base = samplePrd();
  const prd = {
    ...base,
    outOfScope: [],
    constraints: [],
    assumptions: [],
    researchPlan: { ...base.researchPlan, academicQueries: [], priorArtQueries: [], docsTargets: [] },
  };
  assert.deepEqual(parseBabyPrd(renderBabyPrd(prd)), prd);
});

test("parseBabyPrd reports a hand-edit that breaks the structure in plain language (IntakeError)", () => {
  const md = renderBabyPrd(samplePrd()).replace("- [safe] Words are separated by whitespace.", "- Words are separated by whitespace.");
  assert.throws(() => parseBabyPrd(md), (e: unknown) => e instanceof IntakeError && /\[risky\], \[safe\] or \[defaulted\]/.test(e.message));
  assert.throws(() => parseBabyPrd("# nothing here"), IntakeError);
});

test("parseBabyPrd accepts a hand edit that changes content (what Edit at the lock is for)", () => {
  const md = renderBabyPrd(samplePrd()).replace("Print a total", "Print a total and a per-file breakdown");
  assert.ok(parseBabyPrd(md).inScope.includes("Print a total and a per-file breakdown"));
});

test("applyRiskBackstop upgrades security/money/destructive/architecture 'safe' tags and never downgrades", () => {
  const prd = {
    ...samplePrd(),
    assumptions: [
      { text: "Output is printed to stdout.", risk: "safe" as const },
      { text: "Users sign in with a password.", risk: "safe" as const },
      { text: "We may delete old files after a run.", risk: "safe" as const },
      { text: "A paid third-party API is used for lookups.", risk: "safe" as const },
      { text: "Uses plain text for config.", risk: "risky" as const },
    ],
  };
  const { prd: out, upgraded } = applyRiskBackstop(prd);
  assert.deepEqual(out.assumptions.map((a) => a.risk), ["safe", "risky", "risky", "risky", "risky"]);
  assert.equal(upgraded.length, 3);
});

test("the person's request is carried verbatim in the PRD and round-trips (multi-line, blank lines, quote marks, markdown-looking text), authoritative over the summary (found by the live e2e run)", () => {
  const request = [
    "Build wordstat. A word is a maximal run of ASCII letters a-z and A-Z plus the apostrophe;",
    "",
    "> everything else (digits, other Unicode) separates words.",
    "## not a heading, just text",
    "- not a list item either",
  ].join("\n");
  const prd = { ...samplePrd(), request };
  const md = renderBabyPrd(prd);
  assert.match(md, /^## Original request \(authoritative\)$/m);
  assert.match(md, /this request wins/);
  assert.ok(md.indexOf("## Assumptions") < md.indexOf("## Original request"), "the request is the last section");
  assert.equal(parseBabyPrd(md).request, request, "byte-for-byte, including the blank line and the quoted line");
  assert.equal(parseBabyPrd(renderBabyPrd(samplePrd())).request, undefined, "a PRD without one still round-trips");
  assert.ok(!renderBabyPrd(samplePrd()).includes("Original request"));
});

test("an edit at the lock to the request section is what gets read back", () => {
  const md = renderBabyPrd({ ...samplePrd(), request: "old words" }).replace("> old words", "> new words, edited by the person");
  assert.equal(parseBabyPrd(md).request, "new words, edited by the person");
});

test("renderBabyPrd includes scope and recommended questions sections", () => {
  const prd = samplePrd({ broad: true });
  const md = renderBabyPrd(prd);
  assert.match(md, /^## Scope$/m, "scope section exists");
  assert.match(md, /^broad$/m, "scope value is rendered");
  assert.match(md, /^## Recommended questions$/m, "recommended questions section exists");
  assert.ok(md.includes("Should it count words, characters, or lines?"));
  assert.ok(md.includes("| words"), "question and default are pipe-separated");
});

test("parseBabyPrd round-trips scope and recommended questions", () => {
  const prd = samplePrd({ broad: true });
  const back = parseBabyPrd(renderBabyPrd(prd));
  assert.equal(back.scope, "broad");
  assert.deepEqual(back.recommendedQuestions, prd.recommendedQuestions);
});

test("parseBabyPrd round-trips empty recommended questions via (none) marker", () => {
  const prd = samplePrd({ broad: false });
  const md = renderBabyPrd(prd);
  assert.match(md, /## Recommended questions[\s\S]*- \(none\)/);
  assert.deepEqual(parseBabyPrd(md).recommendedQuestions, []);
});

test("renderBabyPrd lists assumptions in order: risky, then defaulted, then safe", () => {
  const prd = {
    ...samplePrd(),
    assumptions: [
      { text: "safe one", risk: "safe" as const },
      { text: "risky one", risk: "risky" as const },
      { text: "defaulted one", risk: "defaulted" as const },
    ],
  };
  const md = renderBabyPrd(prd);
  const riskIdx = md.indexOf("[risky] risky one");
  const defaultedIdx = md.indexOf("[defaulted] defaulted one");
  const safeIdx = md.indexOf("[safe] safe one");
  assert.ok(riskIdx < defaultedIdx && defaultedIdx < safeIdx, "order is risky, defaulted, safe");
});

test("parseBabyPrd accepts [defaulted] assumption prefix (case-insensitive)", () => {
  const base = renderBabyPrd(samplePrd({ broad: true }));
  const md = base.replace("## Assumptions", "## Assumptions\n- [DEFAULTED] A default assumption");
  const prd = parseBabyPrd(md);
  assert.ok(prd.assumptions.some((a) => a.risk === "defaulted" && a.text === "A default assumption"));
});

test("parseBabyPrd rejects recommended question with no pipe separator", () => {
  const base = renderBabyPrd(samplePrd());
  const bad = base.replace("Should it count words", "Should it count words");
  // Insert a bad recommended question
  const withBad = bad.replace("## Recommended questions\n- (none)", "## Recommended questions\n- no pipe here");
  assert.throws(() => parseBabyPrd(withBad), (e: unknown) => e instanceof IntakeError && /format "question | default"/.test(e.message));
});

test("applyRiskBackstop never upgrades defaulted assumptions to risky, even if they contain risk signals", () => {
  const prd = {
    ...samplePrd(),
    assumptions: [
      { text: "Users log in with a password.", risk: "defaulted" as const },
      { text: "We store API keys securely.", risk: "defaulted" as const },
    ],
  };
  const { prd: out } = applyRiskBackstop(prd);
  assert.ok(out.assumptions.every((a) => a.risk !== "risky"), "no defaulted assumptions upgraded to risky");
  assert.deepEqual(
    out.assumptions,
    prd.assumptions,
    "defaulted assumptions unchanged",
  );
});
