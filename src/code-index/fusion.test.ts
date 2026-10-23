import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TUNING, assess, fuse, isSpecQuestion, isTestFile, marginOf, mergeCandidates, signalsFor, wantsTests } from "./fusion.ts";
import type { Candidate } from "./fusion.ts";
import { queryTerms } from "./query-terms.ts";
import type { ProbeResult } from "./grep-probe.ts";

const item = (file: string, s: number, e: number, symbol: string | null = null) => ({ file, startLine: s, endLine: e, symbol });
const probe = (files: string[], coverage = 1): ProbeResult => ({ files: files.map((file, i) => ({ file, distinct: 3 - i, matches: 3, terms: [] })), coverage, termsTried: 3, available: true });

test("mergeCandidates joins overlapping regions of one file across channels, keeps each channel's best rank and the tightest range", () => {
  const c = mergeCandidates([
    { channel: "bm25", items: [item("a.ts", 10, 40, "big"), item("b.ts", 1, 5)] },
    { channel: "code", items: [item("b.ts", 3, 4), item("a.ts", 20, 25, "inner")] },
    { channel: "lexical", items: [item("a.ts", 100, 120)] },
  ]);
  assert.equal(c.length, 3, "a.ts 10-40 + 20-25 merge; a.ts 100-120 and b.ts stay apart");
  const a = c.find((x) => x.file === "a.ts" && x.startLine < 50) as Candidate;
  assert.deepEqual([a.startLine, a.endLine], [20, 25], "tightest range");
  assert.deepEqual([...a.ranks.entries()].sort(), [["bm25", 1], ["code", 2]]);
});

test("fuse: agreement across channels beats a single channel's first place; the grep probe is one more voter", () => {
  const c = mergeCandidates([
    { channel: "bm25", items: [item("wrong.ts", 1, 9), item("right.ts", 1, 9)] },
    { channel: "semantic", items: [item("right.ts", 1, 9)] },
    { channel: "code", items: [item("right.ts", 1, 9)] },
  ]);
  const sorted = fuse(c, probe(["right.ts"]), DEFAULT_TUNING);
  assert.equal(sorted[0]?.file, "right.ts");
  assert.ok(marginOf(sorted) > 0.3);
  assert.equal(marginOf([]), 0);
  assert.equal(marginOf([sorted[0] as Candidate]), 1);
});

test("weights are levers: zeroing a channel removes its influence", () => {
  const c = () => mergeCandidates([{ channel: "bm25", items: [item("x.ts", 1, 2)] }, { channel: "semantic", items: [item("y.ts", 1, 2)] }]);
  const noSem = fuse(c(), null, { ...DEFAULT_TUNING, weights: { ...DEFAULT_TUNING.weights, semantic: 0 } });
  assert.equal(noSem[0]?.file, "x.ts");
  const noBm = fuse(c(), null, { ...DEFAULT_TUNING, weights: { ...DEFAULT_TUNING.weights, bm25: 0 } });
  assert.equal(noBm[0]?.file, "y.ts");
});

const ok = { consistent: true, why: "" };

test("HIGH: independent channels agree, the query's words point at the symbol/file, and the hit matches the live file", () => {
  const terms = queryTerms("where do we hash the PRD lock");
  const sorted = fuse(mergeCandidates([{ channel: "bm25", items: [item("src/osa/lock.ts", 75, 87, "lockNow")] }, { channel: "lexical", items: [item("src/osa/lock.ts", 70, 90, "lockNow")] }]), probe(["src/osa/lock.ts"]), DEFAULT_TUNING);
  const s = signalsFor(sorted[0], sorted, probe(["src/osa/lock.ts"]), terms, ok, DEFAULT_TUNING);
  assert.equal(s.grepAgrees, true);
  assert.equal(s.pathAgrees, true);
  assert.deepEqual([...s.channelNames].sort(), ["bm25", "lexical"]);
  const v = assess(s, true, DEFAULT_TUNING);
  assert.equal(v.confidence, "high");
  assert.equal(v.abstain, false);
});

test("THE PRIOR SPIKE'S FAILURE: a plausible hit that no query word, symbol, path or text probe supports is LOW and abstains", () => {
  const terms = queryTerms("make sure the AI coding assistant is actually signed in before we start work");
  const wrong = mergeCandidates([{ channel: "bm25", items: [item("src/verify/coherence.ts", 10, 30, "checkCoherence")] }]);
  const sorted = fuse(wrong, probe(["src/verify/preflight.ts"]), DEFAULT_TUNING);
  const s = signalsFor(sorted[0], sorted, probe(["src/verify/preflight.ts"]), terms, ok, DEFAULT_TUNING);
  assert.equal(s.grepAgrees, false);
  assert.equal(s.symbolAgrees, false);
  const v = assess(s, true, DEFAULT_TUNING);
  assert.equal(v.confidence, "low");
  assert.equal(v.abstain, true);
  assert.match(v.reason, /no query word appears/);
});

