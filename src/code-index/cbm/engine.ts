// CbmEngine: codebase-memory-mcp behind OSA's guard (Suite 7). A question goes to four channels in parallel -- CBM BM25 over names and docs,
// CBM embeddings, CBM text search (which reports the ENCLOSING symbol of each match) and OSA's own lexical index -- plus an independent plain-text
// probe. Reciprocal-rank fusion orders the candidates; the guard (fusion.ts) then asks whether anything independent supports the winner.
// If not, or if CBM is unavailable, the answer is the lexical engine's, labelled as a fallback with the reason. Snippets are always read from
// the live file, and a hit whose file no longer matches the shadow manifest is dropped (and reported), never shown.

import { readFile } from "node:fs/promises";
import { loose, queryTerms } from "../query-terms.ts";
import { probeTerms } from "../grep-probe.ts";
import type { ProbeResult } from "../grep-probe.ts";
import { DEFAULT_TUNING, assess, fuse, isSpecQuestion, mergeCandidates, signalsFor, wantsTests } from "../fusion.ts";
import type { Candidate, ChannelName, Tuning } from "../fusion.ts";
import { SNIPPET_LINES, readLiveSnippet, safeRelPath } from "../engine.ts";
import type { CodeSearchEngine, EngineAnswer } from "../engine.ts";
import type { SearchHit } from "../search.ts";
import { isSecretPath } from "../spec-artifacts.ts";
import { CbmClient } from "./client.ts";
import type { CbmRow } from "./client.ts";
import { CbmSession } from "./session.ts";
import type { CbmPaths } from "./session.ts";
import { staleAgainstManifest, syncShadow } from "./shadow.ts";
import type { ShadowManifest, ShadowSnapshot } from "./shadow.ts";

/** Why CBM could not be used (the caller falls back to the lexical engine and says so). */
export class CbmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CbmUnavailableError";
  }
}

/** Engine options. */
export interface CbmEngineOptions {
  readonly repoDir: string;
  readonly paths: CbmPaths;
  readonly indexMode?: "full" | "moderate";
  readonly tuning?: Tuning;
  /** false = the "default" configuration the prior spike evaluated: take CBM's answer as is (no probe, no assessment, no abstain). */
  readonly guard?: boolean;
  /** Channels to use (default: all four). */
  readonly channels?: Readonly<Partial<Record<ChannelName, boolean>>>;
  /** The engine to fall back to (and the fourth channel). */
  readonly lexical: CodeSearchEngine;
  /** Test seam. */
  readonly session?: CbmSession;
  /** Per-channel result size. */
  readonly perChannel?: number;
  /** Fetch every channel once per question and re-use it (the tuning loop re-fuses the same raw results under many settings). */
  readonly cacheChannels?: boolean;
}

interface TraceItem {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol: string | null;
  readonly label: string;
}

/** "what calls X", "where is X called from", "callers of X", "who uses X": asks for the callers of an identifier. Pure. */
export function isCallerQuery(query: string): boolean {
  return /\b(?:what|who|which|where)\b[^.?]{0,40}\b(?:calls?|invokes?|uses?|references?|called from|invoked from|called by|used by)\b|\bcallers? of\b|\bcalled from\b|\binvoked from\b/i.test(query);
}

const GENERIC_LABELS = new Set(["File", "Module", "Folder", "Project", "Section"]);

