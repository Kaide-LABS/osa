// Typed wrappers over the codebase-memory-mcp tools OSA uses. Every call asks for `format: "json"` and parses `structuredContent`
// (the shapes below were captured from the real binary, v0.12.1, and are pinned by client.test.ts with those payloads). Nothing here
// trusts a payload it cannot parse: an unexpected shape is a CbmProtocolError, which the engine turns into a fallback, never into a silent
// empty answer.

import type { CbmSession } from "./session.ts";

/** The payload did not have the shape this client was written against (a CBM upgrade, most likely). */
export class CbmProtocolError extends Error {
  constructor(tool: string, detail: string) {
    super(`codebase-memory-mcp ${tool}: unexpected response (${detail})`);
    this.name = "CbmProtocolError";
  }
}

/** One graph or code-search result. `startLine`/`endLine` are null when the tool did not report a range (semantic search). */
export interface CbmRow {
  readonly qn: string;
  readonly label: string;
  readonly file: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
  /** BM25 rank (more negative = better), semantic score, or 0 for code search. */
  readonly score: number;
  readonly channel: "bm25" | "semantic" | "code";
  /** Lines that matched (code search only). */
  readonly matchLines: readonly number[];
  /** Call graph degree (code search only): callers in, callees out. */
  readonly degreeIn: number | null;
  readonly degreeOut: number | null;
}

interface Table {
  readonly cols: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

function isTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && Array.isArray((v as Table).cols) && Array.isArray((v as Table).rows);
}

/** Parses "10-12" (or "7") into a range; null when absent/unparseable. Pure. */
export function parseLines(v: unknown): { start: number; end: number } | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)(?:-(\d+))?$/.exec(v.trim());
  if (m === null) return null;
  const start = Number(m[1]);
  return { start, end: m[2] === undefined ? start : Number(m[2]) };
}

function col(t: Table, name: string): number {
  return t.cols.indexOf(name);
}

/** Converts a CBM result table into rows. Pure. */
export function rowsOf(t: Table, channel: CbmRow["channel"]): CbmRow[] {
  const qn = col(t, "qn");
  const label = col(t, "label");
  const file = col(t, "file");
  if (qn < 0 || file < 0) throw new CbmProtocolError(channel, `columns ${t.cols.join(",")}`);
  const lines = col(t, "lines");
  const rank = col(t, "rank");
  const score = col(t, "score");
  const matches = col(t, "matches");
  const dIn = col(t, "in");
  const dOut = col(t, "out");
  return t.rows.map((r) => {
    const range = lines >= 0 ? parseLines(r[lines]) : null;
    return {
      qn: String(r[qn]),
      label: label >= 0 ? String(r[label]) : "",
      file: String(r[file]),
      startLine: range?.start ?? null,
      endLine: range?.end ?? null,
      score: typeof r[rank >= 0 ? rank : score] === "number" ? (r[rank >= 0 ? rank : score] as number) : 0,
      channel,
      matchLines: matches >= 0 && Array.isArray(r[matches]) ? (r[matches] as unknown[]).filter((x): x is number => typeof x === "number") : [],
      degreeIn: dIn >= 0 && typeof r[dIn] === "number" ? (r[dIn] as number) : null,
      degreeOut: dOut >= 0 && typeof r[dOut] === "number" ? (r[dOut] as number) : null,
    };
  });
}

/** What `index_repository` reports. */
export interface IndexSummary {
  readonly project: string;
  readonly nodes: number;
  readonly edges: number;
}

/** A source snippet. `file` is as CBM reports it (absolute); callers map it back to a repo-relative path. */
export interface Snippet {
  readonly qn: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly source: string;
  readonly callers: number;
  readonly callees: number;
}

/** The tools OSA calls, over one session. */
export class CbmClient {
  private readonly s: CbmSession;

  constructor(session: CbmSession) {
    this.s = session;
  }

  private async json(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ structured: Record<string, unknown>; text: string; isError: boolean }> {
    const r = await this.s.call(tool, { ...args, format: "json" }, timeoutMs);
    const structured = typeof r.structured === "object" && r.structured !== null && !Array.isArray(r.structured) ? (r.structured as Record<string, unknown>) : {};
    return { structured, text: r.text, isError: r.isError };
  }

  /** (Re)indexes `repoPath` (must be inside CBM_ALLOWED_ROOT). `mode: "full"` includes the semantic embeddings. */
  async index(repoPath: string, mode: "full" | "moderate" | "fast" = "full"): Promise<IndexSummary> {
    const r = await this.s.call("index_repository", { repo_path: repoPath, mode }, 600_000);
    if (r.isError) throw new CbmProtocolError("index_repository", r.text.slice(0, 200));
    let j: { project?: unknown; nodes?: unknown; edges?: unknown };
    try {
      j = JSON.parse(r.text) as typeof j;
    } catch {
      throw new CbmProtocolError("index_repository", `not JSON: ${r.text.slice(0, 80)}`);
    }
    if (typeof j.project !== "string") throw new CbmProtocolError("index_repository", "no project name");
    return { project: j.project, nodes: Number(j.nodes ?? 0), edges: Number(j.edges ?? 0) };
  }

