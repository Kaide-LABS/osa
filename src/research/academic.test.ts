import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryEventSink } from "../osa/events.ts";
import { isRelevant, rankPapers, runAcademicSearch } from "./academic.ts";
import type { PaperRecord } from "./dedupe.ts";
import { MinIntervalLimiter } from "./net/http.ts";
import type { FetchFn } from "./net/http.ts";

const ARXIV = `<feed>
<entry><id>http://arxiv.org/abs/2001.00001v1</id><title>Vehicle routing with split deliveries</title><summary>We study vehicle routing and split deliveries in depth.</summary><published>2020-01-01T00:00:00Z</published><arxiv:doi>10.5/vrp</arxiv:doi></entry>
<entry><id>http://arxiv.org/abs/2002.00002v1</id><title>Quantum chromodynamics lattice</title><summary>Totally unrelated physics.</summary><published>2020-02-01T00:00:00Z</published></entry>
</feed>`;
const OPENALEX = JSON.stringify({
  results: [
    { id: "https://openalex.org/W1", doi: "https://doi.org/10.5/vrp", title: "Vehicle routing with split deliveries", publication_year: 2020, cited_by_count: 55, abstract_inverted_index: { Vehicle: [0], routing: [1] } },
    { id: "https://openalex.org/W2", doi: "https://doi.org/10.5/or", title: "Operations research for vehicle routing in logistics", publication_year: 2018, cited_by_count: 300 },
  ],
});

const fetchFn: FetchFn = (url) => {
  const host = new URL(url).hostname;
  if (host === "export.arxiv.org") return Promise.resolve(new Response(ARXIV));
  if (host === "api.openalex.org") return Promise.resolve(new Response(OPENALEX));
  return Promise.resolve(new Response("{}", { status: 404 }));
};
const http = { fetchFn, sleepFn: () => Promise.resolve() };

test("academic search: arXiv + OpenAlex merged by DOI, irrelevant hits dropped, ranked by citations, one event per query", async () => {
  const events = new MemoryEventSink();
  const r = await runAcademicSearch({ queries: ["vehicle routing split deliveries"], events, http, env: {}, arxivLimiter: new MinIntervalLimiter(0) });
  assert.equal(r.noneRelevant, false);
  assert.deepEqual(r.papers.map((p) => p.title), ["Operations research for vehicle routing in logistics", "Vehicle routing with split deliveries"]);
  const merged = r.papers.find((p) => p.doi === "10.5/vrp");
  assert.deepEqual([...(merged?.sources ?? [])].sort(), ["arxiv", "openalex"]);
  assert.equal(merged?.citedByCount, 55);
  assert.equal(merged?.arxivId, "2001.00001");
  const e = events.events.filter((x) => x.event === "academic_query");
  assert.equal(e.length, 1);
  assert.equal(e[0]?.data["arxiv"], 2);
  assert.equal(e[0]?.data["openalex"], 2);
  assert.equal(e[0]?.data["semanticScholar"], "skipped");
  assert.equal(e[0]?.data["merged"], 3);
  assert.equal(e[0]?.data["relevant"], 2, "the quantum paper is dropped as irrelevant");
});

test("Semantic Scholar is skipped unless enabled AND keyed; a note says why", async () => {
  const events = new MemoryEventSink();
  const called: string[] = [];
  const spy: FetchFn = (url, init) => {
    called.push(new URL(url).hostname);
    return fetchFn(url, init);
  };
  const noKey = await runAcademicSearch({ queries: ["vehicle routing"], events, http: { ...http, fetchFn: spy }, semanticScholar: true, env: {}, arxivLimiter: new MinIntervalLimiter(0) });
  assert.ok(noKey.notes.some((n) => /S2_API_KEY is not set/.test(n)));
  assert.ok(!called.includes("api.semanticscholar.org"));
  called.length = 0;
  await runAcademicSearch({ queries: ["vehicle routing"], events, http: { ...http, fetchFn: spy }, semanticScholar: false, env: { S2_API_KEY: "k" }, arxivLimiter: new MinIntervalLimiter(0) });
  assert.ok(!called.includes("api.semanticscholar.org"), "off by default even when a key is present");
  called.length = 0;
  await runAcademicSearch({ queries: ["vehicle routing"], events, http: { ...http, fetchFn: spy }, semanticScholar: true, env: { S2_API_KEY: "k" }, arxivLimiter: new MinIntervalLimiter(0) });
  assert.ok(called.includes("api.semanticscholar.org"));
});

test("source failures and an empty result are valid outcomes: logged problems, noneRelevant, no throw", async () => {
  const events = new MemoryEventSink();
  const down: FetchFn = () => Promise.resolve(new Response("nope", { status: 500 }));
  const r = await runAcademicSearch({ queries: ["vehicle routing"], events, http: { fetchFn: down, sleepFn: () => Promise.resolve() }, env: {}, arxivLimiter: new MinIntervalLimiter(0) });
  assert.equal(r.noneRelevant, true);
  assert.ok(r.queries[0]?.problems.length === 2);
  assert.ok(r.notes.some((n) => /valid result, not a failure/.test(n)));
  const none = await runAcademicSearch({ queries: [], events, http, env: {} });
  assert.equal(none.noneRelevant, true);
});

test("the OpenAlex mailto and OPENALEX_API_KEY reach the request", async () => {
  const urls: string[] = [];
  const spy: FetchFn = (url, init) => {
    urls.push(url);
    return fetchFn(url, init);
  };
  await runAcademicSearch({ queries: ["vehicle routing"], events: new MemoryEventSink(), http: { ...http, fetchFn: spy }, openalexMailto: "me@example.com", env: { OPENALEX_API_KEY: "OAK" }, arxivLimiter: new MinIntervalLimiter(0) });
  const oa = new URL(urls.find((u) => u.includes("openalex")) ?? "");
  assert.equal(oa.searchParams.get("mailto"), "me@example.com");
  assert.equal(oa.searchParams.get("api_key"), "OAK");
});

test("isRelevant needs half the query's content words; rankPapers orders by citations then recency", () => {
  const p = (over: Partial<PaperRecord>): PaperRecord => ({ title: "t", authors: [], year: null, abstract: "", doi: null, arxivId: null, url: "u", pdfUrl: null, citedByCount: null, references: [], sources: [], ...over });
  assert.equal(isRelevant("vehicle routing problem", p({ title: "A vehicle routing study" })), true);
  assert.equal(isRelevant("vehicle routing problem", p({ title: "Lattice gauge theory" })), false);
  assert.equal(isRelevant("a the of", p({})), true);
  assert.deepEqual(rankPapers([p({ title: "none", year: 2025 }), p({ title: "low", citedByCount: 1 }), p({ title: "high", citedByCount: 9 }), p({ title: "new", citedByCount: 1, year: 2024 })]).map((x) => x.title), ["high", "new", "low", "none"]);
});