/** Which of the symbol's name tokens appear (loosely) in the live range. Pure. */
export function symbolPresent(symbol: string | null, snippet: string): boolean {
  if (symbol === null || symbol === "") return true;
  const bare = symbol.split(/[.:#]/).pop() ?? symbol;
  return snippet.includes(bare) || snippet.toLowerCase().includes(loose(bare));
}

function lastSegment(qn: string): string {
  return qn.split(".").pop() ?? qn;
}

export class CbmEngine implements CodeSearchEngine {
  readonly name = "cbm";
  private o: CbmEngineOptions;
  private readonly client: CbmClient;
  private session: CbmSession;
  private project = "";
  private shadowDir = "";
  private manifest: ShadowManifest | null = null;
  private snapshot: ShadowSnapshot = { head: null, previous: null };
  private readonly channelCache = new Map<string, readonly [CbmRow[], CbmRow[], CbmRow[][], EngineAnswer | null, ProbeResult | null, TraceItem[]]>();
  private readonly outlineCache = new Map<string, Awaited<ReturnType<CbmClient["outline"]>>>();
  private closed = false;
  /** Set when the shadow changed since the last index (a stale answer was avoided; the next refresh() must re-index). */
  needsReindex = false;

  private constructor(o: CbmEngineOptions, session: CbmSession) {
    this.o = o;
    this.session = session;
    this.client = new CbmClient(session);
  }

  /** Mirrors the repo, starts CBM, indexes. Throws {@link CbmUnavailableError} (with the reason) if any step fails. */
  static async open(o: CbmEngineOptions): Promise<CbmEngine> {
    let session: CbmSession;
    try {
      session = o.session ?? (await CbmSession.open(o.paths));
    } catch (err) {
      throw new CbmUnavailableError(`codebase-memory-mcp could not be started: ${err instanceof Error ? err.message : String(err)}`);
    }
    const e = new CbmEngine(o, session);
    try {
      await e.refresh();
    } catch (err) {
      await session.close();
      throw new CbmUnavailableError(`codebase-memory-mcp could not index the project: ${err instanceof Error ? err.message : String(err)}`);
    }
    return e;
  }

  /** Re-mirror the repository and re-index if anything changed. */
  async refresh(): Promise<void> {
    const sync = await syncShadow(this.o.repoDir, this.o.paths.workDir);
    this.shadowDir = sync.shadowDir;
    this.manifest = sync.manifest;
    this.snapshot = sync.snapshot;
    if (this.project === "" || sync.copied > 0 || sync.removed > 0 || this.needsReindex) {
      const idx = await this.client.index(sync.shadowDir, this.o.indexMode ?? "full");
      this.project = idx.project;
      this.outlineCache.clear();
      this.needsReindex = false;
    }
    await this.o.lexical.refresh();
  }

  /** Changes the engine's behaviour in place (the eval and the tuning loop try many configurations against one warm index). */
  configure(patch: Partial<Pick<CbmEngineOptions, "tuning" | "guard" | "channels" | "perChannel" | "cacheChannels">>): void {
    this.o = { ...this.o, ...patch };
  }

  /** CBM's overview of the project: node and edge counts by kind, languages, packages, entry points (`get_architecture`). */
  async architecture(): Promise<Record<string, unknown>> {
    return this.client.architecture(this.project);
  }

  /**
   * What changed between the last two index snapshots and what depends on it (`detect_changes`). CBM diffs git history, and the repository it
   * indexes is OSA's shadow copy, so OSA keeps a private snapshot history there (one commit per refresh that changed something).
   */
  async changes(scope: "files" | "impact" | "tests" = "impact"): Promise<{ readonly since: string | null; readonly result: Record<string, unknown>; readonly note: string | null }> {
    if (this.snapshot.previous === null) return { since: null, result: {}, note: "only one snapshot of the project has been indexed so far, so there is nothing to compare yet" };
    return { since: this.snapshot.previous, result: await this.client.detectChanges(this.project, scope, this.snapshot.previous), note: null };
  }

  get projectName(): string {
    return this.project;
  }

  private async rowsToItems(rows: readonly CbmRow[]): Promise<{ file: string; startLine: number; endLine: number; symbol: string | null; label: string; codeTerms?: number }[]> {
    const items: { file: string; startLine: number; endLine: number; symbol: string | null; label: string }[] = [];
    for (const r of rows) {
      const file = safeRelPath(r.file);
      if (file === null || isSecretPath(file) || (this.manifest !== null && this.manifest.files[file] === undefined)) continue;
      let start = r.startLine;
      let end = r.endLine;
      if (start === null || end === null) {
        let outline = this.outlineCache.get(file);
        if (outline === undefined) {
          outline = await this.client.outline(this.project, file).catch(() => []);
          this.outlineCache.set(file, outline);
        }
        const o = outline.find((x) => x.qn === r.qn);
        if (o !== undefined) {
          start = o.startLine;
          end = o.endLine;
        }
      }
      if (start === null || end === null) {
        start = 1;
        end = SNIPPET_LINES;
      }
      items.push({ file, startLine: start, endLine: Math.max(start, end), symbol: GENERIC_LABELS.has(r.label) ? null : lastSegment(r.qn), label: r.label });
    }
    return items;
  }

  async search(query: string, opts: { readonly k?: number } = {}): Promise<EngineAnswer> {
    const t0 = Date.now();
    const k = opts.k ?? 8;
    const tuning = this.o.tuning ?? DEFAULT_TUNING;
    const use = { bm25: true, semantic: true, code: true, lexical: true, trace: true, ...(this.o.channels ?? {}) };
    const per = this.o.perChannel ?? 15;
    const terms = queryTerms(query);
    const semTerms = terms.words.slice(0, 8);
    const probeTermsList = [...new Set([...terms.identifiers.map((i) => i.toLowerCase()), ...terms.words])].slice(0, 6);
    const problems: string[] = [];

    const settle = async <T>(name: string, p: Promise<T>, empty: T): Promise<T> => {
      try {
        return await p;
      } catch (err) {
        problems.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        return empty;
      }
    };
    if (!this.session.alive) return this.fallback(query, k, t0, "codebase-memory-mcp is no longer running", []);

    const codePatterns = [...terms.identifiers, ...terms.words.slice(0, 3)].slice(0, 4);
    const callersOf = use.trace && isCallerQuery(query) ? terms.identifiers[0] ?? null : null;
    // With the channel cache on (tuning loops), every channel is fetched once per question and re-used; the channel flags then only decide which
    // lists reach the fusion. Without it, a disabled channel is not even queried.
    const cacheKey = `${String(per)}|${query}`;
    const cached = this.o.cacheChannels === true ? this.channelCache.get(cacheKey) : undefined;
    const all = this.o.cacheChannels === true;
    const gathered =
      cached ??
      (await Promise.all([
        all || use.bm25 ? settle("bm25", this.client.bm25(this.project, query, per), [] as CbmRow[]) : Promise.resolve([] as CbmRow[]),
        (all || use.semantic) && semTerms.length > 0 ? settle("semantic", this.client.semantic(this.project, semTerms, per), [] as CbmRow[]) : Promise.resolve([] as CbmRow[]),
        all || use.code ? Promise.all(codePatterns.map((p) => settle(`code(${p})`, this.client.code(this.project, p, 8), [] as CbmRow[]))) : Promise.resolve([] as CbmRow[][]),
        all || use.lexical ? settle("lexical", this.o.lexical.search(query, { k: per }), null) : Promise.resolve(null),
        this.o.guard === false && !all ? Promise.resolve(null) : probeTerms(this.shadowDir, probeTermsList),
        callersOf !== null && (all || use.trace) ? settle("trace", this.callers(callersOf, query), [] as TraceItem[]) : Promise.resolve([] as TraceItem[]),
      ] as const));
    if (this.o.cacheChannels === true && cached === undefined) this.channelCache.set(cacheKey, gathered);
    const [bm25Rows0, semRows0, codeRowSets0, lexAnswer0, probe0, callerItems0] = gathered;
    const bm25Rows = use.bm25 ? bm25Rows0 : [];
    const semRows = use.semantic ? semRows0 : [];
    const codeRowSets = use.code ? codeRowSets0 : [];
    const lexAnswer = use.lexical ? lexAnswer0 : null;
    const callerItems = use.trace ? callerItems0 : [];
    const probe = this.o.guard === false ? null : probe0;
    if (!this.session.alive) return this.fallback(query, k, t0, "codebase-memory-mcp stopped while answering", problems);

    // The text-search channel: one candidate per enclosing symbol, ranked by how many DISTINCT query terms it matched, then call-graph weight.
    const codeAgg = new Map<string, { row: CbmRow; terms: Set<number>; weight: number }>();
    codeRowSets.forEach((rows, i) => {
      for (const r of rows) {
        const key = `${r.file}:${r.qn}`;
        const e = codeAgg.get(key) ?? { row: r, terms: new Set<number>(), weight: (r.degreeIn ?? 0) + 1 };
        e.terms.add(i);
        codeAgg.set(key, e);
      }
    });
    const codeRows = [...codeAgg.values()].sort((a, b) => b.terms.size - a.terms.size || b.weight - a.weight).map((e) => e.row);
    const codeTermCount = new Map([...codeAgg.values()].map((e) => [e.row.qn, e.terms.size] as const));

    const lists: { channel: ChannelName; items: Awaited<ReturnType<CbmEngine["rowsToItems"]>> }[] = [
      { channel: "bm25", items: await this.rowsToItems(bm25Rows) },
      { channel: "semantic", items: await this.rowsToItems(semRows) },
      { channel: "code", items: (await this.rowsToItems(codeRows)).map((it, i) => ({ ...it, codeTerms: codeTermCount.get(codeRows[i]?.qn ?? "") ?? 0 })) },
      { channel: "lexical", items: (lexAnswer?.hits ?? []).map((h) => ({ file: h.path, startLine: h.startLine, endLine: h.endLine, symbol: h.symbol, label: "" })) },
      { channel: "trace", items: callerItems },
    ];
    const sorted = fuse(mergeCandidates(lists), probe, tuning, { wantsTests: wantsTests(query), specQuestion: isSpecQuestion(query), fragments: terms.fragments });

    // Freshness: drop candidates whose file no longer matches what the index was built from.
    const files = [...new Set(sorted.slice(0, 40).map((c) => c.file))];
    const stale = this.manifest === null ? [] : await staleAgainstManifest(this.o.repoDir, this.manifest, files);
    if (stale.length > 0) this.needsReindex = true;
    const fresh = sorted.filter((c) => !stale.includes(c.file));

    const top = fresh[0];
    let consistent = false;
    let live: { snippet: string; lineCount: number } | null = null;
    if (top !== undefined) {
      live = await readLiveSnippet(this.o.repoDir, top.file, top.startLine, top.endLine);
      consistent = live !== null && symbolPresent(top.symbol, await this.wholeRange(top));
    }
    const signals = signalsFor(top, fresh, probe, terms, { consistent, why: live === null ? "file or range missing" : "" }, tuning);

    if (this.o.guard === false) {
      const hits = await this.toHits(fresh, k);
      return { engine: "cbm", hits, confidence: "unassessed", abstained: false, reason: "CBM taken as is: no probe, no assessment", signals: null, stale, ms: Date.now() - t0 };
    }
    const verdict = assess(signals, probe?.available ?? false, tuning);
    if (top === undefined) return this.fallback(query, k, t0, "CBM found nothing for this query", problems, stale);
    if (verdict.abstain) return this.fallback(query, k, t0, verdict.reason, problems, stale, signals);
    const hits = await this.toHits(fresh, k);
    const note = problems.length > 0 ? ` (channel problems: ${problems.join("; ")})` : "";
    return { engine: "cbm", hits, confidence: verdict.confidence, abstained: false, reason: `${verdict.reason}${note}`, signals, stale, ms: Date.now() - t0 };
  }

  /** Call-path questions ("what calls X"): the callers from the call graph, tests last, each checked against the live file for the callee's name. */
  private async callers(fn: string, query: string): Promise<TraceItem[]> {
    const wantsTests = /\btests?\b/i.test(query);
    const traced = await this.client.trace(this.project, fn, "inbound", 1);
    const out: TraceItem[] = [];
    for (const t of traced.slice(0, 20)) {
      const snip = await this.client.snippet(this.project, t.qn);
      if (snip === null) continue;
      const file = safeRelPath(this.relativeToShadow(snip.file));
      if (file === null || isSecretPath(file) || (this.manifest !== null && this.manifest.files[file] === undefined)) continue;
      const isTest = /(?:\.test\.|\.spec\.|(?:^|\/)tests?\/|_test\.)/.test(file);
      if (isTest && !wantsTests) continue;
      const text = await this.wholeRange({ file, startLine: snip.startLine, endLine: snip.endLine } as Candidate);
      // graph consistency: a caller must actually mention the callee in the live file
      if (!text.includes(fn)) continue;
      out.push({ file, startLine: snip.startLine, endLine: snip.endLine, symbol: lastSegment(t.qn), label: "Function" });
    }
    return out;
  }

  private relativeToShadow(abs: string): string {
    const norm = abs.split(String.fromCharCode(92)).join("/");
    const base = this.shadowDir.split(String.fromCharCode(92)).join("/").replace(/\/+$/, "");
    return norm.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? norm.slice(base.length + 1) : norm;
  }

  private async wholeRange(c: Candidate): Promise<string> {
    const rel = safeRelPath(c.file);
    if (rel === null) return "";
    try {
      const lines = (await readFile(`${this.o.repoDir}/${rel}`, "utf8")).split(/\r?\n/);
      return lines.slice(Math.max(0, c.startLine - 1), c.endLine).join("\n");
    } catch {
      return "";
    }
  }

  private async toHits(sorted: readonly Candidate[], k: number): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    for (const c of sorted) {
      if (hits.length >= k) break;
      const live = await readLiveSnippet(this.o.repoDir, c.file, c.startLine, c.endLine);
      if (live === null) continue;
      hits.push({ path: c.file, startLine: c.startLine, endLine: Math.min(c.endLine, live.lineCount), symbol: c.symbol, score: Math.round(c.fused * 10_000) / 10_000, snippet: live.snippet });
    }
    return hits;
  }

  private async fallback(query: string, k: number, t0: number, why: string, problems: readonly string[], stale: readonly string[] = [], signals: EngineAnswer["signals"] = null): Promise<EngineAnswer> {
    const lex = await this.o.lexical.search(query, { k });
    const extra = problems.length > 0 ? ` (${problems.join("; ")})` : "";
    return { engine: "lexical-fallback", hits: lex.hits, confidence: "low", abstained: true, reason: `${why} -- answered by OSA's local index instead; verify with grep.${extra}`, signals, stale, ms: Date.now() - t0 };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.session.close();
  }
}
