// The hybrid code-search engine: OSA's lexical index finds candidate chunks, an embeddings model re-ranks them by MEANING, and the two rankings are
// fused (reciprocal rank fusion). It exists for the question the lexical index is weakest at -- a query that shares no words with the code it
// should find ("where do we throttle requests" for `rateLimiter`). It is OFF unless `index.engine` is "hybrid", and it needs an OpenAI-compatible
// embeddings endpoint the operator names (`index.semantic`, docs/osa/SEMANTIC.md): a hosted one with a key, or a local server with none.
//
// Design:
//  * Candidates are the lexical top `candidateLimit` hits, topped up with the remaining chunks of the index (in path order) up to that limit, so a
//    small repo is searched in full and a paraphrase that matches no word still has its chunks considered. A large repo is searched only among
//    the lexical candidates (stated in the answer's reason): semantic recall there is limited by the lexical stage.
//  * Chunk vectors are cached on disk under `.osa/index/` (derived data, gitignored with the rest of the index), keyed by a hash of the model and the
//    exact text, so a chunk is embedded once and only changed chunks cost anything again. A query costs one embedding call plus the chunks not yet cached.
//  * It can never make a search fail: any embeddings problem (no endpoint, 401, timeout, bad response) answers from the lexical index instead, and the
//    answer says so (engine "lexical-fallback", with the cause).
//  * Every hit's snippet is the lexical engine's, i.e. read from the live file; the vectors only decide the order.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import type { OsaConfig } from "../domain/osa-config.ts";
import type { EventSink } from "../osa/events.ts";
import { EmbeddingsError, cosine, embedTexts } from "../research/net/embeddings.ts";
import type { EmbeddingsDeps } from "../research/net/embeddings.ts";
import type { CodeSearchEngine, EngineAnswer, LexicalEngine } from "./engine.ts";
import type { SearchHit } from "./search.ts";
import { StoredChunkSchema, indexDir, readRawIndex } from "./store.ts";

export type SemanticConfig = OsaConfig["index"]["semantic"];

/** RRF constant (the usual 60): how fast a rank's contribution falls off. */
const RRF_K = 60;
/** Characters of a chunk sent to the embeddings model; a chunk's head says what it is. */
const MAX_EMBED_CHARS = 2000;

/** Why the hybrid engine cannot be used with this configuration, or null when it can. Pure. */
export function semanticConfigProblem(s: SemanticConfig): string | null {
  if (s.baseUrl === "" || s.model === "") return "index.semantic.baseUrl and index.semantic.model must both be set to use the hybrid engine (docs/osa/SEMANTIC.md)";
  return null;
}

/** The text embedded for a chunk. Pure. */
export function embedTextOf(h: Pick<SearchHit, "path" | "symbol" | "snippet">): string {
  return `${h.path}${h.symbol !== null ? ` :: ${h.symbol}` : ""}\n${h.snippet}`.slice(0, MAX_EMBED_CHARS);
}

const keyOf = (model: string, text: string): string => createHash("sha256").update(`${model}\u0000${text}`).digest("hex").slice(0, 32);

const vectorsPath = (repoDir: string): string => `${indexDir(repoDir)}/vectors.jsonl`;

/** Loads the vector cache (a damaged line is skipped, never fatal). */
async function loadVectors(repoDir: string): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  let text: string;
  try {
    text = await readFile(vectorsPath(repoDir), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const o = JSON.parse(line) as { h?: unknown; d?: unknown };
      if (typeof o.h !== "string" || typeof o.d !== "string") continue;
      const buf = Buffer.from(o.d, "base64");
      out.set(o.h, new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice());
    } catch {
      // skip a damaged line
    }
  }
  return out;
}

async function appendVectors(repoDir: string, entries: readonly { readonly h: string; readonly v: Float32Array }[]): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(indexDir(repoDir), { recursive: true });
  const lines = entries.map((e) => JSON.stringify({ h: e.h, d: Buffer.from(e.v.buffer, e.v.byteOffset, e.v.byteLength).toString("base64") }));
  await appendFile(vectorsPath(repoDir), `${lines.join("\n")}\n`, "utf8");
}

/** The index's chunks as hits (snippet = the stored one), in path order. Used only to top up a small repo's candidate list. */
async function indexChunks(repoDir: string): Promise<SearchHit[]> {
  const raw = await readRawIndex(repoDir);
  const hits: SearchHit[] = [];
  for (const p of [...raw.linesByPath.keys()].sort()) {
    for (const line of raw.linesByPath.get(p) ?? []) {
      try {
        const c = StoredChunkSchema.parse(JSON.parse(line));
        hits.push({ path: c.p, startLine: c.s, endLine: c.e, symbol: c.sym, score: 0, snippet: c.snip });
      } catch {
        // a damaged chunk line is skipped
      }
    }
  }
  return hits;
}

