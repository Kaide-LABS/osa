// Tests for the research network layer. No test touches the network: fetch, sleep and the clock are fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MinIntervalLimiter, httpGet, parseWaitMs } from "./http.ts";
import type { FetchFn, HttpDeps } from "./http.ts";
import { ARXIV_MIN_INTERVAL_MS, buildArxivQuery, normaliseArxivId, parseArxivFeed, searchArxiv } from "./arxiv.ts";
import { normaliseDoi, parseOpenAlexWork, reconstructAbstract, searchOpenAlex } from "./openalex.ts";
import { getReadme, parseRepoSearch, pickKeyFiles, searchRepos } from "./github.ts";
import { parseS2Paper, searchSemanticScholar } from "./semantic-scholar.ts";

/** A virtual clock: `sleep` advances time instead of waiting. */
function virtualTime() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const deps: HttpDeps = {
    nowFn: () => t,
    sleepFn: (ms) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
  };
  return { deps, sleeps, now: () => t, advance: (ms: number) => void (t += ms) };
}

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: string; headers?: Record<string, string> } | Error): { fetchFn: FetchFn; calls: { url: string; init?: RequestInit | undefined }[] } {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetchFn: FetchFn = (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers ?? {} }));
  };
  return { fetchFn, calls };
}

const ARXIV_XML = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/1612.01691v2</id>
    <title>Fleet Size and Mix
      Split-Delivery &amp; Routing</title>
    <link href="https://arxiv.org/abs/1612.01691v2" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/1612.01691v2" rel="related" type="application/pdf" title="pdf"/>
    <summary>In the classic VRP a fleet has to visit customers.
  We study a rich variant.</summary>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
    <category term="math.OC" scheme="http://arxiv.org/schemas/atom"/>
    <published>2016-12-06T07:46:41Z</published>
    <arxiv:doi>10.1000/XYZ.1</arxiv:doi>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan  Turing</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/cs/0112017v1</id>
    <title>Old style id</title>
    <summary>x</summary>
    <published>2001-12-01T00:00:00Z</published>
  </entry>
