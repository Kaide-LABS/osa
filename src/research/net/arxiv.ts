// arXiv API client (`export.arxiv.org/api/query`, Atom XML). Search, metadata + abstract, PDF link.
// Respects arXiv's API guidance: one connection, >= 3 s between calls -- enforced by a module-owned
// {@link MinIntervalLimiter} so every caller in the process shares one lane.

import { MinIntervalLimiter, httpGet, squash } from "./http.ts";
import type { HttpDeps, SourceResult } from "./http.ts";

/** arXiv asks API clients to wait at least this long between calls. */
export const ARXIV_MIN_INTERVAL_MS = 3000;

/** One arXiv paper. */
export interface ArxivPaper {
  /** Version-less id, e.g. `1612.01691` or `cs/0112017`. */
  readonly arxivId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly abstract: string;
  readonly published: string;
  readonly absUrl: string;
  readonly pdfUrl: string | null;
  readonly doi: string | null;
  readonly categories: readonly string[];
}

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };

function decodeXml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m);
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m?.[1] === undefined ? null : squash(decodeXml(m[1]));
}

/** Strips the `http(s)://arxiv.org/abs/` prefix and the `vN` version suffix. */
export function normaliseArxivId(idUrlOrId: string): string {
  return idUrlOrId.replace(/^https?:\/\/arxiv\.org\/abs\//i, "").replace(/v\d+$/i, "");
}

/** Parses an arXiv Atom feed. Pure. */
export function parseArxivFeed(xml: string): ArxivPaper[] {
  const papers: ArxivPaper[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1] ?? "";
    const id = tag(e, "id");
    const title = tag(e, "title");
    if (id === null || title === null) continue;
    const pdfLink = e.match(/<link[^>]*title="pdf"[^>]*>/)?.[0];
    const pdfUrl = pdfLink?.match(/href="([^"]+)"/)?.[1] ?? null;
    const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((a) => squash(decodeXml(a[1] ?? "")));
    const categories = [...e.matchAll(/<category[^>]*term="([^"]+)"/g)].map((c) => c[1] ?? "");
    const arxivId = normaliseArxivId(id);
    papers.push({
      arxivId,
      title,
      authors,
      abstract: tag(e, "summary") ?? "",
      published: tag(e, "published") ?? "",
      absUrl: `https://arxiv.org/abs/${arxivId}`,
      pdfUrl,
      doi: tag(e, "arxiv:doi"),
      categories,
    });
  }
  return papers;
}

const STOPWORDS = new Set(["a", "an", "and", "the", "of", "for", "in", "on", "to", "with", "is", "are", "how", "what", "using", "use"]);

/** Builds arXiv's `search_query` from free text: the first `maxWords` content words ANDed on `all:`. Pure. */
export function buildArxivQuery(text: string, maxWords = 6): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .slice(0, maxWords);
  return words.map((w) => `all:${w}`).join("+AND+");
}

/** How many words to AND, widest first. arXiv matches every word, so a model-written query of four or more words often finds nothing; the search narrows step by step. */
const WORD_BUDGETS: readonly number[] = [6, 4, 3, 2];

/** Options of {@link searchArxiv}. */
export interface ArxivSearchOptions {
  readonly maxResults?: number;
  /** Shared limiter; default is the process-wide one. Tests pass their own with a fake clock. */
  readonly limiter?: MinIntervalLimiter;
}

const sharedLimiter = new MinIntervalLimiter(ARXIV_MIN_INTERVAL_MS);

/** Searches arXiv. Never throws; a failure is reported in `problem`. */
export async function searchArxiv(query: string, opts: ArxivSearchOptions = {}, deps: HttpDeps = {}): Promise<SourceResult<ArxivPaper>> {
  if (buildArxivQuery(query) === "") return { source: "arxiv", query, records: [], problem: "query had no searchable words" };
  const tried = new Set<string>();
  for (const budget of WORD_BUDGETS) {
    const q = buildArxivQuery(query, budget);
    if (tried.has(q)) continue; // the query has fewer words than this budget: same request as the last one
    tried.add(q);
    const url = `https://export.arxiv.org/api/query?search_query=${q}&start=0&max_results=${String(opts.maxResults ?? 5)}&sortBy=relevance`;
    const res = await httpGet(url, { limiter: opts.limiter ?? sharedLimiter, headers: { "User-Agent": "osa-research" } }, deps);
    if (res.kind !== "ok") return { source: "arxiv", query, records: [], problem: res.message };
    const records = parseArxivFeed(res.text);
    if (records.length > 0) return { source: "arxiv", query, records, problem: null };
  }
  return { source: "arxiv", query, records: [], problem: null };
}
