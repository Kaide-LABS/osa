// Query-time retrieval over the flat index: cosine similarity of IDF-weighted sparse vectors (IDF is recomputed from
// the stored document frequencies, so the index stays incremental), plus small lexical boosts for a query word that
// appears in a chunk's symbol name or file path. Returns paths + line ranges + snippets, best first.

import { readFile } from "node:fs/promises";
import { indexDir, indexStamp, readRawIndex, StoredChunkSchema } from "./store.ts";
import type { StoredChunk } from "./store.ts";
import { LocalHashEmbedder, stem, tokenize } from "./tokenize.ts";
import type { Embedder } from "./tokenize.ts";

/** One search hit. */
export interface SearchHit {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol: string | null;
  readonly score: number;
  readonly snippet: string;
}

interface Loaded {
  readonly chunks: readonly { readonly c: StoredChunk; readonly vec: Map<number, number>; readonly symTokens: Set<string>; readonly pathTokens: Set<string> }[];
  readonly idf: Map<number, number>;
  readonly embedder: string;
}

const cache = new Map<string, { stamp: string; loaded: Loaded }>();

async function load(repoDir: string): Promise<Loaded | null> {
  const stamp = await indexStamp(repoDir);
  const hit = cache.get(repoDir);
  if (hit !== undefined && hit.stamp === stamp) return hit.loaded;
  const raw = await readRawIndex(repoDir);
  if (raw.meta === null) return null;
  const text = await readFile(`${indexDir(repoDir)}/chunks.jsonl`, "utf8");
  const chunks: Loaded["chunks"][number][] = [];
  const df = new Map<number, number>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const c = StoredChunkSchema.parse(JSON.parse(line));
    const vec = new Map<number, number>(c.v);
    for (const b of vec.keys()) df.set(b, (df.get(b) ?? 0) + 1);
    chunks.push({ c, vec, symTokens: new Set(tokenize(c.sym ?? "")), pathTokens: new Set(tokenize(c.p)) });
  }
  const n = Math.max(1, chunks.length);
  const idf = new Map<number, number>();
  for (const [b, d] of df) idf.set(b, Math.log(1 + n / (1 + d)));
  const loaded: Loaded = { chunks, idf, embedder: raw.meta.embedder };
  cache.set(repoDir, { stamp, loaded });
  return loaded;
}

function weighted(vec: ReadonlyMap<number, number>, idf: ReadonlyMap<number, number>): { v: Map<number, number>; norm: number } {
  const v = new Map<number, number>();
  let sq = 0;
  for (const [b, w] of vec) {
    const x = w * (idf.get(b) ?? Math.log(2));
    v.set(b, x);
    sq += x * x;
  }
  return { v, norm: Math.sqrt(sq) };
}

/** Options of {@link searchIndex}. */
export interface SearchOptions {
  readonly k?: number;
  readonly embedder?: Embedder;
}

/** Top-`k` chunks for `query`, best first; `[]` when there is no index or nothing scores above zero. */
export async function searchIndex(repoDir: string, query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const loaded = await load(repoDir);
  if (loaded === null) return [];
  const embedder = opts.embedder ?? LocalHashEmbedder;
  const q = weighted(embedder.embedQuery(query), loaded.idf);
  if (q.norm === 0) return [];
  const qTokens = [...new Set(tokenize(query))];
  const scored: SearchHit[] = [];
  for (const { c, vec, symTokens, pathTokens } of loaded.chunks) {
    let dot = 0;
    let cn = 0;
    for (const [b, w] of vec) {
      const x = w * (loaded.idf.get(b) ?? 0);
      cn += x * x;
      const qw = q.v.get(b);
      if (qw !== undefined) dot += qw * x;
    }
    if (dot === 0) continue;
    let score = dot / (q.norm * Math.sqrt(cn));
    let symBoost = 0;
    let pathBoost = 0;
    for (const t of qTokens) {
      if (symTokens.has(t) || symTokens.has(stem(t))) symBoost += 0.12;
      if (pathTokens.has(t) || pathTokens.has(stem(t))) pathBoost += 0.05;
    }
    score += Math.min(symBoost, 0.36) + Math.min(pathBoost, 0.15);
    scored.push({ path: c.p, startLine: c.s, endLine: c.e, symbol: c.sym, score: Math.round(score * 1000) / 1000, snippet: c.snip });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
  return scored.slice(0, Math.max(1, opts.k ?? 8));
}

/** Clears the in-process cache (tests). */
export function clearSearchCache(): void {
  cache.clear();
}

// The agent-context rendering lives in guard.ts, which screens and fences the snippets as untrusted text.
export { renderIndexContext } from "./guard.ts";
