// Does an embeddings model improve the CBM ranked list? Takes the engine's top-N candidates (with the query rewrite), re-ranks them by embedding similarity, and fuses
// the two orders, then scores each arm against the labels. Needs an OpenAI-compatible embeddings server (for example llama.cpp's llama-server --embedding on localhost).
//
//   node scripts/code-search-embed-eval.ts --endpoint http://127.0.0.1:8089/v1 --model nomic --queries a.json,b.json --rewrites plain.json --out <dir> --tag <name>
//        [--qprefix "search_query: "] [--dprefix "search_document: "] [--candidates 25]
//
// Arms (same candidates in every arm; the top 5 of each ordering is scored):
//   cbm        the engine's own order (control)
//   dense      by cosine similarity of the question and the candidate
//   rrf        reciprocal-rank fusion of the engine's order and the dense order, equal weight
//   rrf+rw     the same, with the dense query being the question PLUS the rewrite's identifiers and keywords
// Embeddings are cached on disk per model, so a rerun costs nothing.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CbmEngine } from "../src/code-index/cbm/engine.ts";
import { LexicalEngine } from "../src/code-index/engine.ts";
import type { EngineAnswer } from "../src/code-index/engine.ts";
import { aggregate, markdownTable, scoreQuery } from "../src/code-index/eval-score.ts";
import type { Label, QueryScore } from "../src/code-index/eval-score.ts";
import { RANKED_PER_CHANNEL, RANKED_TUNING } from "../src/code-index/fusion.ts";
import { embedTextOf } from "../src/code-index/hybrid.ts";
import { tableRewriter } from "../src/code-index/rewrite.ts";
import type { QueryRewrite } from "../src/code-index/rewrite.ts";
import type { SearchHit } from "../src/code-index/search.ts";
import { cosine, embedTexts } from "../src/research/net/embeddings.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}
const endpoint = arg("endpoint", "http://127.0.0.1:8089/v1");
const model = arg("model", "embed");
const qprefix = arg("qprefix", "");
const dprefix = arg("dprefix", "");
const N = Number(arg("candidates", "25"));
const k = 5;
const snapshots = arg("snapshots", "C:/Users/hp/osa-tools/eval-snapshots");
const out = arg("out", "evals/code-search/results");
const tag = arg("tag", "embed");
const rewrites = JSON.parse(readFileSync(arg("rewrites", "evals/code-search/rewrites/plain.json"), "utf8")) as Record<string, QueryRewrite>;
const labels = arg("queries", "evals/code-search/queries.json").split(",").flatMap((f) => (JSON.parse(readFileSync(f, "utf8")) as { queries: (Label & { repo: string })[] }).queries);

const cachePath = `${out}/${tag}.vectors.json`;
const cache: Record<string, number[]> = existsSync(cachePath) ? (JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, number[]>) : {};
const keyOf = (t: string): string => createHash("sha256").update(`${model}\u0000${t}`).digest("hex").slice(0, 24);
async function embed(texts: readonly string[]): Promise<Float32Array[]> {
  const need = [...new Set(texts.filter((t) => cache[keyOf(t)] === undefined))];
  for (let i = 0; i < need.length; i += 16) {
    const batch = need.slice(i, i + 16);
    const v = await embedTexts({ baseUrl: endpoint, model, apiKeyEnv: "", timeoutMs: 180_000, batchSize: 16 }, batch);
    batch.forEach((t, j) => (cache[keyOf(t)] = Array.from(v[j] as Float32Array)));
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache));
  return texts.map((t) => Float32Array.from(cache[keyOf(t)] as number[]));
}

const RRF = 60;
function fuse(lists: readonly (readonly number[])[], weights: readonly number[]): number[] {
  const score = new Map<number, number>();
  lists.forEach((order, li) => order.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + (weights[li] as number) / (RRF + rank + 1))));
  return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
}

const ARMS = ["cbm", "dense", "rrf", "rrf+rw"] as const;
const scores: QueryScore[] = [];
for (const repo of [...new Set(labels.map((l) => l.repo))]) {
  const root = `${snapshots}/${repo}`;
  const lexical = new LexicalEngine(root);
  const cbm = await CbmEngine.open({ repoDir: root, paths: { binaryPath: "C:/osa-cbm/bin/codebase-memory-mcp.exe", workDir: "C:/osa-cbm" }, lexical, tuning: RANKED_TUNING, perChannel: RANKED_PER_CHANNEL, guard: false, rewrite: tableRewriter(rewrites) });
  await lexical.refresh();
  for (const label of labels.filter((l) => l.repo === repo)) {
    const base: EngineAnswer = await cbm.search(label.query, { k: N });
    const hits: readonly SearchHit[] = base.hits;
    const rw = rewrites[label.query];
    const augmented = rw === undefined ? label.query : `${label.query} ${[...rw.identifiers, ...rw.keywords].join(" ")}`;
    const [q, qa] = await embed([`${qprefix}${label.query}`, `${qprefix}${augmented}`]);
    const docs = await embed(hits.map((h) => `${dprefix}${embedTextOf(h)}`));
    const order = (query: Float32Array): number[] => hits.map((_, i) => i).sort((a, b) => cosine(query, docs[b] as Float32Array) - cosine(query, docs[a] as Float32Array) || a - b);
    const cbmOrder = hits.map((_, i) => i);
    const dense = order(q as Float32Array);
    const denseRw = order(qa as Float32Array);
    const arms: Record<(typeof ARMS)[number], number[]> = { cbm: cbmOrder, dense, rrf: fuse([cbmOrder, dense], [1, 1]), "rrf+rw": fuse([cbmOrder, denseRw], [1, 1]) };
    for (const arm of ARMS) scores.push(scoreQuery(label, { ...base, hits: arms[arm].map((i) => hits[i] as SearchHit) }, arm, k));
  }
  await cbm.close();
}

const group = (id: string): string => (id.startsWith("oc-") ? "held-out 30" : "old 40");
const section = (title: string, f: (s: QueryScore) => boolean): string => {
  const rows = ARMS.map((a) => ({ config: a, agg: aggregate(scores.filter((s) => s.config === a && f(s))) }));
  return `### ${title}\n\n${markdownTable(rows)}\n`;
};
const md = [`## Embedding re-rank of the CBM ranked list (${model}, ${String(N)} candidates, ${String(labels.length)} queries, k=${String(k)})`, "", section("all", () => true), section("old 40 (tuned on)", (s) => group(s.id) === "old 40"), section("held-out 30", (s) => group(s.id) === "held-out 30"), ...["exact-name", "paraphrase", "concept", "call-path", "cross-file", "spec-artifact"].map((kd) => section(`kind: ${kd}`, (s) => s.kind === kd))].join("\n");
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/${tag}.md`, md);
writeFileSync(`${out}/${tag}.json`, JSON.stringify({ tag, model, endpoint, candidates: N, scores }, null, 1));
process.stdout.write(md);
