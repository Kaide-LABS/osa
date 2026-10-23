// The code-search engine seam (Suite 7e). `code_search` and the "where to look first" block injected into build agents' context both ask an
// engine; which engine answers is a config choice (`index.engine`), and the answer always says WHICH engine produced it, with what
// confidence and why -- so a wrong answer is never silent and a fallback is never invisible.
//
//   lexical  OSA's own hashed sub-word TF-IDF index (offline, no dependency, always available)
//   grep     plain text search: the baseline an agent without any index falls back to
//   cbm      codebase-memory-mcp (graph + embeddings + text search) behind OSA's confidence guard, with `lexical` as the fallback
//
// Every hit's snippet is read from the LIVE file at answer time, never from an index, so the content shown can never be older than the file.

import { readFile } from "node:fs/promises";
import { updateIndex } from "./indexer.ts";
import { excludeSpecs, probeTerms } from "./grep-probe.ts";
import { queryTerms } from "./query-terms.ts";
import { searchIndex } from "./search.ts";
import type { SearchHit } from "./search.ts";
import { runProcess } from "../util/exec.ts";
import type { EventSink } from "../osa/events.ts";

export type Confidence = "high" | "medium" | "low" | "unassessed";

/** The independent evidence behind a confidence (null for engines that do not assess). */
export interface Signals {
  /** Query words found anywhere in the indexed tree (0..1). */
  readonly coverage: number;
  readonly grepAgrees: boolean;
  readonly symbolAgrees: boolean;
  readonly pathAgrees: boolean;
  /** Independent channels that rank the top hit in their own top 3. */
  readonly channels: number;
  readonly channelNames: readonly string[];
  /** Relative gap between the fused scores of hit 1 and hit 2 (0..1). */
  readonly margin: number;
  /** The top hit exists in the live file where the index says, and the index is current for it. */
  readonly consistent: boolean;
}

/** What an engine returns. */
export interface EngineAnswer {
  /** Which engine's results these are (a CBM answer that fell back says "lexical-fallback"). */
  readonly engine: string;
  readonly hits: readonly SearchHit[];
  readonly confidence: Confidence;
  readonly abstained: boolean;
  /** One plain sentence: why this confidence, or why the engine fell back. */
  readonly reason: string;
  readonly signals: Signals | null;
  /** Files whose hits were dropped because the index no longer matched them (a re-index is needed). */
  readonly stale: readonly string[];
  readonly ms: number;
}

/** An engine. */
export interface CodeSearchEngine {
  readonly name: string;
  search(query: string, opts?: { readonly k?: number }): Promise<EngineAnswer>;
  /** Bring the engine's index up to date with the working tree. */
  refresh(): Promise<void>;
  /** Release anything held (processes, handles). Idempotent. */
  close(): Promise<void>;
}

/** Lines of context shown per hit. */
export const SNIPPET_LINES = 12;

