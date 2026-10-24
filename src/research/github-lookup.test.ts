import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryEventSink } from "../osa/events.ts";
import { runGithubLookup, simplifyQuery } from "./github-lookup.ts";
import type { FetchFn } from "./net/http.ts";

const REPO = JSON.stringify({ items: [{ full_name: "o/wc", html_url: "https://github.com/o/wc", description: "word count", stargazers_count: 10, language: "JavaScript", updated_at: "2026-01-01T00:00:00Z", license: { spdx_id: "MIT" } }] });

test("simplifyQuery keeps at most three meaningful words and drops filler", () => {
  assert.equal(simplifyQuery("node cli word count fs no dependencies"), "node cli word");
  assert.equal(simplifyQuery("nodejs wc clone standard library"), "nodejs wc clone");
  assert.equal(simplifyQuery("the and of"), "");
  assert.equal(simplifyQuery("C++ parser"), "c++ parser");
});

test("a query that matches nothing is retried once in simplified form (found live: two long queries found 0 repositories)", async () => {
  const seen: string[] = [];
  const fetchFn: FetchFn = (url) => {
    const u = new URL(url);
    if (u.pathname === "/search/repositories") {
      const q = u.searchParams.get("q") ?? "";
      seen.push(q);
      return Promise.resolve(new Response(q === "node cli word" ? REPO : JSON.stringify({ items: [] })));
    }
    if (u.pathname.endsWith("/readme")) return Promise.resolve(new Response("# wc"));
    return Promise.resolve(new Response("[]"));
  };
  const events = new MemoryEventSink();
  const r = await runGithubLookup({ queries: ["node cli word count fs no dependencies"], events, env: {}, http: { fetchFn, sleepFn: () => Promise.resolve() } });
  assert.deepEqual(seen, ["node cli word count fs no dependencies", "node cli word"]);
  assert.equal(r.repos.length, 1);
  assert.ok(r.notes.some((n) => /retried as "node cli word"/.test(n)));
  assert.equal(events.events.find((e) => e.event === "github_lookup")?.data["reposInspected"], 1);
});

test("no retry when the first query already matched, or when simplifying changes nothing, or on an HTTP problem", async () => {
  const seen: string[] = [];
  const hit: FetchFn = (url) => {
    const u = new URL(url);
    if (u.pathname === "/search/repositories") seen.push(u.searchParams.get("q") ?? "");
    return Promise.resolve(new Response(u.pathname === "/search/repositories" ? REPO : "[]"));
  };
  await runGithubLookup({ queries: ["node cli word count fs no dependencies"], events: new MemoryEventSink(), env: {}, http: { fetchFn: hit, sleepFn: () => Promise.resolve() } });
  assert.equal(seen.length, 1);

  const empty: FetchFn = (url) => {
    if (new URL(url).pathname === "/search/repositories") seen.push("x");
    return Promise.resolve(new Response(JSON.stringify({ items: [] })));
  };
  seen.length = 0;
  await runGithubLookup({ queries: ["node cli"], events: new MemoryEventSink(), env: {}, http: { fetchFn: empty, sleepFn: () => Promise.resolve() } });
  assert.equal(seen.length, 1, "a query that is already simple is not retried");

  seen.length = 0;
  const down: FetchFn = () => {
    seen.push("x");
    return Promise.resolve(new Response("nope", { status: 500 }));
  };
  const r = await runGithubLookup({ queries: ["node cli word count fs no dependencies"], events: new MemoryEventSink(), env: {}, http: { fetchFn: down, sleepFn: () => Promise.resolve() } });
  assert.equal(seen.length, 1, "an HTTP failure is reported, not retried with a different query");
  assert.ok(r.problems.length > 0);
});

test("the GitHub token is OSA_GITHUB_TOKEN first and GITHUB_TOKEN second, sent as a bearer token; with neither the note says which names to use", async () => {
  const auth: (string | null)[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get("authorization"));
    return Promise.resolve(new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200, headers: { "content-type": "application/json" } }));
  }) as never;
  const http = { fetchFn, sleepFn: () => Promise.resolve() };
  const allAre = (v: string): boolean => auth.length > 0 && auth.every((a) => (a as string | null) === v);
  await runGithubLookup({ queries: ["node cli"], events: new MemoryEventSink(), env: { OSA_GITHUB_TOKEN: "osa-token", GITHUB_TOKEN: "global-token" }, http });
  assert.ok(allAre("Bearer osa-token"), `OSA_GITHUB_TOKEN wins: ${JSON.stringify(auth)}`);
  auth.length = 0;
  await runGithubLookup({ queries: ["node cli"], events: new MemoryEventSink(), env: { GITHUB_TOKEN: "global-token" }, http });
  assert.ok(allAre("Bearer global-token"), "the global name still works");
  const none = await runGithubLookup({ queries: ["node cli"], events: new MemoryEventSink(), env: {}, http });
  assert.match(none.notes.join(" "), /OSA_GITHUB_TOKEN or GITHUB_TOKEN/);
});