</feed>`;

test("httpGet: ok result carries status, text and headers", async () => {
  const { fetchFn } = fakeFetch(() => ({ body: "hello", headers: { "x-test": "1" } }));
  const r = await httpGet("https://api.github.com/a", {}, { fetchFn });
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") {
    assert.equal(r.text, "hello");
    assert.equal(r.headers.get("x-test"), "1");
  }
});

test("httpGet: 429 with Retry-After backs off for that long, then retries and succeeds", async () => {
  const vt = virtualTime();
  let n = 0;
  const { fetchFn, calls } = fakeFetch(() => (++n === 1 ? { status: 429, headers: { "retry-after": "2" } } : { body: "fine" }));
  const r = await httpGet("https://api.github.com/a", {}, { ...vt.deps, fetchFn });
  assert.equal(r.kind, "ok");
  assert.deepEqual(vt.sleeps, [2000]);
  assert.equal(calls.length, 2);
});

test("httpGet: a rate limit asking for longer than the back-off cap is returned, not slept through", async () => {
  const vt = virtualTime();
  const { fetchFn, calls } = fakeFetch(() => ({ status: 429, headers: { "retry-after": "600" } }));
  const r = await httpGet("https://api.github.com/a", { maxBackoffMs: 30_000 }, { ...vt.deps, fetchFn });
  assert.equal(r.kind, "rate_limited");
  if (r.kind === "rate_limited") assert.equal(r.retryAfterMs, 600_000);
  assert.deepEqual(vt.sleeps, []);
  assert.equal(calls.length, 1);
});

test("httpGet: GitHub 403 with X-RateLimit-Remaining 0 waits until X-RateLimit-Reset", async () => {
  const vt = virtualTime();
  let n = 0;
  const resetEpochSecs = Math.floor(vt.now() / 1000) + 5;
  const { fetchFn } = fakeFetch(() => (++n === 1 ? { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetEpochSecs) } } : { body: "{}" }));
  const r = await httpGet("https://api.github.com/x", {}, { ...vt.deps, fetchFn });
  assert.equal(r.kind, "ok");
  assert.equal(vt.sleeps.length, 1);
  assert.ok((vt.sleeps[0] ?? 0) >= 4000 && (vt.sleeps[0] ?? 0) <= 5000, `slept ${String(vt.sleeps[0])}`);
});

test("httpGet: a plain 403 (not a rate limit) is an error, not a retry; a thrown fetch is an error result, never a throw", async () => {
  const a = await httpGet("https://api.github.com/a", {}, { fetchFn: fakeFetch(() => ({ status: 403, body: "forbidden" })).fetchFn });
  assert.equal(a.kind, "error");
  const b = await httpGet("https://api.github.com/a", {}, { fetchFn: fakeFetch(() => new Error("ECONNRESET")).fetchFn });
  assert.deepEqual(b, { kind: "error", status: null, message: "ECONNRESET" });
});

test("parseWaitMs: Retry-After seconds and HTTP-date, reset epoch, and nothing", () => {
  assert.equal(parseWaitMs(new Headers({ "retry-after": "3" }), 0), 3000);
  assert.equal(parseWaitMs(new Headers({ "retry-after": new Date(10_000).toUTCString() }), 4_000), 6000);
  assert.equal(parseWaitMs(new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "100" }), 90_000), 10_000);
  assert.equal(parseWaitMs(new Headers(), 0), null);
});

test("MinIntervalLimiter: serialises calls and spaces their starts by at least the minimum", async () => {
  const vt = virtualTime();
  const lim = new MinIntervalLimiter(3000, vt.deps);
  const starts: number[] = [];
  let running = 0;
  let maxRunning = 0;
  const job = async (): Promise<void> => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    starts.push(vt.now());
    await Promise.resolve();
    running -= 1;
  };
  await Promise.all([lim.schedule(job), lim.schedule(job), lim.schedule(job)]);
  assert.equal(maxRunning, 1, "single connection: never two at once");
  assert.equal(starts.length, 3);
  assert.ok((starts[1] ?? 0) - (starts[0] ?? 0) >= 3000);
  assert.ok((starts[2] ?? 0) - (starts[1] ?? 0) >= 3000);
});

test("MinIntervalLimiter: a failing job does not wedge the queue", async () => {
  const lim = new MinIntervalLimiter(0, virtualTime().deps);
  await assert.rejects(lim.schedule(() => Promise.reject(new Error("boom"))));
  assert.equal(await lim.schedule(() => Promise.resolve(7)), 7);
});

test("arXiv: feed parsing (entities, whitespace, pdf link, version-less ids, old-style ids, authors, doi)", () => {
  const papers = parseArxivFeed(ARXIV_XML);
  assert.equal(papers.length, 2);
  const p = papers[0];
  assert.equal(p?.arxivId, "1612.01691");
  assert.equal(p?.title, "Fleet Size and Mix Split-Delivery & Routing");
  assert.equal(p?.abstract, "In the classic VRP a fleet has to visit customers. We study a rich variant.");
  assert.equal(p?.pdfUrl, "https://arxiv.org/pdf/1612.01691v2");
  assert.deepEqual(p?.authors, ["Ada Lovelace", "Alan Turing"]);
  assert.deepEqual(p?.categories, ["cs.AI", "math.OC"]);
  assert.equal(p?.doi, "10.1000/XYZ.1");
  assert.equal(p?.published, "2016-12-06T07:46:41Z");
  assert.equal(papers[1]?.arxivId, "cs/0112017");
  assert.equal(papers[1]?.pdfUrl, null);
  assert.equal(normaliseArxivId("http://arxiv.org/abs/2101.00001v13"), "2101.00001");
});

test("arXiv: query building ANDs content words and drops stop words", () => {
  assert.equal(buildArxivQuery("How to use the vehicle routing problem"), "all:vehicle+AND+all:routing+AND+all:problem");
  assert.equal(buildArxivQuery("a the of"), "");
});

test("arXiv: consecutive searches are >= 3 s apart on one shared limiter (WS3.5 rate-limit spacing)", async () => {
  const vt = virtualTime();
  const limiter = new MinIntervalLimiter(ARXIV_MIN_INTERVAL_MS, vt.deps);
  const starts: number[] = [];
  const { fetchFn } = fakeFetch(() => {
    starts.push(vt.now());
    return { body: ARXIV_XML };
  });
  const deps = { ...vt.deps, fetchFn };
  const r1 = await searchArxiv("vehicle routing", { limiter }, deps);
  await Promise.all([searchArxiv("fleet mix", { limiter }, deps), searchArxiv("split delivery", { limiter }, deps)]);
  assert.equal(r1.records.length, 2);
  assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok((starts[i] ?? 0) - (starts[i - 1] ?? 0) >= ARXIV_MIN_INTERVAL_MS, `gap ${String(i)}`);
});

test("arXiv: arXiv ANDs every word, so a query that finds nothing is narrowed (6 -> 4 -> 3 -> 2 words) until something is found; a two-word query is asked once", async () => {
  const empty = `<feed></feed>`;
  const urls: string[] = [];
  const { fetchFn } = fakeFetch((url) => {
    urls.push(url);
    return { body: url.includes("all:rate+AND+all:limiting") && !url.includes("all:algorithm") ? ARXIV_XML : empty };
  });
  const deps = { fetchFn };
  const limiter = new MinIntervalLimiter(0);
  const r = await searchArxiv("token bucket rate limiting algorithm analysis", { limiter }, deps);
  assert.equal(r.records.length, 2, "found on a narrower query");
  assert.equal(r.problem, null);
  assert.deepEqual(urls.map((u) => (u.match(/all:/g) ?? []).length), [6, 4], "6 words found nothing, 4 words found papers, so it stopped");
  urls.length = 0;
  const none = await searchArxiv("zzqx qqzv", { limiter }, deps);
  assert.deepEqual(none.records, []);
  assert.equal(urls.length, 1, "a two-word query cannot be narrowed: one request");
});

test("arXiv: an empty query makes no request; an HTTP failure becomes a problem, not a throw", async () => {
  const { fetchFn, calls } = fakeFetch(() => ({ status: 500, body: "oops" }));
  const empty = await searchArxiv("a the", {}, { fetchFn });
  assert.equal(empty.problem, "query had no searchable words");
  assert.equal(calls.length, 0);
  const failed = await searchArxiv("vehicle routing", { limiter: new MinIntervalLimiter(0) }, { fetchFn });
  assert.match(failed.problem ?? "", /HTTP 500/);
  assert.deepEqual(failed.records, []);
});

test("OpenAlex: abstract reconstruction from the inverted index", () => {
  assert.equal(reconstructAbstract({ The: [0, 3], Vehicle: [1], Routing: [2], end: [4] }), "The Vehicle Routing The end");
  assert.equal(reconstructAbstract(null), "");
  assert.equal(reconstructAbstract({ bad: "x", ok: [0] }), "ok");
});

test("OpenAlex: work parsing (doi normalisation, OA pdf, arXiv id from landing page, references, authors)", () => {
  const w = parseOpenAlexWork({
    id: "https://openalex.org/W1",
    doi: "https://doi.org/10.1137/1.9780898718515",
    title: "The Vehicle Routing Problem",
    publication_year: 2002,
    cited_by_count: 4047,
    abstract_inverted_index: { The: [0], VRP: [1] },
    best_oa_location: { landing_page_url: "https://arxiv.org/abs/1612.01691v1", pdf_url: "https://arxiv.org/pdf/1612.01691v1" },
    open_access: { oa_url: "https://other.example/pdf" },
    referenced_works: ["https://openalex.org/W2", 3],
    authorships: [{ author: { display_name: "P. Toth" } }, { author: {} }],
  });
  assert.equal(w?.doi, "10.1137/1.9780898718515");
  assert.equal(w?.citedByCount, 4047);
  assert.equal(w?.abstract, "The VRP");
  assert.equal(w?.oaPdfUrl, "https://arxiv.org/pdf/1612.01691v1");
  assert.equal(w?.arxivId, "1612.01691");
  assert.deepEqual(w?.referencedWorks, ["https://openalex.org/W2"]);
  assert.deepEqual(w?.authors, ["P. Toth"]);
  assert.equal(parseOpenAlexWork({ id: "x" }), null);
  assert.equal(normaliseDoi("DOI:10.1/ABC"), "10.1/abc");
});

test("OpenAlex: search sends mailto and api_key when configured, omits them otherwise", async () => {
  const { fetchFn, calls } = fakeFetch(() => ({ body: JSON.stringify({ results: [{ id: "https://openalex.org/W1", title: "T" }] }) }));
  const a = await searchOpenAlex("vrp", { mailto: "me@example.com", apiKey: "K" }, { fetchFn });
  assert.equal(a.records.length, 1);
  const u = new URL(calls[0]?.url ?? "");
  assert.equal(u.hostname, "api.openalex.org");
  assert.equal(u.searchParams.get("mailto"), "me@example.com");
  assert.equal(u.searchParams.get("api_key"), "K");
  assert.equal(u.searchParams.get("search"), "vrp");
  await searchOpenAlex("vrp", {}, { fetchFn });
  const u2 = new URL(calls[1]?.url ?? "");
  assert.equal(u2.searchParams.get("mailto"), null);
  assert.equal(u2.searchParams.get("api_key"), null);
});

test("OpenAlex: an exhausted free budget degrades to an empty result with a pointer to OPENALEX_API_KEY", async () => {
  const { fetchFn } = fakeFetch(() => ({ status: 429, headers: { "retry-after": "86400" } }));
  const r = await searchOpenAlex("vrp", {}, { fetchFn });
  assert.deepEqual(r.records, []);
  assert.match(r.problem ?? "", /OPENALEX_API_KEY/);
});

test("GitHub: repo-search parsing; token only sent when set; README fetched raw and truncated", async () => {
  const body = JSON.stringify({ items: [{ full_name: "a/b", html_url: "https://github.com/a/b", description: "d", stargazers_count: 9, language: "TypeScript", updated_at: "2026-01-01T00:00:00Z", license: { spdx_id: "MIT" } }, { nope: 1 }] });
  assert.equal(parseRepoSearch(body).length, 1);
  assert.deepEqual(parseRepoSearch("not json"), []);
  const f = fakeFetch((url) => (url.includes("/readme") ? { body: "R".repeat(100) } : { body }));
  const noToken = await searchRepos("word count", {}, 5, { fetchFn: f.fetchFn });
  assert.equal(noToken.records[0]?.license, "MIT");
  assert.equal((f.calls[0]?.init?.headers as Record<string, string>)["Authorization"], undefined);
  await searchRepos("word count", { token: "tok" }, 5, { fetchFn: f.fetchFn });
  assert.equal((f.calls[1]?.init?.headers as Record<string, string>)["Authorization"], "Bearer tok");
  assert.equal((await getReadme("a/b", {}, 10, { fetchFn: f.fetchFn }))?.length, 10);
  assert.deepEqual(pickKeyFiles(["README.md", "package.json", "src", "tsconfig.json", "Makefile"], 2), ["package.json", "Makefile"]);
});

test("Semantic Scholar: parsing; sends the key header", async () => {
  assert.equal(parseS2Paper({ paperId: "p", title: "T", year: 2020, citationCount: 3, externalIds: { DOI: "10.1/X", ArXiv: "2001.00001" }, openAccessPdf: { url: "https://pdf" }, authors: [{ name: "A" }] })?.doi, "10.1/x");
  assert.equal(parseS2Paper({ title: "no id" }), null);
  const { fetchFn, calls } = fakeFetch(() => ({ body: JSON.stringify({ data: [{ paperId: "p", title: "T" }] }) }));
  const r = await searchSemanticScholar("vrp", "KEY", 5, { fetchFn });
  assert.equal(r.records.length, 1);
  assert.equal((calls[0]?.init?.headers as Record<string, string>)["x-api-key"], "KEY");
});