test("a query whose words occur nowhere in the code abstains whatever the engines return", () => {
  const terms = queryTerms("zzzzqqqq nonexistent");
  const sorted = fuse(mergeCandidates([{ channel: "bm25", items: [item("docs/a.md", 1, 5)] }]), probe([], 0), DEFAULT_TUNING);
  const v = assess(signalsFor(sorted[0], sorted, probe([], 0), terms, ok, DEFAULT_TUNING), true, DEFAULT_TUNING);
  assert.equal(v.abstain, true);
  assert.match(v.reason, /0% of the query's words occur anywhere/);
});

test("an inconsistent hit (file gone, range outside the file, symbol not there, index stale) is never trusted", () => {
  const terms = queryTerms("lock now");
  const sorted = fuse(mergeCandidates([{ channel: "bm25", items: [item("src/osa/lock.ts", 75, 87, "lockNow")] }, { channel: "code", items: [item("src/osa/lock.ts", 75, 87, "lockNow")] }]), probe(["src/osa/lock.ts"]), DEFAULT_TUNING);
  const s = signalsFor(sorted[0], sorted, probe(["src/osa/lock.ts"]), terms, { consistent: false, why: "stale" }, DEFAULT_TUNING);
  const v = assess(s, true, DEFAULT_TUNING);
  assert.equal(v.abstain, true);
  assert.match(v.reason, /does not match the live file/);
});

test("MEDIUM: consistent and textually supported but only one channel found it", () => {
  const terms = queryTerms("lock now");
  const sorted = fuse(mergeCandidates([{ channel: "code", items: [item("src/osa/lock.ts", 75, 87, "lockNow")] }, { channel: "bm25", items: [item("other.ts", 1, 3)] }]), probe(["src/osa/lock.ts"]), { ...DEFAULT_TUNING, minChannelsHigh: 2 });
  const s = signalsFor(sorted[0], sorted, probe(["src/osa/lock.ts"]), terms, ok, DEFAULT_TUNING);
  const v = assess(s, true, { ...DEFAULT_TUNING, minChannelsMedium: 1 });
  assert.equal(v.confidence, "medium");
  assert.equal(v.abstain, false);
});

test("when the grep probe cannot run, its absence is NOT held against the hit (and coverage is not enforced)", () => {
  const terms = queryTerms("lock now");
  const sorted = fuse(mergeCandidates([{ channel: "bm25", items: [item("src/osa/lock.ts", 75, 87, "lockNow")] }, { channel: "lexical", items: [item("src/osa/lock.ts", 70, 90, "lockNow")] }]), null, DEFAULT_TUNING);
  const s = signalsFor(sorted[0], sorted, { files: [], coverage: 0, termsTried: 2, available: false }, terms, ok, DEFAULT_TUNING);
  assert.equal(s.grepAgrees, false);
  assert.equal(assess(s, false, DEFAULT_TUNING).abstain, false, "symbol and path still support it");
});

test("priors: isSpecQuestion / wantsTests / isTestFile classify the question and the file", () => {
  assert.equal(isSpecQuestion("why does the lock refuse a changed PRD"), true);
  assert.equal(isSpecQuestion("where is the retry loop"), false);
  assert.equal(wantsTests("which test covers the lock"), true);
  assert.equal(wantsTests("where is the lock written"), false);
  for (const f of ["src/a.test.ts", "tests/x.py", "pkg/test_util.py", "src/__tests__/a.ts", "lib/a_test.go"]) assert.equal(isTestFile(f), true, f);
  for (const f of ["src/latest.ts", "src/contest.ts", "docs/testing-notes.md"]) assert.equal(isTestFile(f), false, f);
});

test("priors: test demotion flips a test file that outranked the implementation, unless the question asks for tests", () => {
  const build = () => mergeCandidates([{ channel: "bm25", items: [item("src/lock.test.ts", 1, 9), item("src/lock.ts", 1, 9)] }]);
  const off = fuse(build(), null, DEFAULT_TUNING, { wantsTests: false, specQuestion: false, fragments: new Set() });
  assert.equal(off[0]?.file, "src/lock.test.ts", "priors default to off");
  const on = { ...DEFAULT_TUNING, testPenalty: 0.35 };
  assert.equal(fuse(build(), null, on, { wantsTests: false, specQuestion: false, fragments: new Set() })[0]?.file, "src/lock.ts");
  assert.equal(fuse(build(), null, on, { wantsTests: true, specQuestion: false, fragments: new Set() })[0]?.file, "src/lock.test.ts", "a question about tests keeps tests on top");
});

test("priors: definition boost needs a definition-like label and a symbol word that the question shares", () => {
  const build = () =>
    mergeCandidates([
      { channel: "bm25", items: [{ ...item("src/use.ts", 1, 3, "callLockTwice"), label: "Variable" }, { ...item("src/lock.ts", 1, 3, "acquireLock"), label: "Function" }] },
    ]);
  const t = { ...DEFAULT_TUNING, definitionBoost: 1.6 };
  const ctx = (words: string[]) => ({ wantsTests: false, specQuestion: false, fragments: new Set(words) });
  assert.equal(fuse(build(), null, t, ctx(["acquire", "lock"]))[0]?.file, "src/lock.ts");
  const unrelated = fuse(build(), null, t, ctx(["parse"]));
  assert.equal(unrelated[0]?.file, "src/use.ts", "no shared word: no boost, order unchanged");
});

test("priors: prose is boosted for why/rule questions and demoted otherwise, each only when its lever is set", () => {
  const build = () => mergeCandidates([{ channel: "bm25", items: [item("src/gate.ts", 1, 3), item("docs/GATES.md", 1, 3)] }]);
  const spec = { wantsTests: false, specQuestion: true, fragments: new Set<string>() };
  const plain = { wantsTests: false, specQuestion: false, fragments: new Set<string>() };
  assert.equal(fuse(build(), null, { ...DEFAULT_TUNING, docBoost: 1.8 }, spec)[0]?.file, "docs/GATES.md");
  assert.equal(fuse(build(), null, DEFAULT_TUNING, spec)[0]?.file, "src/gate.ts", "docBoost 1 is a no-op");
  assert.equal(fuse(build(), null, { ...DEFAULT_TUNING, docBoost: 1.8, docPenalty: 0.5 }, plain)[0]?.file, "src/gate.ts");
});
