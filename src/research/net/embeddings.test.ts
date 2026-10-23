import assert from "node:assert/strict";
import { test } from "node:test";
import { EmbeddingsError, cosine, embedTexts, embeddingsEndpoint } from "./embeddings.ts";
import type { EmbeddingsConfig } from "./embeddings.ts";
import type { FetchFn } from "./http.ts";

const cfg = (over: Partial<EmbeddingsConfig> = {}): EmbeddingsConfig => ({ baseUrl: "https://embed.example.org/v1", model: "m-1", apiKeyEnv: "TEST_EMBED_KEY", timeoutMs: 1000, batchSize: 64, ...over });
const ok = (vectors: number[][], shuffled = false): Response => {
  const data = vectors.map((embedding, index) => ({ index, embedding }));
  return new Response(JSON.stringify({ data: shuffled ? [...data].reverse() : data }), { status: 200 });
};

test("embeddingsEndpoint: https is required except for localhost; credentials, a query and a fragment are refused; the path is kept", () => {
  assert.equal(embeddingsEndpoint("https://embed.example.org/v1"), "https://embed.example.org/v1/embeddings");
  assert.equal(embeddingsEndpoint("https://embed.example.org/v1/"), "https://embed.example.org/v1/embeddings");
  assert.equal(embeddingsEndpoint("https://embed.example.org"), "https://embed.example.org/embeddings");
  assert.equal(embeddingsEndpoint("http://localhost:11434/v1"), "http://localhost:11434/v1/embeddings", "a local server needs no tls");
  assert.equal(embeddingsEndpoint("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1/embeddings");
  for (const bad of ["not a url", "http://embed.example.org/v1", "ftp://x.example/v1", "https://user:pw@embed.example.org/v1", "https://embed.example.org/v1?key=abc", "https://embed.example.org/v1#frag"]) {
    assert.throws(() => embeddingsEndpoint(bad), EmbeddingsError, bad);
  }
});

test("embedTexts: one vector per text in input order (even if the API answers out of order), sent as an OpenAI-compatible request with the key from the NAMED variable", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = (url, init) => {
    seen.push({ url, init: init ?? {} });
    return Promise.resolve(ok([[1, 0], [0, 1], [1, 1]], true));
  };
  const v = await embedTexts(cfg(), ["a", "b", "c"], { fetchFn, env: { TEST_EMBED_KEY: "sekret-value" } });
  assert.deepEqual(v.map((x) => [...x]), [[1, 0], [0, 1], [1, 1]]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "https://embed.example.org/v1/embeddings");
  assert.equal(seen[0]?.init.method, "POST");
  assert.equal(seen[0]?.init.redirect, "error", "an endpoint that redirects is not the one that was configured");
  assert.deepEqual(JSON.parse(String(seen[0]?.init.body)), { model: "m-1", input: ["a", "b", "c"] });
  assert.equal((seen[0]?.init.headers as Record<string, string>)["authorization"], "Bearer sekret-value");
});

test("embedTexts: no key variable named, or the variable unset, sends no Authorization header (a local server)", async () => {
  const headers: Record<string, string>[] = [];
  const fetchFn: FetchFn = (_u, init) => {
    headers.push(init?.headers as Record<string, string>);
    return Promise.resolve(ok([[1]]));
  };
  await embedTexts(cfg({ apiKeyEnv: "" }), ["a"], { fetchFn, env: { TEST_EMBED_KEY: "x" } });
  await embedTexts(cfg(), ["a"], { fetchFn, env: {} });
  assert.ok(headers.every((h) => h["authorization"] === undefined));
});

test("embedTexts: texts are sent in batches of batchSize and the vectors come back in order", async () => {
  const batches: string[][] = [];
  const fetchFn: FetchFn = (_u, init) => {
    const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
    batches.push(input);
    return Promise.resolve(ok(input.map((t) => [t.length])));
  };
  const v = await embedTexts(cfg({ batchSize: 2 }), ["a", "bb", "ccc", "dddd", "eeeee"], { fetchFn, env: {} });
  assert.deepEqual(batches, [["a", "bb"], ["ccc", "dddd"], ["eeeee"]]);
  assert.deepEqual(v.map((x) => x[0]), [1, 2, 3, 4, 5]);
  assert.deepEqual(await embedTexts(cfg(), [], { fetchFn, env: {} }), [], "nothing to embed, nothing sent");
});

test("embedTexts: every failure is an EmbeddingsError that never contains the key", async () => {
  const run = (fetchFn: FetchFn, c: EmbeddingsConfig = cfg()) => embedTexts(c, ["a", "b"], { fetchFn, env: { TEST_EMBED_KEY: "sekret-value" } });
  const status401 = await run(() => Promise.resolve(new Response("nope", { status: 401 }))).catch((e: unknown) => e);
  assert.ok(status401 instanceof EmbeddingsError && status401.status === 401);
  assert.match(status401.message, /401.*TEST_EMBED_KEY/, "names the variable to check, not its value");
  const refused = await run(() => Promise.reject(new Error("connect ECONNREFUSED while sending Bearer sekret-value"))).catch((e: unknown) => e);
  assert.ok(refused instanceof EmbeddingsError);
  assert.doesNotMatch(refused.message, /sekret-value/);
  for (const [name, res] of [
    ["not json", new Response("<html>", { status: 200 })],
    ["wrong count", ok([[1]])],
    ["empty vector", ok([[1], []])],
    ["not numbers", new Response(JSON.stringify({ data: [{ index: 0, embedding: ["x"] }, { index: 1, embedding: [1] }] }), { status: 200 })],
    ["mixed sizes", ok([[1, 2], [1]])],
    ["no data", new Response("{}", { status: 200 })],
  ] as const) {
    await assert.rejects(run(() => Promise.resolve(res.clone())), EmbeddingsError, name);
  }
  await assert.rejects(run(() => Promise.resolve(ok([[1], [1]])), cfg({ model: "" })), /model is not set/);
  await assert.rejects(run(() => Promise.resolve(ok([[1], [1]])), cfg({ baseUrl: "http://embed.example.org/v1" })), /https/);
});

test("embedTexts: a call that gets no answer within timeoutMs is abandoned with a plain message", async () => {
  const hang: FetchFn = (_u, init) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const t0 = Date.now();
  await assert.rejects(embedTexts(cfg({ timeoutMs: 1000 }), ["a"], { fetchFn: hang, env: {} }), /no answer within 1000 ms/);
  assert.ok(Date.now() - t0 < 5000);
});

test("cosine: 1 for parallel, 0 for orthogonal, -1 for opposite; 0 for mismatched or empty or zero vectors", () => {
  assert.ok(Math.abs(cosine(Float32Array.of(1, 2), Float32Array.of(2, 4)) - 1) < 1e-6);
  assert.equal(cosine(Float32Array.of(1, 0), Float32Array.of(0, 1)), 0);
  assert.ok(Math.abs(cosine(Float32Array.of(1, 0), Float32Array.of(-1, 0)) + 1) < 1e-6);
  assert.equal(cosine(Float32Array.of(1), Float32Array.of(1, 2)), 0);
  assert.equal(cosine(Float32Array.of(), Float32Array.of()), 0);
  assert.equal(cosine(Float32Array.of(0, 0), Float32Array.of(1, 1)), 0);
});
