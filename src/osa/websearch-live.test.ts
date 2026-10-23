// Suite 5, LIVE (opt-in: OSA_WEB_LIVE=1): does a provider's built-in web search ACTUALLY run when OSA asks for it? The probe is a fact
// that only exists on a page published after any model's training: the latest release of an actively developed GitHub project. A call
// WITH web search must return a current version and cite a URL on that project; the same call WITHOUT web search must not (the control
// proves the answer came from the web, not from memory). Run per provider; the verdict feeds research routing (see TEST_REPORT.md).
//
//   OSA_WEB_LIVE=1 node --test src/osa/websearch-live.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTextCall } from "../dispatch/text-call.ts";
import type { ProviderId } from "../domain/run.ts";
import { httpGet } from "../research/net/http.ts";
import { extractJsonObject } from "./intake.ts";

const LIVE = process.env["OSA_WEB_LIVE"] === "1";
const PROJECT_URL = /github\.com\/DeusData\/codebase-memory-mcp/i;

const PROMPT = [
  'How many GitHub stars does the repository "DeusData/codebase-memory-mcp" have RIGHT NOW (today), and what is the latest release tag?',
  "Look it up on the web; do not answer from memory. If you cannot look it up, say so.",
  'Reply with ONE JSON object only: {"stars":<integer or null>,"version":"x.y.z or unknown","published":"YYYY-MM-DD or unknown","source_urls":["the URLs you actually opened"],"looked_up":true|false}',
].join("\n");

/** Ground truth, fetched through OSA's own allowlisted research client at test time. The live star count changes daily; the latest release tag changes too. */
async function liveRelease(): Promise<string> {
  const r = await httpGet("https://api.github.com/repos/DeusData/codebase-memory-mcp/releases/latest", { headers: { "User-Agent": "osa-test", Accept: "application/vnd.github+json" } });
  assert.equal(r.kind, "ok", r.kind === "ok" ? "" : r.message);
  return (JSON.parse(r.kind === "ok" ? r.text : "{}") as { tag_name: string }).tag_name.replace(/^v/, "");
}

async function liveStars(): Promise<number> {
  const r = await httpGet("https://api.github.com/repos/DeusData/codebase-memory-mcp", { headers: { "User-Agent": "osa-test", Accept: "application/vnd.github+json" } });
  assert.equal(r.kind, "ok", r.kind === "ok" ? "" : r.message);
  return (JSON.parse(r.kind === "ok" ? r.text : "{}") as { stargazers_count: number }).stargazers_count;
}


async function ask(provider: ProviderId, webSearch: boolean): Promise<{ stars: number | null; version: string; urls: string[]; lookedUp: unknown }> {
  const call = makeTextCall({ modelOverrides: { "codex-cli": "gpt-6-luna" } });
  const r = await call(provider, { prompt: PROMPT, cwd: process.cwd(), timeoutMs: 280_000, tier: "high-volume-low-effort", webSearch, modelOverride: null }, "websearch-live");
  assert.ok(r.outcome.ok, `${provider} call failed: ${r.outcome.failure?.message ?? ""}`);
  const j = extractJsonObject(r.outcome.text ?? "") as { stars?: unknown; version?: unknown; source_urls?: unknown; looked_up?: unknown };
  return { stars: typeof j.stars === "number" ? j.stars : null, version: String(j.version ?? ""), urls: Array.isArray(j.source_urls) ? j.source_urls.map(String) : [], lookedUp: j.looked_up };
}

const within = (got: number | null, truth: number, pct: number): boolean => got !== null && Math.abs(got - truth) <= Math.max(2, truth * pct);
const knowsLiveFact = (a: { stars: number | null; version: string }, stars: readonly number[], release: string): boolean => stars.some((t) => within(a.stars, t, 0.02)) || a.version.replace(/^v/, "") === release;

for (const provider of ["claude-code", "codex-cli"] as const) {
  test(`LIVE (OSA_WEB_LIVE=1): ${provider} web search is honoured -- the live star count matches GitHub's within 2% and the project page is cited; the no-web control cannot match it`, { skip: LIVE ? false : "set OSA_WEB_LIVE=1", timeout: 600_000 }, async () => {
    const release = await liveRelease();
    const before = await liveStars();
    const withWeb = await ask(provider, true);
    const after = await liveStars();
    process.stdout.write(`\n[websearch:${provider}] GitHub stars before=${String(before)} after=${String(after)}; WITH web: stars=${String(withWeb.stars)} version=${withWeb.version} looked_up=${String(withWeb.lookedUp)} urls=${JSON.stringify(withWeb.urls.slice(0, 3))}\n`);
    const control = await ask(provider, false);
    process.stdout.write(`[websearch:${provider}] CONTROL (web disabled): stars=${String(control.stars)} version=${control.version} looked_up=${String(control.lookedUp)}\n`);
    assert.ok(knowsLiveFact(withWeb, [before, after], release), `with web search it states a live fact (stars ${String(before)}..${String(after)} or release ${release}), got stars=${String(withWeb.stars)} version=${withWeb.version}`);
    assert.ok(withWeb.urls.some((u) => PROJECT_URL.test(u)), `it cites a page of the project: ${JSON.stringify(withWeb.urls)}`);
    assert.ok(!knowsLiveFact(control, [before, after], release), `the control (web disabled) must not be able to state a live fact, got stars=${String(control.stars)} version=${control.version}`);
  });
}
