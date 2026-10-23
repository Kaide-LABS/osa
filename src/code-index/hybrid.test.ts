import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { OsaConfig } from "../domain/osa-config.ts";
import { tempGitRepo } from "../osa/fixtures.test.ts";
import type { FetchFn } from "../research/net/http.ts";
import { LexicalEngine } from "./engine.ts";
import { HybridEngine, embedTextOf, fuseRanks, semanticConfigProblem } from "./hybrid.ts";
import { createCodeSearcher } from "./searcher.ts";

const semantic = (over: object = {}) => OsaConfig.parse({ index: { engine: "hybrid", semantic: { baseUrl: "https://embed.example.org/v1", model: "concept-model", ...over } } }).index;

// A fake embeddings model with three CONCEPTS (throttling, identity, storage): a text's vector counts the words of each concept it uses, so two
// texts that share no word but share a concept are close, which is exactly what a lexical index cannot see.
const CONCEPTS = [/throttl|rate|limit|quota|slow down|abus/gi, /login|password|token|session|credential/gi, /sql|database|row|table|persist/gi];
const embed = (text: string): number[] => CONCEPTS.map((re) => (text.match(re) ?? []).length + 0.001);
function fakeFetch(calls: { texts: string[] }[]): FetchFn {
  return (_url, init) => {
    const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
    calls.push({ texts: input });
    return Promise.resolve(new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: embed(t) })) }), { status: 200 }));
  };
}

async function repoWithCode(): Promise<string> {
  const dir = await tempGitRepo();
  await mkdir(`${dir}/src`, { recursive: true });
  await writeFile(`${dir}/src/limiter.ts`, "// caps how many calls one caller may make per minute\nexport function rateLimiter(maxPerMinute: number) {\n  return (calls: number) => calls <= maxPerMinute;\n}\n", "utf8");
  await writeFile(`${dir}/src/session.ts`, "// who is calling\nexport function startSession(user: string, password: string) {\n  return { user, token: password.length };\n}\n", "utf8");
  await writeFile(`${dir}/src/store.ts`, "// keeps the data\nexport function saveRow(table: string, row: object) {\n  return { table, row };\n}\n", "utf8");
  return dir;
}

test("fuseRanks: reciprocal rank fusion of two orders; ties go to the lower candidate number", () => {
  assert.deepEqual(fuseRanks([0, 1, 2], [2, 1, 0]), [0, 2, 1]);
  assert.deepEqual(fuseRanks([0, 1], [0, 1]), [0, 1]);
  assert.deepEqual(fuseRanks([], [3, 1]), [3, 1], "a chunk only the dense order ranked still comes back");
});

test("semanticConfigProblem and embedTextOf are plain and pure", () => {
  assert.match(semanticConfigProblem(semantic({ baseUrl: "" }).semantic) ?? "", /baseUrl and index\.semantic\.model/);
  assert.equal(semanticConfigProblem(semantic().semantic), null);
  const t = embedTextOf({ path: "src/a.ts", symbol: "f", snippet: "x".repeat(5000) });
  assert.ok(t.startsWith("src/a.ts :: f\n") && t.length === 2000);
});

test("a paraphrase that shares no word with the code: the lexical index misses it, the hybrid engine finds it by meaning", async () => {
  const dir = await repoWithCode();
  const calls: { texts: string[] }[] = [];
  const idx = semantic();
  const lexical = new LexicalEngine(dir);
  const query = "slow down abusive clients";
  const plain = await lexical.search(query, { k: 3 });
  assert.notEqual(plain.hits[0]?.path, "src/limiter.ts", "the lexical index has nothing to match on");
  const hybrid = new HybridEngine(dir, lexical, idx.semantic, { fetchFn: fakeFetch(calls), env: {} });
  const answer = await hybrid.search(query, { k: 3 });
  assert.equal(answer.engine, "hybrid");
  assert.equal(answer.hits[0]?.path, "src/limiter.ts");
  assert.match(answer.reason, /all \d+ chunks re-ranked by embeddings \(concept-model\)/);
  assert.equal(answer.confidence, "unassessed");
  assert.ok(answer.hits[0]?.snippet.includes("rateLimiter"), "the snippet is the real code");
});

