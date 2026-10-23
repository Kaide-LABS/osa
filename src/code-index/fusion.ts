// Rank fusion and the confidence guard (Suite 7c/7f). Channels (CBM BM25, CBM embeddings, CBM text search, OSA's lexical index) each rank
// candidate code regions; reciprocal-rank fusion combines them with tunable weights; then the guard asks whether anything INDEPENDENT of
// the fused ranking supports the winner. No signal is trusted on its own: the prior spike's disqualifier was an engine that returned a
// plausible wrong file with a real-looking score and nothing to indicate it was wrong. A top hit is "high" only when separate channels
// agree on it AND a plain text probe, the query's own words, or the symbol/path names point the same way AND the file still matches the index.

import type { Confidence, Signals } from "./engine.ts";
import { rangesOverlap } from "./engine.ts";
import type { ProbeResult } from "./grep-probe.ts";
import { loose } from "./query-terms.ts";
import type { QueryTerms } from "./query-terms.ts";

export type ChannelName = "bm25" | "semantic" | "code" | "lexical" | "trace";

/** A candidate code region, with the rank each channel gave it (1 = best). */
export interface Candidate {
  readonly file: string;
  startLine: number;
  endLine: number;
  readonly symbol: string | null;
  readonly label: string;
  readonly ranks: Map<ChannelName, number>;
  /** How many distinct query terms the text-search channel matched in this region. */
  codeTerms: number;
  fused: number;
}

/** The tunables of fusion and of the guard (the 7f levers). */
export interface Tuning {
  readonly weights: Readonly<Record<ChannelName, number>>;
  /** Reciprocal-rank constant: larger flattens the difference between ranks. */
  readonly rrfK: number;
  /** Weight of the grep probe's file ranking as an extra voter. */
  readonly grepWeight: number;
  /** Minimum independent channels agreeing on the top hit for "high" / "medium". */
  readonly minChannelsHigh: number;
  readonly minChannelsMedium: number;
  /** Minimum relative margin between hit 1 and hit 2 for a margin-only "medium". */
  readonly minMargin: number;
  /** Below this share of query words existing anywhere in the tree, the query is about something this codebase does not mention: abstain. */
  readonly minCoverage: number;
  /** A hit counts as "in a channel's top N". */
  readonly agreeTopN: number;
  /** Top files of the grep probe that count as agreeing. */
  readonly grepTopFiles: number;
  /** Priors (1 = off). Score multiplier for test files unless the question asks for tests. */
  readonly testPenalty: number;
  /** Multiplier for definition-like symbols whose name shares a word with the question. */
  readonly definitionBoost: number;
  /** Multiplier for prose/spec files when the question asks why / which rule. */
  readonly docBoost: number;
  /** Multiplier for prose/spec files otherwise. */
  readonly docPenalty: number;
}

export const DEFAULT_TUNING: Tuning = {
  weights: { bm25: 1, semantic: 1, code: 1.2, lexical: 1, trace: 3 },
  rrfK: 20,
  grepWeight: 0.6,
  minChannelsHigh: 2,
  minChannelsMedium: 2,
  minMargin: 0.12,
  minCoverage: 0.5,
  agreeTopN: 3,
  grepTopFiles: 5,
  testPenalty: 1,
  definitionBoost: 1,
  docBoost: 1,
  docPenalty: 1,
};

/** The winning configuration of the 7f tuning log (docs/osa/TEST_REPORT.md, rows U1-U6 and V2): test files demoted, text-search channel weighted up,
semantic down, flatter fusion, and a high score-margin floor that makes the engine abstain rather than answer when its top two hits are close.
Used with {@link TUNED_PER_CHANNEL} results per channel. */
export const TUNED_TUNING: Tuning = {
  ...DEFAULT_TUNING,
  weights: { ...DEFAULT_TUNING.weights, code: 2.5, semantic: 0.3 },
  rrfK: 60,
  testPenalty: 0.35,
  minMargin: 0.4,
};

/** How many results each CBM channel contributes to the fusion in the tuned configuration (the engine's own default is 15). */
export const TUNED_PER_CHANNEL = 25;