/** True iff two inclusive line ranges overlap. Pure. */
export function rangesOverlap(a: { startLine: number; endLine: number }, b: { startLine: number; endLine: number }): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/** A repo-relative POSIX path with no traversal, else null. Pure. */
export function safeRelPath(p: string): string | null {
  const s = p.split(String.fromCharCode(92)).join("/").replace(/^\.\//, "");
  if (s === "" || s.startsWith("/") || /^[A-Za-z]:/.test(s) || s.split("/").includes("..")) return null;
  return s;
}

/** The live text of `file` lines [start, end], capped at {@link SNIPPET_LINES} lines; `null` if the file is gone or the range is outside it. */
export async function readLiveSnippet(repoDir: string, file: string, startLine: number, endLine: number): Promise<{ snippet: string; lineCount: number } | null> {
  const rel = safeRelPath(file);
  if (rel === null) return null;
  let text: string;
  try {
    text = await readFile(`${repoDir}/${rel}`, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  if (startLine < 1 || startLine > lines.length) return null;
  const end = Math.min(endLine, startLine + SNIPPET_LINES - 1, lines.length);
  return { snippet: lines.slice(startLine - 1, end).join("\n"), lineCount: lines.length };
}

// ---- lexical -------------------------------------------------------------------------------------------------------------------

/** OSA's own index, as an engine. Unassessed: it reports what it found, with no independent check. */
export class LexicalEngine implements CodeSearchEngine {
  readonly name = "lexical";
  private readonly repoDir: string;
  private readonly refreshOnSearch: boolean;
  private readonly events: EventSink | undefined;

  constructor(repoDir: string, opts: { readonly refreshOnSearch?: boolean; readonly events?: EventSink } = {}) {
    this.repoDir = repoDir;
    this.refreshOnSearch = opts.refreshOnSearch ?? true;
    this.events = opts.events;
  }

  async refresh(): Promise<void> {
    await updateIndex({ repoDir: this.repoDir, ...(this.events !== undefined ? { events: this.events } : {}) });
  }

  async search(query: string, opts: { readonly k?: number } = {}): Promise<EngineAnswer> {
    const t0 = Date.now();
    if (this.refreshOnSearch) await this.refresh();
    const hits = await searchIndex(this.repoDir, query, { k: opts.k ?? 8 });
    return { engine: "lexical", hits, confidence: "unassessed", abstained: false, reason: "OSA's local index; no independent check", signals: null, stale: [], ms: Date.now() - t0 };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ---- grep ----------------------------------------------------------------------------------------------------------------------

/** Parses `git grep -n` output ("path:line:text"). Pure. */
export function parseGrepLines(stdout: string): { file: string; line: number }[] {
  const out: { file: string; line: number }[] = [];
  for (const row of stdout.split(/\r?\n/)) {
    const m = /^(.+?):(\d+):/.exec(row);
    if (m?.[1] !== undefined && m[2] !== undefined) out.push({ file: m[1].split(String.fromCharCode(92)).join("/"), line: Number(m[2]) });
  }
  return out;
}

/** What an agent with only grep would do: look for the query's words, prefer files containing the most of them, read around the densest spot. */
export class GrepEngine implements CodeSearchEngine {
  readonly name = "grep";
  private readonly repoDir: string;
  private readonly spawn: typeof runProcess;

  constructor(repoDir: string, spawn: typeof runProcess = runProcess) {
    this.repoDir = repoDir;
    this.spawn = spawn;
  }

  refresh(): Promise<void> {
    return Promise.resolve();
  }

  async search(query: string, opts: { readonly k?: number } = {}): Promise<EngineAnswer> {
    const t0 = Date.now();
    const k = opts.k ?? 8;
    const q = queryTerms(query);
    const terms = [...new Set([...q.identifiers.map((i) => i.toLowerCase()), ...q.words])].slice(0, 8);
    const probe = await probeTerms(this.repoDir, terms, { spawn: this.spawn, maxTerms: 8 });
    const hits: SearchHit[] = [];
    // A careful engineer greps for the DEFINITION of any identifier in the question first ("function X", "class X", "def X"), then falls back to counting words.
    const defFiles = new Set<string>();
    for (const ident of q.identifiers.filter((i) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(i)).slice(0, 3)) {
      const r = await this.spawn({
        command: "git",
        args: ["grep", "--no-index", "-I", "-n", "-E", `(function|class|def|interface|type|const|let|var|enum|fn|struct)[[:space:]]+${ident}([^A-Za-z0-9_]|$)`, ...excludeSpecs()],
        cwd: this.repoDir,
        timeoutMs: 20_000,
        noShellFallback: true,
      });
      for (const g of parseGrepLines(r.stdout)) {
        if (defFiles.has(g.file) || /\.(?:test|spec)\./.test(g.file)) continue;
        defFiles.add(g.file);
        const live = await readLiveSnippet(this.repoDir, g.file, g.line, g.line + SNIPPET_LINES - 1);
        if (live !== null) hits.push({ path: g.file, startLine: g.line, endLine: Math.min(live.lineCount, g.line + SNIPPET_LINES - 1), symbol: ident, score: 100, snippet: live.snippet });
      }
    }
    for (const f of probe.files.filter((x) => !defFiles.has(x.file)).slice(0, Math.max(0, k - hits.length))) {
      // densest window: the line (over all terms) with the most distinct terms within the next SNIPPET_LINES lines
      const lineHits: { line: number; term: string }[] = [];
      for (const t of f.terms) {
        const r = await this.spawn({ command: "git", args: ["grep", "--no-index", "-I", "-i", "-F", "-n", "-e", t, "--", f.file], cwd: this.repoDir, timeoutMs: 20_000, noShellFallback: true });
        for (const g of parseGrepLines(r.stdout)) lineHits.push({ line: g.line, term: t });
      }
      let best = lineHits[0]?.line ?? 1;
      let bestCount = 0;
      for (const a of lineHits) {
        const inWindow = new Set(lineHits.filter((b) => b.line >= a.line - 2 && b.line <= a.line + SNIPPET_LINES).map((b) => b.term)).size;
        if (inWindow > bestCount || (inWindow === bestCount && a.line < best)) {
          best = a.line;
          bestCount = inWindow;
        }
      }
      const start = Math.max(1, best - 2);
      const live = await readLiveSnippet(this.repoDir, f.file, start, start + SNIPPET_LINES - 1);
      if (live === null) continue;
      hits.push({ path: f.file, startLine: start, endLine: Math.min(live.lineCount, start + SNIPPET_LINES - 1), symbol: null, score: f.distinct + f.matches / 1000, snippet: live.snippet });
    }
    return { engine: "grep", hits, confidence: "unassessed", abstained: false, reason: "plain text search; files ranked by how many query words they contain", signals: null, stale: [], ms: Date.now() - t0 };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