test("vectors are cached on disk: a second query embeds only itself, and a fresh engine answers a repeated query with no network at all", async () => {
  const dir = await repoWithCode();
  const calls: { texts: string[] }[] = [];
  const idx = semantic();
  const hybrid = new HybridEngine(dir, new LexicalEngine(dir), idx.semantic, { fetchFn: fakeFetch(calls), env: {} });
  await hybrid.search("slow down abusive clients", { k: 3 });
  const firstCalls = calls.length;
  assert.ok(calls.flatMap((c) => c.texts).length > 1, "the first search embedded the query and the chunks");
  await hybrid.search("who may sign in with a password", { k: 3 });
  const second = calls.slice(firstCalls).flatMap((c) => c.texts);
  assert.deepEqual(second, ["who may sign in with a password"], "only the new query was embedded");
  const file = await readFile(`${dir}/.osa/index/vectors.jsonl`, "utf8");
  assert.ok(file.trim().split("\n").length >= 4);
  const offline: FetchFn = () => Promise.reject(new Error("no network"));
  const again = await new HybridEngine(dir, new LexicalEngine(dir), idx.semantic, { fetchFn: offline, env: {} }).search("slow down abusive clients", { k: 3 });
  assert.equal(again.engine, "hybrid", "answered from the cache");
  assert.equal(again.hits[0]?.path, "src/limiter.ts");
});

test("it can never make a search fail: no endpoint, a failing endpoint or a bad answer fall back to the lexical index and say why", async () => {
  const dir = await repoWithCode();
  const query = "session password token";
  const notSet = await new HybridEngine(dir, new LexicalEngine(dir), semantic({ baseUrl: "" }).semantic, { env: {} }).search(query, { k: 3 });
  assert.equal(notSet.engine, "lexical-fallback");
  assert.equal(notSet.confidence, "low");
  assert.match(notSet.reason, /not available \(index\.semantic\.baseUrl/);
  assert.equal(notSet.hits[0]?.path, "src/session.ts", "still a real answer");

  for (const [name, fetchFn] of [
    ["down", (() => Promise.reject(new Error("ECONNREFUSED"))) as FetchFn],
    ["401", (() => Promise.resolve(new Response("no", { status: 401 }))) as FetchFn],
    ["garbage", (() => Promise.resolve(new Response("<html>", { status: 200 }))) as FetchFn],
  ] as const) {
    const a = await new HybridEngine(dir, new LexicalEngine(dir), semantic().semantic, { fetchFn, env: {} }).search(query, { k: 3 });
    assert.equal(a.engine, "lexical-fallback", name);
    assert.match(a.reason, /embeddings step is not available/, name);
    assert.equal(a.hits[0]?.path, "src/session.ts", name);
  }
});

test("the searcher loads the embeddings engine only for index.engine 'hybrid'; the default never touches it", async () => {
  const dir = await repoWithCode();
  const calls: { texts: string[] }[] = [];
  const hybridSearcher = createCodeSearcher({ repoDir: dir, index: semantic(), embeddings: { fetchFn: fakeFetch(calls), env: {} } });
  const a = await hybridSearcher.search("slow down abusive clients", { k: 3, purpose: "test" });
  assert.equal(a.engine, "hybrid");
  assert.ok(calls.length > 0);
  const defaultCalls: { texts: string[] }[] = [];
  const lexicalSearcher = createCodeSearcher({ repoDir: dir, index: OsaConfig.parse({}).index, embeddings: { fetchFn: fakeFetch(defaultCalls), env: {} } });
  const b = await lexicalSearcher.search("session password token", { k: 3, purpose: "test" });
  assert.equal(b.engine, "lexical");
  assert.equal(defaultCalls.length, 0, "no embeddings call unless the engine is hybrid");
});