/** Merges overlapping regions of the same file into one candidate, recording each channel's best rank for it. Pure. */
export function mergeCandidates(lists: readonly { channel: ChannelName; items: readonly { file: string; startLine: number; endLine: number; symbol: string | null; label?: string; codeTerms?: number }[] }[]): Candidate[] {
  const cands: Candidate[] = [];
  for (const { channel, items } of lists) {
    items.forEach((it, i) => {
      const rank = i + 1;
      const hit = cands.find((c) => c.file === it.file && rangesOverlap(c, it));
      if (hit === undefined) {
        cands.push({ file: it.file, startLine: it.startLine, endLine: it.endLine, symbol: it.symbol, label: it.label ?? "", ranks: new Map([[channel, rank]]), codeTerms: it.codeTerms ?? 0, fused: 0 });
        return;
      }
      const prev = hit.ranks.get(channel);
      if (prev === undefined || rank < prev) hit.ranks.set(channel, rank);
      // keep the TIGHTEST range that still covers what channels agree on
      if (it.endLine - it.startLine < hit.endLine - hit.startLine && it.endLine - it.startLine >= 0) {
        hit.startLine = it.startLine;
        hit.endLine = it.endLine;
      }
      if (hit.symbol === null && it.symbol !== null) {
        (hit as { symbol: string | null }).symbol = it.symbol;
      }
      hit.codeTerms = Math.max(hit.codeTerms, it.codeTerms ?? 0);
    });
  }
  return cands;
}

/** Facts about the question that the priors depend on. */
export interface FuseContext {
  /** The question mentions tests ("test", "spec", "fixture"): test files are then a legitimate answer. */
  readonly wantsTests: boolean;
  /** The question asks why / which rule / what the requirement is: the answer is probably prose, not code. */
  readonly specQuestion: boolean;
  /** Lowercase word fragments of the question (for matching a symbol's name). */
  readonly fragments: ReadonlySet<string>;
}

const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec|specs|fixtures?|e2e)\/|\.(?:test|spec)\.[a-z0-9]+$|(?:^|\/)test_[^/]+$|_test\.[a-z0-9]+$/i;
const DOC_FILE = /\.(?:md|mdx|rst|txt|yaml|yml)$/i;
const DEFINITION_LABELS = new Set(["Function", "Method", "Class", "Interface", "Type", "Enum", "Struct", "Trait"]);

/** Is `file` a test, spec or fixture file? Pure. */
export const isTestFile = (file: string): boolean => TEST_FILE.test(file);

/** Does the question ask for rationale or rules (where prose artifacts are the answer)? Pure. */
export function isSpecQuestion(query: string): boolean {
  return /\b(?:why|reason|rationale|decision|decided|requirement|requirements|rule|rules|policy|spec|specification|prd|contract|documented|criteria|invariant|convention)\b/i.test(query);
}

/** Does the question ask for tests? Pure. */
export function wantsTests(query: string): boolean {
  return /\b(?:tests?|testing|spec files?|fixtures?|assertions?|coverage)\b/i.test(query);
}

/**
 * Reciprocal-rank fusion (plus the grep probe's file ranking as a voter), then the priors; sorts best first. Pure given its inputs.
 * Priors (each 1 = off): test files are demoted unless the question asks for tests; definition-like symbols whose name shares a word with
 * the question are boosted; prose files are boosted for "why / which rule" questions and demoted otherwise only if `docPenalty` < 1.
 */
