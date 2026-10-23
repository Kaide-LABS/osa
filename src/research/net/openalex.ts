// OpenAlex client (`api.openalex.org/works`): cross-discipline coverage (journals, conferences, non-CS fields
// such as operations research), citation counts, references, open-access PDF location.
//
// Live-verified 2026-10-17: without a key, requests share one small free daily budget per IP and the
// `mailto` parameter no longer raises it; a free `api_key` has its own larger budget. So: `mailto` is still
// sent when configured (the directive asks for it and it identifies us), `OPENALEX_API_KEY` is read from the
// environment when present, and a budget/rate failure degrades to "no results, with the reason logged".
// See docs/osa/CONFLICTS.md C-11.

import { httpGet, squash } from "./http.ts";
import type { HttpDeps, SourceResult } from "./http.ts";

/** One OpenAlex work. */
export interface OpenAlexWork {
  readonly openalexId: string;
  /** Bare DOI (`10.1137/...`), lowercased, or `null`. */
  readonly doi: string | null;
  readonly title: string;
  readonly year: number | null;
  readonly citedByCount: number;
  readonly abstract: string;
  readonly landingUrl: string;
  readonly oaPdfUrl: string | null;
  /** OpenAlex ids of the works this one cites. */
  readonly referencedWorks: readonly string[];
  readonly authors: readonly string[];
  /** arXiv id if OpenAlex knows one (via `ids` or a landing-page URL). */
  readonly arxivId: string | null;
}

/** Rebuilds the abstract text from OpenAlex's `abstract_inverted_index` ({word: [positions]}). Pure. */
export function reconstructAbstract(index: unknown): string {
  if (typeof index !== "object" || index === null) return "";
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (typeof p === "number" && p >= 0 && p < 100_000) slots[p] = word;
    }
  }
  return squash(slots.filter((w) => typeof w === "string").join(" "));
}

/** Normalises a DOI URL/prefix form to the bare lowercase DOI. */
export function normaliseDoi(doi: string): string {
  return doi.trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").replace(/^doi:/, "");
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Parses one `/works` result object. Returns `null` if it has no title. Pure. */
export function parseOpenAlexWork(raw: unknown): OpenAlexWork | null {
  if (typeof raw !== "object" || raw === null) return null;
  const w = raw as Record<string, unknown>;
  const title = str(w["title"]) ?? str(w["display_name"]);
  const id = str(w["id"]);
  if (title === null || id === null) return null;
  const best = typeof w["best_oa_location"] === "object" && w["best_oa_location"] !== null ? (w["best_oa_location"] as Record<string, unknown>) : null;
  const oa = typeof w["open_access"] === "object" && w["open_access"] !== null ? (w["open_access"] as Record<string, unknown>) : null;
  const ids = typeof w["ids"] === "object" && w["ids"] !== null ? (w["ids"] as Record<string, unknown>) : {};
  const landing = str(best?.["landing_page_url"]) ?? str(w["doi"]) ?? id;
  const arxivFromUrl = [landing, str(ids["arxiv"])].map((u) => u?.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:v\d+)?(?:\.pdf)?$/i)?.[1]).find((x) => x !== undefined);
  const authorships = Array.isArray(w["authorships"]) ? (w["authorships"] as unknown[]) : [];
  const authors = authorships
    .map((a) => (typeof a === "object" && a !== null ? str(((a as Record<string, unknown>)["author"] as Record<string, unknown> | undefined)?.["display_name"]) : null))
    .filter((x): x is string => x !== null);
  const doiRaw = str(w["doi"]);
  return {
    openalexId: id,
    doi: doiRaw === null ? null : normaliseDoi(doiRaw),
    title: squash(title),
    year: typeof w["publication_year"] === "number" ? w["publication_year"] : null,
    citedByCount: typeof w["cited_by_count"] === "number" ? w["cited_by_count"] : 0,
    abstract: reconstructAbstract(w["abstract_inverted_index"]),
    landingUrl: landing,
    oaPdfUrl: str(best?.["pdf_url"]) ?? str(oa?.["oa_url"]),
    referencedWorks: Array.isArray(w["referenced_works"]) ? (w["referenced_works"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
    authors,
    arxivId: arxivFromUrl ?? null,
  };
}

/** Options of {@link searchOpenAlex}. */
export interface OpenAlexSearchOptions {
  readonly perPage?: number;
  /** `research.openalexMailto`; sent as `mailto` when non-empty. */
  readonly mailto?: string;
  /** `OPENALEX_API_KEY` from the environment, if any. */
  readonly apiKey?: string;
}

const SELECT = "id,doi,title,display_name,publication_year,cited_by_count,abstract_inverted_index,best_oa_location,open_access,referenced_works,ids,authorships";

/** Searches OpenAlex works. Never throws; a failure (including an exhausted free budget) is reported in `problem`. */
export async function searchOpenAlex(query: string, opts: OpenAlexSearchOptions = {}, deps: HttpDeps = {}): Promise<SourceResult<OpenAlexWork>> {
  const params = new URLSearchParams({ search: squash(query), "per-page": String(opts.perPage ?? 5), select: SELECT });
  if (opts.mailto !== undefined && opts.mailto !== "") params.set("mailto", opts.mailto);
  if (opts.apiKey !== undefined && opts.apiKey !== "") params.set("api_key", opts.apiKey);
  const res = await httpGet(`https://api.openalex.org/works?${params.toString()}`, { headers: { "User-Agent": "osa-research" } }, deps);
  if (res.kind !== "ok") {
    const budget = res.kind === "rate_limited" || (res.kind === "error" && (res.status === 402 || res.status === 403));
    return { source: "openalex", query, records: [], problem: budget ? `${res.message} -- OpenAlex's free budget may be exhausted; set OPENALEX_API_KEY` : res.message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { source: "openalex", query, records: [], problem: "OpenAlex returned non-JSON" };
  }
  const results = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["results"] : undefined;
  const works = (Array.isArray(results) ? results : []).map(parseOpenAlexWork).filter((x): x is OpenAlexWork => x !== null);
  return { source: "openalex", query, records: works, problem: null };
}
