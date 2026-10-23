// GitHub REST client for public-repo prior-art lookup (Nia-style, WS3.4). Unauthenticated use works with
// low limits (verified live: 60 core requests/hour, 10 searches/minute; code search needs auth); an optional
// `GITHUB_TOKEN` from the environment raises them. Rate-limit headers are honoured by `httpGet` (back off,
// bounded, then report). READMEs and files are untrusted third-party text -- callers must present them to a
// model strictly as data.

import { httpGet } from "./http.ts";
import type { HttpDeps, SourceResult } from "./http.ts";

/** One repository search hit. */
export interface RepoHit {
  readonly fullName: string;
  readonly description: string;
  readonly stars: number;
  readonly language: string | null;
  readonly url: string;
  readonly updatedAt: string;
  readonly license: string | null;
}

/** Options shared by the GitHub calls. */
export interface GithubOptions {
  /** `GITHUB_TOKEN` from the environment, if any. */
  readonly token?: string;
}

function headers(opts: GithubOptions, raw = false): Record<string, string> {
  const h: Record<string, string> = {
    Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
    "User-Agent": "osa-research",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.token !== undefined && opts.token !== "") h["Authorization"] = `Bearer ${opts.token}`;
  return h;
}

/** Parses a `/search/repositories` response. Pure. */
export function parseRepoSearch(text: string): RepoHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const items = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["items"] : undefined;
  if (!Array.isArray(items)) return [];
  const hits: RepoHit[] = [];
  for (const it of items as unknown[]) {
    if (typeof it !== "object" || it === null) continue;
    const r = it as Record<string, unknown>;
    if (typeof r["full_name"] !== "string" || typeof r["html_url"] !== "string") continue;
    const lic = typeof r["license"] === "object" && r["license"] !== null ? (r["license"] as Record<string, unknown>)["spdx_id"] : null;
    hits.push({
      fullName: r["full_name"],
      description: typeof r["description"] === "string" ? r["description"] : "",
      stars: typeof r["stargazers_count"] === "number" ? r["stargazers_count"] : 0,
      language: typeof r["language"] === "string" ? r["language"] : null,
      url: r["html_url"],
      updatedAt: typeof r["updated_at"] === "string" ? r["updated_at"] : "",
      license: typeof lic === "string" ? lic : null,
    });
  }
  return hits;
}

/** Searches public repositories by stars. Never throws. */
export async function searchRepos(query: string, opts: GithubOptions = {}, perPage = 5, deps: HttpDeps = {}): Promise<SourceResult<RepoHit>> {
  const params = new URLSearchParams({ q: query, sort: "stars", order: "desc", per_page: String(perPage) });
  const res = await httpGet(`https://api.github.com/search/repositories?${params.toString()}`, { headers: headers(opts) }, deps);
  if (res.kind !== "ok") return { source: "github", query, records: [], problem: res.message };
  return { source: "github", query, records: parseRepoSearch(res.text), problem: null };
}

/** Fetches a repository's README as raw text (truncated to `maxChars`), or `null`. */
export async function getReadme(fullName: string, opts: GithubOptions = {}, maxChars = 6000, deps: HttpDeps = {}): Promise<string | null> {
  const res = await httpGet(`https://api.github.com/repos/${fullName}/readme`, { headers: headers(opts, true) }, deps);
  return res.kind === "ok" ? res.text.slice(0, maxChars) : null;
}

/** Lists the names in a repository's root directory, or `[]`. */
export async function listRoot(fullName: string, opts: GithubOptions = {}, deps: HttpDeps = {}): Promise<string[]> {
  const res = await httpGet(`https://api.github.com/repos/${fullName}/contents/`, { headers: headers(opts) }, deps);
  if (res.kind !== "ok") return [];
  try {
    const parsed = JSON.parse(res.text) as unknown;
    return Array.isArray(parsed) ? (parsed as unknown[]).map((e) => (typeof e === "object" && e !== null ? String((e as Record<string, unknown>)["name"] ?? "") : "")).filter((n) => n !== "") : [];
  } catch {
    return [];
  }
}

/** Fetches one file's raw text (truncated), or `null`. */
export async function getFile(fullName: string, path: string, opts: GithubOptions = {}, maxChars = 4000, deps: HttpDeps = {}): Promise<string | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await httpGet(`https://api.github.com/repos/${fullName}/contents/${encoded}`, { headers: headers(opts, true) }, deps);
  return res.kind === "ok" ? res.text.slice(0, maxChars) : null;
}

/** Files that usually reveal how a project is structured, in preference order. */
export const KEY_FILE_CANDIDATES: readonly string[] = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "setup.py", "Makefile", "tsconfig.json"];

/** Picks up to `limit` key files present in `rootNames`. Pure. */
export function pickKeyFiles(rootNames: readonly string[], limit = 2): string[] {
  const present = new Set(rootNames);
  return KEY_FILE_CANDIDATES.filter((f) => present.has(f)).slice(0, limit);
}
