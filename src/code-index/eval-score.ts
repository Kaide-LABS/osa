// Scoring for the code-search eval (Suite 7d). A hit "matches" a label two ways: at FILE level (same file as an expected location -- what a
// coarse engine like grep can offer) and STRICT (same file AND the hit's line range overlaps an expected range). Headline numbers use the file
// level; strict is reported beside it. CONFIDENT-WRONG is the metric the prior spike's disqualifier is about: the top hit is wrong and the engine
// did not flag it (not abstained, confidence not "low"). An engine that never assesses (grep, the raw lexical index, CBM as shipped) is never
// flagged, so every wrong top hit counts against it.

import { estimateTokens } from "../trim/trimmer.ts";
import { rangesOverlap } from "./engine.ts";
import type { EngineAnswer } from "./engine.ts";

export interface Expected {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface Label {
  readonly id: string;
  readonly repo: string;
  readonly kind: string;
  readonly query: string;
  readonly expect: readonly Expected[];
}

/** One scored query. */
export interface QueryScore {
  readonly id: string;
  readonly repo: string;
  readonly kind: string;
  readonly config: string;
  readonly engine: string;
  readonly confidence: string;
  readonly abstained: boolean;
  /** 1-based rank of the first file-level match within k, or null. */
  readonly fileRank: number | null;
  readonly strictRank: number | null;
  readonly topFileOk: boolean;
  readonly topStrictOk: boolean;
  /** Top hit wrong at file level, and not flagged. */
  readonly confidentWrong: boolean;
  /** Top hit wrong at file level (flagged or not). */
  readonly wrongTop: boolean;
  readonly tokens: number;
  readonly ms: number;
  readonly returned: readonly string[];
}

/** Scores one engine answer against one label. Pure. */
export function scoreQuery(label: Label, answer: EngineAnswer, config: string, k = 5): QueryScore {
  const hits = answer.hits.slice(0, k);
  const fileMatch = (h: { path: string }): boolean => label.expect.some((e) => e.path === h.path);
  const strictMatch = (h: { path: string; startLine: number; endLine: number }): boolean => label.expect.some((e) => e.path === h.path && rangesOverlap(e, h));
  const fi = hits.findIndex(fileMatch);
  const si = hits.findIndex(strictMatch);
  const top = hits[0];
  const topFileOk = top !== undefined && fileMatch(top);
  const flagged = answer.abstained || answer.confidence === "low";
  const tokens = hits.reduce((n, h) => n + estimateTokens(`${h.path}:${String(h.startLine)}-${String(h.endLine)}\n${h.snippet}`), 0);
  return {
    id: label.id,
    repo: label.repo,
    kind: label.kind,
    config,
    engine: answer.engine,
    confidence: answer.confidence,
    abstained: answer.abstained,
    fileRank: fi < 0 ? null : fi + 1,
    strictRank: si < 0 ? null : si + 1,
    topFileOk,
    topStrictOk: top !== undefined && strictMatch(top),
    confidentWrong: !topFileOk && !flagged,
    wrongTop: !topFileOk,
    tokens,
    ms: answer.ms,
    returned: hits.map((h) => `${h.path}:${String(h.startLine)}-${String(h.endLine)}`),
  };
}

/** Aggregate numbers for a set of scored queries. */
export interface Aggregate {
  readonly n: number;
  readonly recallFile: number;
  readonly recallStrict: number;
  readonly mrrFile: number;
  readonly mrrStrict: number;
  readonly top1File: number;
  readonly wrongTopRate: number;
  readonly confidentWrongRate: number;
  readonly abstainRate: number;
  /** Recall over only the answers the engine stood behind (not abstained). */
  readonly recallWhenAnswered: number | null;
  readonly answeredRate: number;
  readonly tokensMean: number;
  readonly msMedian: number;
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** Aggregates. Pure. */
export function aggregate(scores: readonly QueryScore[]): Aggregate {
  const n = scores.length;
  const answered = scores.filter((s) => !s.abstained);
  return {
    n,
    recallFile: n === 0 ? 0 : scores.filter((s) => s.fileRank !== null).length / n,
    recallStrict: n === 0 ? 0 : scores.filter((s) => s.strictRank !== null).length / n,
    mrrFile: mean(scores.map((s) => (s.fileRank === null ? 0 : 1 / s.fileRank))),
    mrrStrict: mean(scores.map((s) => (s.strictRank === null ? 0 : 1 / s.strictRank))),
    top1File: n === 0 ? 0 : scores.filter((s) => s.topFileOk).length / n,
    wrongTopRate: n === 0 ? 0 : scores.filter((s) => s.wrongTop).length / n,
    confidentWrongRate: n === 0 ? 0 : scores.filter((s) => s.confidentWrong).length / n,
    abstainRate: n === 0 ? 0 : scores.filter((s) => s.abstained).length / n,
    recallWhenAnswered: answered.length === 0 ? null : answered.filter((s) => s.fileRank !== null).length / answered.length,
    answeredRate: n === 0 ? 0 : answered.length / n,
    tokensMean: mean(scores.map((s) => s.tokens)),
    msMedian: median(scores.map((s) => s.ms)),
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** A markdown comparison table, one row per configuration. Pure. */
export function markdownTable(rows: readonly { readonly config: string; readonly agg: Aggregate }[]): string {
  const head = [
    "| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  const body = rows.map(
    ({ config, agg: a }) =>
      `| ${config} | ${String(a.n)} | ${pct(a.recallFile)} | ${pct(a.recallStrict)} | ${a.mrrFile.toFixed(3)} | ${a.mrrStrict.toFixed(3)} | ${pct(a.top1File)} | ${pct(a.wrongTopRate)} | **${pct(a.confidentWrongRate)}** | ${pct(a.abstainRate)} | ${a.recallWhenAnswered === null ? "n/a" : pct(a.recallWhenAnswered)} | ${a.tokensMean.toFixed(0)} | ${a.msMedian.toFixed(0)} |`,
  );
  return [...head, ...body].join(String.fromCharCode(10));
}
