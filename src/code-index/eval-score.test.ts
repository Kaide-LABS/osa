import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, markdownTable, scoreQuery } from "./eval-score.ts";
import type { Label } from "./eval-score.ts";
import type { EngineAnswer } from "./engine.ts";

const label: Label = { id: "x-01", repo: "x", kind: "paraphrase", query: "q", expect: [{ path: "src/a.ts", startLine: 10, endLine: 20 }, { path: "src/b.ts", startLine: 1, endLine: 5 }] };
const hit = (path: string, s = 1, e = 3) => ({ path, startLine: s, endLine: e, symbol: null, score: 1, snippet: "code" });
const answer = (hits: ReturnType<typeof hit>[], over: Partial<EngineAnswer> = {}): EngineAnswer => ({ engine: "e", hits, confidence: "unassessed", abstained: false, reason: "", signals: null, stale: [], ms: 5, ...over });

test("file-level and strict matching are separate: right file wrong lines is a file match but not a strict one", () => {
  const s = scoreQuery(label, answer([hit("src/a.ts", 100, 110), hit("src/zzz.ts")]), "c");
  assert.equal(s.fileRank, 1);
  assert.equal(s.strictRank, null);
  assert.equal(s.topFileOk, true);
  assert.equal(s.topStrictOk, false);
  const t = scoreQuery(label, answer([hit("src/zzz.ts"), hit("src/b.ts", 4, 9)]), "c");
  assert.deepEqual([t.fileRank, t.strictRank], [2, 2]);
});

test("CONFIDENT-WRONG: a wrong top hit counts unless the engine flagged it (abstained or low); a right top hit never counts", () => {
  const wrong = [hit("src/zzz.ts")];
  assert.equal(scoreQuery(label, answer(wrong), "c").confidentWrong, true, "unassessed engines are never flagged");
  assert.equal(scoreQuery(label, answer(wrong, { confidence: "high" }), "c").confidentWrong, true);
  assert.equal(scoreQuery(label, answer(wrong, { confidence: "medium" }), "c").confidentWrong, true);
  assert.equal(scoreQuery(label, answer(wrong, { confidence: "low" }), "c").confidentWrong, false);
  assert.equal(scoreQuery(label, answer(wrong, { abstained: true, confidence: "low" }), "c").confidentWrong, false);
  const flaggedButWrong = scoreQuery(label, answer(wrong, { confidence: "low" }), "c");
  assert.equal(flaggedButWrong.wrongTop, true, "still a wrong top hit, just not a confident one");
  assert.equal(scoreQuery(label, answer([hit("src/a.ts", 12, 14)], { confidence: "high" }), "c").confidentWrong, false);
  assert.equal(scoreQuery(label, answer([]), "c").confidentWrong, true, "no hits and no flag is a confident miss");
});

test("only the first k hits count, and tokens are counted over what was returned", () => {
  const many = [hit("a1"), hit("a2"), hit("a3"), hit("a4"), hit("a5"), hit("src/a.ts", 12, 14)];
  assert.equal(scoreQuery(label, answer(many), "c", 5).fileRank, null);
  assert.equal(scoreQuery(label, answer(many), "c", 6).fileRank, 6);
  assert.ok(scoreQuery(label, answer([hit("p", 1, 2)]), "c").tokens > 0);
});

test("aggregate: recall, MRR, rates and medians; recall-when-answered ignores abstentions", () => {
  const sc = [
    scoreQuery(label, answer([hit("src/a.ts", 12, 14)], { confidence: "high", ms: 10 }), "c"),
    scoreQuery(label, answer([hit("no"), hit("src/b.ts", 2, 3)], { confidence: "high", ms: 30 }), "c"),
    scoreQuery(label, answer([hit("no")], { abstained: true, confidence: "low", ms: 20 }), "c"),
    scoreQuery(label, answer([hit("no")], { confidence: "medium", ms: 40 }), "c"),
  ];
  const a = aggregate(sc);
  assert.equal(a.n, 4);
  assert.equal(a.recallFile, 0.5);
  assert.equal(a.mrrFile, (1 + 0.5 + 0 + 0) / 4);
  assert.equal(a.top1File, 0.25);
  assert.equal(a.wrongTopRate, 0.75);
  assert.equal(a.confidentWrongRate, 0.5, "the second and fourth: wrong top, not flagged");
  assert.equal(a.abstainRate, 0.25);
  assert.equal(a.answeredRate, 0.75);
  assert.equal(a.recallWhenAnswered, 2 / 3);
  assert.equal(a.msMedian, 25);
  assert.equal(aggregate([]).recallFile, 0);
  assert.equal(aggregate([]).recallWhenAnswered, null);
});

test("markdownTable renders one row per config with the confident-wrong column in bold", () => {
  const t = markdownTable([{ config: "grep", agg: aggregate([scoreQuery(label, answer([hit("no")]), "grep")]) }]);
  assert.match(t, /\| grep \| 1 \| 0\.0% .* \*\*100\.0%\*\* /);
  assert.equal(t.split("\n").length, 3);
});