export function fuse(cands: Candidate[], probe: ProbeResult | null, t: Tuning, ctx?: FuseContext): Candidate[] {
  const fileRank = new Map<string, number>();
  probe?.files.slice(0, 20).forEach((f, i) => fileRank.set(f.file, i + 1));
  for (const c of cands) {
    let s = 0;
    for (const [ch, rank] of c.ranks) s += (t.weights[ch] ?? 0) / (t.rrfK + rank);
    const fr = fileRank.get(c.file);
    if (fr !== undefined) s += t.grepWeight / (t.rrfK + fr);
    if (ctx !== undefined) {
      if (!ctx.wantsTests && isTestFile(c.file)) s *= t.testPenalty;
      if (DEFINITION_LABELS.has(c.label) && c.symbol !== null) {
        const symTokens = c.symbol.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).map((x) => loose(x));
        if (symTokens.some((x) => x.length >= 3 && [...ctx.fragments].some((f) => loose(f) === x))) s *= t.definitionBoost;
      }
      if (ctx.specQuestion && DOC_FILE.test(c.file)) s *= t.docBoost;
      else if (!ctx.specQuestion && DOC_FILE.test(c.file)) s *= t.docPenalty;
    }
    c.fused = s;
  }
  return [...cands].sort((a, b) => b.fused - a.fused || a.file.localeCompare(b.file) || a.startLine - b.startLine);
}

/** The relative gap between the best and second-best fused score (1 when there is only one candidate). Pure. */
export function marginOf(sorted: readonly Candidate[]): number {
  const a = sorted[0]?.fused ?? 0;
  const b = sorted[1]?.fused ?? 0;
  return a <= 0 ? 0 : (a - b) / a;
}

/** What `assess` needs to know about the live file. */
export interface Consistency {
  /** The hit's file exists, the range lies inside it, and (if the hit names a symbol) the symbol appears in that range. */
  readonly consistent: boolean;
  readonly why: string;
}

/** Computes the guard's signals for the top candidate. Pure. */
export function signalsFor(top: Candidate | undefined, sorted: readonly Candidate[], probe: ProbeResult | null, terms: QueryTerms, consistency: Consistency, t: Tuning): Signals {
  const none: Signals = { coverage: probe?.coverage ?? 0, grepAgrees: false, symbolAgrees: false, pathAgrees: false, channels: 0, channelNames: [], margin: 0, consistent: false };
  if (top === undefined) return none;
  const channelNames = [...top.ranks.entries()].filter(([, r]) => r <= t.agreeTopN).map(([c]) => c);
  const queryLoose = new Set([...terms.fragments].map(loose));
  const symTokens = (top.symbol ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter((x) => x.length >= 2).map(loose);
  const pathTokens = top.file.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter((x) => x.length >= 2).map(loose);
  const grepTop = new Set(probe?.files.slice(0, t.grepTopFiles).map((f) => f.file) ?? []);
  return {
    coverage: probe?.coverage ?? 0,
    // when the probe could not run, the signal is NOT held against the hit (it is simply absent)
    grepAgrees: probe !== null && probe.available ? grepTop.has(top.file) : false,
    symbolAgrees: symTokens.some((s) => queryLoose.has(s)),
    pathAgrees: pathTokens.some((s) => queryLoose.has(s) && s.length >= 3),
    channels: channelNames.length,
    channelNames,
    margin: marginOf(sorted),
    consistent: consistency.consistent,
  };
}

/** The verdict. `fallback: true` means "do not answer with this engine's hits; use the fallback". Pure. */
export function assess(s: Signals, probeAvailable: boolean, t: Tuning): { confidence: Confidence; abstain: boolean; reason: string } {
  const failed: string[] = [];
  if (!s.consistent) failed.push("the top hit does not match the live file");
  if (probeAvailable && s.coverage < t.minCoverage) failed.push(`only ${String(Math.round(s.coverage * 100))}% of the query's words occur anywhere in the code`);
  const textual = s.grepAgrees || s.symbolAgrees || s.pathAgrees;
  if (!textual) failed.push("no query word appears in the hit's symbol, path or (by plain text search) its file");
  if (s.channels < t.minChannelsMedium && s.margin < t.minMargin) failed.push(`only ${String(s.channels)} independent channel(s) agree and the lead over the runner-up is thin`);
  if (failed.length > 0) return { confidence: "low", abstain: true, reason: `Low confidence: ${failed.join("; ")}.` };
  if (s.channels >= t.minChannelsHigh && textual && s.consistent) {
    return { confidence: "high", abstain: false, reason: `High confidence: ${s.channelNames.join(" + ")} agree and the query's words point at the same place.` };
  }
  return { confidence: "medium", abstain: false, reason: "Medium confidence: the hit is consistent and supported by the text, but few channels agree." };
}