  /** `ready` when the index can answer. */
  async status(project: string): Promise<{ status: string; nodes: number; edges: number; rootPath: string | null }> {
    const r = await this.json("index_status", { project });
    if (r.isError) return { status: "missing", nodes: 0, edges: 0, rootPath: null };
    return { status: String(r.structured["status"] ?? "unknown"), nodes: Number(r.structured["nodes"] ?? 0), edges: Number(r.structured["edges"] ?? 0), rootPath: typeof r.structured["root_path"] === "string" ? (r.structured["root_path"] as string) : null };
  }

  /** BM25 ranked search over names, paths and documentation sections. */
  async bm25(project: string, query: string, limit = 20): Promise<CbmRow[]> {
    const r = await this.json("search_graph", { project, query, limit });
    if (r.isError) throw new CbmProtocolError("search_graph", r.text.slice(0, 160));
    return isTable(r.structured) ? rowsOf(r.structured, "bm25") : [];
  }

  /** Embedding search over the whole graph; `terms` are single keywords (a phrase is silently ignored by CBM). */
  async semantic(project: string, terms: readonly string[], limit = 20): Promise<CbmRow[]> {
    const r = await this.json("search_graph", { project, semantic_query: terms, semantic_limit: limit, limit });
    if (r.isError) throw new CbmProtocolError("search_graph(semantic)", r.text.slice(0, 160));
    const sem = r.structured["semantic"];
    return isTable(sem) ? rowsOf(sem, "semantic") : [];
  }

  /** Text/regex search that reports the ENCLOSING symbol of each match (so a hit is a function, not a line). */
  async code(project: string, pattern: string, limit = 10, regex = false): Promise<CbmRow[]> {
    const r = await this.json("search_code", { project, pattern, limit, regex, mode: "compact" });
    if (r.isError) throw new CbmProtocolError("search_code", r.text.slice(0, 160));
    return isTable(r.structured) ? rowsOf(r.structured, "code") : [];
  }

  /** The source of a symbol, with its current line range as the index knows it. */
  async snippet(project: string, qn: string): Promise<Snippet | null> {
    const r = await this.json("get_code_snippet", { project, qualified_name: qn });
    if (r.isError || typeof r.structured["source"] !== "string") return null;
    const s = r.structured;
    return { qn, file: String(s["file_path"] ?? ""), startLine: Number(s["start_line"] ?? 0), endLine: Number(s["end_line"] ?? 0), source: s["source"] as string, callers: Number(s["callers"] ?? 0), callees: Number(s["callees"] ?? 0) };
  }

  /** Symbols defined in a file with their ranges (maps semantic hits, which carry no lines, to ranges). */
  async outline(project: string, file: string): Promise<{ name: string; label: string; startLine: number; endLine: number; qn: string }[]> {
    const r = await this.json("get_file_outline", { project, file_path: file });
    if (r.isError || !isTable(r.structured)) return [];
    const t = r.structured as unknown as Table;
    const [n, l, ln, q] = [col(t, "name"), col(t, "label"), col(t, "lines"), col(t, "qn")];
    const out: { name: string; label: string; startLine: number; endLine: number; qn: string }[] = [];
    for (const row of t.rows) {
      const range = parseLines(row[ln]);
      if (range !== null) out.push({ name: String(row[n]), label: String(row[l]), startLine: range.start, endLine: range.end, qn: String(row[q]) });
    }
    return out;
  }

  /** Callers or callees of a function, by name. */
  async trace(project: string, functionName: string, direction: "inbound" | "outbound" | "both" = "inbound", depth = 1): Promise<{ qn: string; hop: number }[]> {
    const r = await this.json("trace_path", { project, function_name: functionName, direction, depth });
    if (r.isError) return [];
    const out: { qn: string; hop: number }[] = [];
    for (const side of ["callers", "callees"]) {
      const block = r.structured[side] as { groups?: { qn_prefix?: string; rows?: unknown[][] }[] } | undefined;
      for (const g of block?.groups ?? []) for (const row of g.rows ?? []) out.push({ qn: g.qn_prefix ? `${g.qn_prefix}.${String(row[0])}` : String(row[0]), hop: Number(row[1] ?? 1) });
    }
    return out;
  }

  /** Project overview (labels, edge types, hotspots...). */
  async architecture(project: string): Promise<Record<string, unknown>> {
    const r = await this.json("get_architecture", { project });
    return r.isError ? {} : r.structured;
  }

  /** Files changed against a base and (scope "impact") the symbols that depend on them. */
  async detectChanges(project: string, scope: "files" | "impact" | "tests" = "impact", since?: string): Promise<Record<string, unknown>> {
    const r = await this.json("detect_changes", { project, scope, ...(since !== undefined ? { since } : {}) });
    return r.isError ? {} : r.structured;
  }
}
