// Suite 3 (network boundary), runtime half: OSA's own code may reach exactly the research APIs, on https, with no
// credentials in the URL, and a redirect can never carry a request to another host. The static half (nothing outside
// src/research/net/ can even name the network) is src/verify/network-boundary.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_HOSTS, httpGet, isAllowedUrl } from "./http.ts";
import type { FetchFn } from "./http.ts";
import { searchArxiv } from "./arxiv.ts";
import { getFile, getReadme, listRoot, searchRepos } from "./github.ts";
import { searchOpenAlex } from "./openalex.ts";
import { searchSemanticScholar } from "./semantic-scholar.ts";

function recorder(respond: (url: string) => Response): { fetchFn: FetchFn; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetchFn: (url) => {
      urls.push(url);
      return Promise.resolve(respond(url));
    },
  };
}

test("the allowlist is exactly the free research APIs -- adding a host is a deliberate, visible edit", () => {
  assert.deepEqual([...ALLOWED_HOSTS].sort(), ["api.github.com", "api.openalex.org", "api.semanticscholar.org", "export.arxiv.org"]);
});

test("isAllowedUrl: https + exact host only; look-alikes, plain http, credentials, odd ports, IPs and junk are refused", () => {
  for (const ok of ["https://export.arxiv.org/api/query?search_query=x", "https://api.openalex.org/works?q=1", "https://api.github.com/search/repositories?q=x", "https://API.GITHUB.COM/x"]) {
    assert.equal(isAllowedUrl(ok), true, ok);
  }
  for (const bad of [
    "http://api.github.com/x",
    "https://api.github.com.evil.example/x",
    "https://evil-api.github.com/x",
    "https://github.com/x",
    "https://arxiv.org/abs/1",
    "https://user:pw@api.github.com/x",
    "https://api.github.com:8443/x",
    "https://127.0.0.1/x",
    "https://169.254.169.254/latest/meta-data",
    "ftp://api.github.com/x",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "//api.github.com/x",
    "not a url",
    "",
  ]) {
    assert.equal(isAllowedUrl(bad), false, bad);
  }
});

test("httpGet refuses a non-allowlisted host WITHOUT making the request", async () => {
  const rec = recorder(() => new Response("secret"));
  for (const url of ["https://evil.example/exfil?d=1", "http://api.github.com/x", "https://metadata.google.internal/computeMetadata/v1/"]) {
    const r = await httpGet(url, {}, { fetchFn: rec.fetchFn });
    assert.equal(r.kind, "error", url);
    assert.match(r.kind === "error" ? r.message : "", /refused: .* is not on the research host allowlist/, url);
  }
  assert.deepEqual(rec.urls, [], "not one request left the process");
});

test("a redirect from an allowed host to another host is refused at the hop; a redirect within the allowlist is followed", async () => {
  const evil = recorder((url) => (url.startsWith("https://api.github.com/") ? new Response("", { status: 302, headers: { location: "https://evil.example/steal" } }) : new Response("leaked")));
  const r = await httpGet("https://api.github.com/repos/o/r/readme", {}, { fetchFn: evil.fetchFn });
  assert.equal(r.kind, "error");
  assert.match(r.kind === "error" ? r.message : "", /refused: evil\.example/);
  assert.deepEqual(evil.urls, ["https://api.github.com/repos/o/r/readme"], "the second hop was never requested");

  const fine = recorder((url) => (url.endsWith("/old") ? new Response("", { status: 301, headers: { location: "/repositories/42/readme" } }) : new Response("# readme")));
  const ok = await httpGet("https://api.github.com/repos/o/old", {}, { fetchFn: fine.fetchFn });
  assert.equal(ok.kind, "ok");
  assert.deepEqual(fine.urls, ["https://api.github.com/repos/o/old", "https://api.github.com/repositories/42/readme"]);

  const loop = recorder(() => new Response("", { status: 302, headers: { location: "/again" } }));
  const l = await httpGet("https://api.github.com/x", {}, { fetchFn: loop.fetchFn });
  assert.equal(l.kind, "error");
  assert.match(l.kind === "error" ? l.message : "", /too many redirects/);
  assert.equal(loop.urls.length, 4, "the first request plus at most three hops");
});

test("every research client, run for real against a recording fetch, contacts only allowlisted hosts", async () => {
  const rec = recorder((url) => {
    if (url.includes("arxiv")) return new Response("<feed></feed>");
    if (url.includes("openalex")) return new Response(JSON.stringify({ results: [] }));
    if (url.includes("semanticscholar")) return new Response(JSON.stringify({ data: [] }));
    if (url.endsWith("/readme")) return new Response("# r");
    if (url.includes("/contents/")) return new Response("[]");
    return new Response(JSON.stringify({ items: [] }));
  });
  const deps = { fetchFn: rec.fetchFn, sleepFn: () => Promise.resolve() };
  await searchArxiv("word segmentation", {}, deps);
  await searchOpenAlex("word segmentation", {}, deps);
  await searchSemanticScholar("word segmentation", "key", 5, deps);
  await searchRepos("word count", {}, 5, deps);
  await getReadme("o/r", {}, 6000, deps);
  await listRoot("o/r", {}, deps);
  await getFile("o/r", "package.json", {}, 4000, deps);
  assert.ok(rec.urls.length >= 7, `expected every client to make a request, saw ${String(rec.urls.length)}`);
  for (const u of rec.urls) assert.ok(isAllowedUrl(u), `non-allowlisted request: ${u}`);
  assert.deepEqual([...new Set(rec.urls.map((u) => new URL(u).hostname))].sort(), ["api.github.com", "api.openalex.org", "api.semanticscholar.org", "export.arxiv.org"]);
});

test("a hostile repo name cannot move a GitHub request to another host (the host is fixed; the name is only path)", async () => {
  const rec = recorder(() => new Response("[]"));
  const deps = { fetchFn: rec.fetchFn, sleepFn: () => Promise.resolve() };
  for (const name of ["evil.example/x@evil.example", "o/r?x=https://evil.example", "o/r#@evil.example", "..%2f..%2f@evil.example"]) {
    await getReadme(name, {}, 6000, deps);
  }
  for (const u of rec.urls) assert.equal(new URL(u).hostname, "api.github.com", u);
});
