// Semantic Scholar Graph API client. OPTIONAL and OFF by default (`research.semanticScholar: false`): it is
// only ever called when the operator both enables it in config AND provides `S2_API_KEY` in the environment.
// Without the key the stage records "semantic scholar skipped: no S2_API_KEY" and carries on.

import { httpGet, squash } from "./http.ts";
import type { HttpDeps, SourceResult } from "./http.ts";

/** One Semantic Scholar paper. */
export interface S2Paper {
  readonly paperId: string;
  readonly title: string;
  readonly year: number | null;
  readonly abstract: string;
  readonly citedByCount: number;
  readonly doi: string | null;
  readonly arxivId: string | null;
  readonly url: string;
  readonly oaPdfUrl: string | null;
  readonly authors: readonly string[];
}

/** Parses one Graph API paper object; `null` when it has no title. Pure. */
export function parseS2Paper(raw: unknown): S2Paper | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const title = typeof p["title"] === "string" ? squash(p["title"]) : "";
  const paperId = typeof p["paperId"] === "string" ? p["paperId"] : "";
  if (title === "" || paperId === "") return null;
  const ext = typeof p["externalIds"] === "object" && p["externalIds"] !== null ? (p["externalIds"] as Record<string, unknown>) : {};
  const oa = typeof p["openAccessPdf"] === "object" && p["openAccessPdf"] !== null ? (p["openAccessPdf"] as Record<string, unknown>) : null;
  const authors = Array.isArray(p["authors"]) ? (p["authors"] as unknown[]).map((a) => (typeof a === "object" && a !== null && typeof (a as Record<string, unknown>)["name"] === "string" ? String((a as Record<string, unknown>)["name"]) : "")).filter((x) => x !== "") : [];
  return {
    paperId,
    title,
    year: typeof p["year"] === "number" ? p["year"] : null,
    abstract: typeof p["abstract"] === "string" ? squash(p["abstract"]) : "",
    citedByCount: typeof p["citationCount"] === "number" ? p["citationCount"] : 0,
    doi: typeof ext["DOI"] === "string" ? ext["DOI"].toLowerCase() : null,
    arxivId: typeof ext["ArXiv"] === "string" ? ext["ArXiv"] : null,
    url: `https://www.semanticscholar.org/paper/${paperId}`,
    oaPdfUrl: typeof oa?.["url"] === "string" ? oa["url"] : null,
    authors,
  };
}

/** Searches Semantic Scholar. `apiKey` is required: callers must have checked `S2_API_KEY` first. */
export async function searchSemanticScholar(query: string, apiKey: string, perPage = 5, deps: HttpDeps = {}): Promise<SourceResult<S2Paper>> {
  const params = new URLSearchParams({ query: squash(query), limit: String(perPage), fields: "title,abstract,year,citationCount,externalIds,openAccessPdf,authors" });
  const res = await httpGet(`https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`, { headers: { "x-api-key": apiKey, "User-Agent": "osa-research" } }, deps);
  if (res.kind !== "ok") return { source: "semanticscholar", query, records: [], problem: res.message };
  try {
    const parsed = JSON.parse(res.text) as { data?: unknown };
    const papers = (Array.isArray(parsed.data) ? parsed.data : []).map(parseS2Paper).filter((x): x is S2Paper => x !== null);
    return { source: "semanticscholar", query, records: papers, problem: null };
  } catch {
    return { source: "semanticscholar", query, records: [], problem: "Semantic Scholar returned non-JSON" };
  }
}
