// Suite 5: a 429/503 is backed off AND logged (it used to be silent), and a GitHub rate limit degrades to a logged "none found" --
// never a crash, and never mislabelled as "no repositories matched".

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryEventSink } from "../../osa/events.ts";
import { runAcademicSearch } from "../academic.ts";
import { runGithubLookup } from "../github-lookup.ts";
import { MinIntervalLimiter, httpGet } from "./http.ts";
import type { FetchFn, HttpEvent } from "./http.ts";

function seq(responses: { status: number; headers?: Record<string, string>; body?: string }[]): { fetchFn: FetchFn; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetchFn: FetchFn = (url) => {
    calls.push(url);
    const r = responses[Math.min(i, responses.length - 1)] as { status: number; headers?: Record<string, string>; body?: string };
    i += 1;
    return Promise.resolve(new Response(r.body ?? "", { status: r.status, headers: r.headers ?? {} }));
  };
  return { fetchFn, calls };
}
const noSleep = { sleepFn: () => Promise.resolve() };

test("httpGet reports every rate-limit back-off to onEvent: the host, status, attempt and how long it will wait", async () => {
  const events: HttpEvent[] = [];
  const f = seq([{ status: 503, headers: { "retry-after": "2" } }, { status: 429, headers: { "retry-after": "4" } }, { status: 200, body: "ok" }]);
  const r = await httpGet("https://export.arxiv.org/api/query?x=1", {}, { ...f, ...noSleep, onEvent: (e) => events.push(e) });
  assert.equal(r.kind, "ok");
  assert.deepEqual(events.map((e) => [e.host, e.status, e.attempt, e.waitMs, e.action]), [
    ["export.arxiv.org", 503, 1, 2000, "retrying"],
    ["export.arxiv.org", 429, 2, 4000, "retrying"],
  ]);
});

test("httpGet reports giving up (attempts exhausted, or a wait longer than the cap) so the log never shows silence", async () => {
  const exhausted: HttpEvent[] = [];
  await httpGet("https://api.openalex.org/works?q=x", { maxAttempts: 2 }, { ...seq([{ status: 429 }]), ...noSleep, onEvent: (e) => exhausted.push(e) });
  assert.deepEqual(exhausted.map((e) => e.action), ["retrying", "gave-up"]);
  assert.equal(exhausted[1]?.reason, "attempts exhausted");

  const tooLong: HttpEvent[] = [];
  await httpGet("https://api.github.com/search/repositories?q=x", { maxBackoffMs: 30_000 }, { ...seq([{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3000) } }]), ...noSleep, onEvent: (e) => tooLong.push(e) });
  assert.equal(tooLong.length, 1);
  assert.equal(tooLong[0]?.action, "gave-up");
  assert.match(tooLong[0]?.reason ?? "", /longer than the 30s cap/);
});

test("an arXiv 503 during an academic search is backed off, retried and LOGGED as http_rate_limited; the search still succeeds", async () => {
  const events = new MemoryEventSink();
  const feed = `<feed><entry><id>http://arxiv.org/abs/2001.00001v1</id><title>Word segmentation algorithms</title><summary>We study word segmentation algorithms.</summary><published>2020-01-01T00:00:00Z</published><link href="https://arxiv.org/pdf/2001.00001v1" title="pdf"/><author><name>A</name></author></entry></feed>`;
  let n = 0;
  const fetchFn: FetchFn = (url) => {
    const u = new URL(url);
    if (u.hostname === "export.arxiv.org") {
      n += 1;
      return Promise.resolve(n === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "3" } }) : new Response(feed));
    }
    return Promise.resolve(new Response(JSON.stringify({ results: [] })));
  };
  const res = await runAcademicSearch({ queries: ["word segmentation algorithms"], events, http: { fetchFn, ...noSleep }, arxivLimiter: new MinIntervalLimiter(0), env: {} });
  assert.equal(res.papers.length, 1, "the retried request succeeded");
  const logged = events.events.filter((e) => e.event === "http_rate_limited");
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.data["host"], "export.arxiv.org");
  assert.equal(logged[0]?.data["status"], 503);
  assert.equal(logged[0]?.data["waitMs"], 3000);
  assert.equal(logged[0]?.data["action"], "retrying");
});

test("GitHub rate limit during prior-art lookup: a logged, plainly-worded 'none found' (not a crash, not 'no repositories matched')", async () => {
  const events = new MemoryEventSink();
  const reset = String(Math.floor(Date.now() / 1000) + 3500);
  const fetchFn: FetchFn = () => Promise.resolve(new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }));
  const r = await runGithubLookup({ queries: ["word count cli node", "tokenizer"], events, env: {}, http: { fetchFn, ...noSleep } });
  assert.equal(r.repos.length, 0);
  assert.equal(r.summary, null);
  assert.ok(r.problems.length >= 1 && r.problems.every((p) => /rate limited/.test(p)), r.problems.join(" | "));
  assert.ok(r.notes.some((n) => /GitHub rate limit/.test(n) && /GITHUB_TOKEN/.test(n)), r.notes.join(" | "));
  assert.ok(!r.notes.some((n) => /No public repositories matched/.test(n)), "a rate limit is not reported as 'nothing matched'");
  const gh = events.events.find((e) => e.event === "github_lookup");
  assert.equal(gh?.data["reposFound"], 0);
  assert.ok(events.events.some((e) => e.event === "http_rate_limited" && e.data["host"] === "api.github.com" && e.data["action"] === "gave-up"));
});

test("with GITHUB_TOKEN set, the lookup reports authenticated and sends the token; without it, says unauthenticated limits apply", async () => {
  for (const [env, authed] of [[{ GITHUB_TOKEN: "t-123" }, true], [{}, false]] as const) {
    const events = new MemoryEventSink();
    const seen: (string | undefined)[] = [];
    const fetchFn: FetchFn = (_url, init) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.["Authorization"]);
      return Promise.resolve(new Response(JSON.stringify({ items: [] })));
    };
    const r = await runGithubLookup({ queries: ["x tool"], events, env, http: { fetchFn, ...noSleep } });
    assert.equal(events.events.find((e) => e.event === "github_lookup")?.data["authenticated"], authed);
    assert.equal(seen[0] !== undefined, authed);
    assert.equal(r.notes.some((n) => /GITHUB_TOKEN is not set/.test(n)), !authed);
  }
});
