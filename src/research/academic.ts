// The `academic-papers` module's tool side (WS3.3): run each academic query against arXiv and OpenAlex (plus
// Semantic Scholar only when enabled AND keyed), de-duplicate across sources, drop obvious non-matches, rank,
// and keep the best. Academic search runs by default, and "nothing relevant" is a *valid result*: it is
// logged and reported, never an error.

import { loggingHttp } from "./http-events.ts";
import { screenUntrusted } from "../osa/untrusted.ts";
import type { EventSink } from "../osa/events.ts";
import { dedupePapers, fromArxiv, fromOpenAlex, fromS2 } from "./dedupe.ts";
import type { PaperRecord } from "./dedupe.ts";
import { searchArxiv } from "./net/arxiv.ts";
import type { MinIntervalLimiter } from "./net/http.ts";
import type { HttpDeps } from "./net/http.ts";
import { searchOpenAlex } from "./net/openalex.ts";
import { searchSemanticScholar } from "./net/semantic-scholar.ts";

/** Options of {@link runAcademicSearch}. */
export interface AcademicOptions {
  readonly queries: readonly string[];
  /** Results requested from each source per query (default 5). */
  readonly perSource?: number;
  /** Papers kept overall after ranking (default 8). */
  readonly keep?: number;
  /** `research.openalexMailto`. */
  readonly openalexMailto?: string;
  /** `research.semanticScholar`. */
  readonly semanticScholar?: boolean;
  /** Environment to read optional keys from (`OPENALEX_API_KEY`, `S2_API_KEY`); default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly events: EventSink;
  readonly http?: HttpDeps;
  /** Test seam: arXiv limiter with a fake clock. */
  readonly arxivLimiter?: MinIntervalLimiter;
}

/** What one query found, per source. */
export interface AcademicQueryReport {
  readonly query: string;
  readonly arxiv: number;
  readonly openalex: number;
  readonly semanticScholar: number | "skipped";
  readonly merged: number;
  readonly relevant: number;
  readonly problems: readonly string[];
}

/** The result of {@link runAcademicSearch}. */
export interface AcademicResult {
  readonly queries: readonly AcademicQueryReport[];
  readonly papers: readonly PaperRecord[];
  /** True when nothing relevant was found -- a valid outcome. */
  readonly noneRelevant: boolean;
  readonly notes: readonly string[];
}

const STOP = new Set(["a", "an", "and", "the", "of", "for", "in", "on", "to", "with", "is", "are", "how", "what", "using", "use", "by", "from"]);

function contentWords(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))];
}

/** True iff at least half of the query's content words occur in the paper's title + abstract. Pure. */
export function isRelevant(query: string, paper: PaperRecord): boolean {
  const q = contentWords(query);
  if (q.length === 0) return true;
  const haystack = `${paper.title} ${paper.abstract}`.toLowerCase();
  const hits = q.filter((w) => haystack.includes(w)).length;
  return hits / q.length >= 0.5;
}

/** Ranks by citations (unknown counts last), then recency. Pure. */
export function rankPapers(papers: readonly PaperRecord[]): PaperRecord[] {
  return [...papers].sort((a, b) => (b.citedByCount ?? -1) - (a.citedByCount ?? -1) || (b.year ?? 0) - (a.year ?? 0));
}

/** Runs the academic search. Never throws. Emits one `academic_query` event per query. */
export async function runAcademicSearch(opts: AcademicOptions): Promise<AcademicResult> {
  const env = opts.env ?? process.env;
  const s2Key = env["S2_API_KEY"];
  const s2Active = opts.semanticScholar === true && s2Key !== undefined && s2Key !== "";
  const notes: string[] = [];
  if (opts.semanticScholar === true && !s2Active) notes.push("Semantic Scholar is enabled in config but S2_API_KEY is not set; skipped.");

  const perSource = opts.perSource ?? 5;
  const all: PaperRecord[] = [];
  const reports: AcademicQueryReport[] = [];

  const lh = loggingHttp(opts.http, opts.events);
  for (const query of opts.queries) {
    const [ax, oa, s2] = await Promise.all([
      searchArxiv(query, { maxResults: perSource, ...(opts.arxivLimiter !== undefined ? { limiter: opts.arxivLimiter } : {}) }, lh.http),
      searchOpenAlex(
        query,
        {
          perPage: perSource,
          ...(opts.openalexMailto !== undefined ? { mailto: opts.openalexMailto } : {}),
          ...(env["OPENALEX_API_KEY"] !== undefined ? { apiKey: env["OPENALEX_API_KEY"] } : {}),
        },
        lh.http,
      ),
      s2Active ? searchSemanticScholar(query, s2Key, perSource, lh.http) : Promise.resolve(null),
    ]);
    const found = [...ax.records.map(fromArxiv), ...oa.records.map(fromOpenAlex), ...(s2?.records.map(fromS2) ?? [])];
    const merged = dedupePapers(found);
    const relevant = merged.filter((p) => isRelevant(query, p));
    all.push(...relevant);
    const problems = [ax.problem, oa.problem, s2?.problem ?? null].filter((p): p is string => p !== null);
    const report: AcademicQueryReport = {
      query,
      arxiv: ax.records.length,
      openalex: oa.records.length,
      semanticScholar: s2 === null ? "skipped" : s2.records.length,
      merged: merged.length,
      relevant: relevant.length,
      problems,
    };
    reports.push(report);
    await opts.events.emit("academic_query", { ...report });
  }

  if (opts.queries.length === 0) {
    notes.push("No academic queries were planned for this project.");
    await opts.events.emit("academic_query", { query: null, skipped: "no academic queries were planned" });
  }
  await lh.flush();
  const ranked = rankPapers(dedupePapers(all)).slice(0, opts.keep ?? 8);
  // Titles and abstracts are attacker-controllable (anyone can post to arXiv): strip planted instructions before they are stored,
  // quoted into a prompt, or listed in the report.
  const papers: PaperRecord[] = [];
  for (const p of ranked) {
    const source = p.url;
    papers.push({
      ...p,
      title: await screenUntrusted({ text: p.title, kind: "paper title", source, events: opts.events, grow: false }),
      abstract: await screenUntrusted({ text: p.abstract, kind: "paper abstract", source, events: opts.events }),
    });
  }
  if (papers.length === 0) notes.push("No relevant academic papers were found; this is a valid result, not a failure.");
  return { queries: reports, papers, noneRelevant: papers.length === 0, notes };
}