/** Reciprocal rank fusion of the lexical order and the dense order over the same candidates. Pure. */
export function fuseRanks(lexicalOrder: readonly number[], denseOrder: readonly number[]): number[] {
  const score = new Map<number, number>();
  for (const order of [lexicalOrder, denseOrder]) order.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
}

export interface HybridDeps extends EmbeddingsDeps {
  readonly events?: EventSink;
}

/** Lexical candidates re-ranked by embeddings. */
export class HybridEngine implements CodeSearchEngine {
  readonly name = "hybrid";
  private readonly repoDir: string;
  private readonly lexical: LexicalEngine;
  private readonly cfg: SemanticConfig;
  private readonly deps: HybridDeps;

  constructor(repoDir: string, lexical: LexicalEngine, cfg: SemanticConfig, deps: HybridDeps = {}) {
    this.repoDir = repoDir;
    this.lexical = lexical;
    this.cfg = cfg;
    this.deps = deps;
  }

  refresh(): Promise<void> {
    return this.lexical.refresh();
  }

  async search(query: string, opts: { readonly k?: number } = {}): Promise<EngineAnswer> {
    const t0 = Date.now();
    const k = opts.k ?? 8;
    const lexAnswer = await this.lexical.search(query, { k: this.cfg.candidateLimit });
    const fallback = (cause: string): EngineAnswer => ({ ...lexAnswer, hits: lexAnswer.hits.slice(0, k), engine: "lexical-fallback", confidence: "low", reason: `the embeddings step is not available (${cause}); answered by the local index`, ms: Date.now() - t0 });
    const problem = semanticConfigProblem(this.cfg);
    if (problem !== null) return fallback(problem);
    try {
      const lexHits = lexAnswer.hits;
      const candidates: SearchHit[] = [...lexHits];
      const seen = new Set(candidates.map((h) => `${h.path}:${String(h.startLine)}-${String(h.endLine)}`));
      let topped = 0;
      if (candidates.length < this.cfg.candidateLimit) {
        for (const c of await indexChunks(this.repoDir)) {
          if (candidates.length >= this.cfg.candidateLimit) break;
          const id = `${c.path}:${String(c.startLine)}-${String(c.endLine)}`;
          if (seen.has(id)) continue;
          seen.add(id);
          candidates.push(c);
          topped++;
        }
      }
      if (candidates.length === 0) return { ...lexAnswer, reason: "nothing is indexed yet", ms: Date.now() - t0 };

      const cache = await loadVectors(this.repoDir);
      const texts = candidates.map(embedTextOf);
      const keys = texts.map((t) => keyOf(this.cfg.model, t));
      const qKey = keyOf(this.cfg.model, query);
      const need: { readonly h: string; readonly text: string }[] = [];
      if (!cache.has(qKey)) need.push({ h: qKey, text: query });
      const queued = new Set<string>();
      texts.forEach((text, i) => {
        const h = keys[i] as string;
        if (!cache.has(h) && !queued.has(h)) {
          queued.add(h);
          need.push({ h, text });
        }
      });
      if (need.length > 0) {
        const vectors = await embedTexts({ baseUrl: this.cfg.baseUrl, model: this.cfg.model, apiKeyEnv: this.cfg.apiKeyEnv, timeoutMs: this.cfg.timeoutMs, batchSize: this.cfg.batchSize }, need.map((n) => n.text), this.deps);
        const fresh = need.map((n, i) => ({ h: n.h, v: vectors[i] as Float32Array }));
        for (const f of fresh) cache.set(f.h, f.v);
        await appendVectors(this.repoDir, fresh);
      }
      const q = cache.get(qKey) as Float32Array;
      const dense = candidates.map((_, i) => cosine(q, cache.get(keys[i] as string) as Float32Array));
      const denseOrder = candidates.map((_, i) => i).sort((a, b) => (dense[b] as number) - (dense[a] as number) || a - b);
      const lexicalOrder = candidates.map((_, i) => i); // lexical hits first, in their own order; topped-up chunks after
      const fused = fuseRanks(lexicalOrder.slice(0, lexHits.length), denseOrder).slice(0, k);
      const hits: SearchHit[] = fused.map((id, rank) => ({ ...(candidates[id] as SearchHit), score: 1 / (RRF_K + rank + 1) }));
      const scope = topped > 0 ? `all ${String(candidates.length)} chunks` : `the lexical top ${String(candidates.length)} chunks`;
      return {
        engine: "hybrid",
        hits,
        confidence: "unassessed",
        abstained: false,
        reason: `${scope} re-ranked by embeddings (${this.cfg.model}) and fused with the lexical order; no independent check`,
        signals: null,
        stale: lexAnswer.stale,
        ms: Date.now() - t0,
      };
    } catch (err) {
      const cause = err instanceof EmbeddingsError ? err.message : err instanceof Error ? err.message : String(err);
      return fallback(cause);
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

