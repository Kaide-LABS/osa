// Stage-level tests for the research phase: the whole pipeline with fake model calls and fake HTTP.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { StageError } from "../domain/errors.ts";
import { OsaConfig, defaultOsaConfig } from "../domain/osa-config.ts";
import type { ProviderId } from "../domain/run.ts";
import type { TextCall, TextRequest } from "../ports/text-provider.ts";
import { MemoryEventSink } from "../osa/events.ts";
import { fakeModel, researchFetch as fetchFn, samplePrd, tempGitRepo } from "../osa/fixtures.test.ts";
import { MinIntervalLimiter } from "./net/http.ts";
import type { FetchFn } from "./net/http.ts";
import { chooseResearchProviders } from "./routing.ts";
import { runResearchStage } from "./stage.ts";

async function run(model: ReturnType<typeof fakeModel>, config = defaultOsaConfig(), repoDirIn?: string) {
  const repoDir = repoDirIn ?? (await tempGitRepo());
  const events = new MemoryEventSink();
  const result = await runResearchStage({
    repoDir,
    runId: "33333333-3333-4333-8333-333333333333",
    prd: samplePrd(),
    config,
    textCall: model.call,
    events,
    http: { fetchFn, sleepFn: () => Promise.resolve() },
    arxivLimiter: new MinIntervalLimiter(0),
    env: {},
    nowIso: () => "2026-10-17T00:00:00.000Z",
  });
  return { repoDir, events, result };
}

test("full stage: outline/fields, one agent per item, academic + prior art, docs, report, cross-provider check, committed", async () => {
  const model = fakeModel();
  const { repoDir, events, result } = await run(model);
  assert.equal(result.skipped, false);
  const dir = `${repoDir}/runs/33333333-3333-4333-8333-333333333333/research`;
  const files = (await readdir(`${dir}/results`)).sort();
  assert.deepEqual(files, ["academic-papers.json", "docs-node-js.json", "node-cli-conventions.json", "prior-art.json", "tokenization-prior-art.json"]);
  assert.ok((await readFile(`${dir}/outline.yaml`, "utf8")).includes("docs-node-js"));
  assert.ok((await readFile(`${dir}/fields.yaml`, "utf8")).includes("current_version"));

  // Every item agent ran with web search on the researcher; the check ran on the OTHER provider.
  const items = model.log.filter((l) => l.purpose.startsWith("research:"));
  assert.equal(items.length, 3);
  assert.ok(items.every((l) => l.provider === "claude-code" && l.req.webSearch));
  const check = model.log.find((l) => l.purpose === "research-crosscheck");
  assert.equal(check?.provider, "codex-cli");
  assert.notEqual(check?.provider, items[0]?.provider);

  // The academic leads reach only items that load the academic-papers module.
  const academicItem = items.find((l) => l.purpose === "research:tokenization-prior-art");
  assert.match(academicItem?.req.prompt ?? "", /Word segmentation algorithms for text/);
  assert.match(academicItem?.req.prompt ?? "", /MODULE academic-papers/);
  assert.ok(!(items.find((l) => l.purpose === "research:node-cli-conventions")?.req.prompt ?? "").includes("Candidate papers"));

  const report = await readFile(`${dir}/report.md`, "utf8");
  assert.match(report, /## Documentation sources[\s\S]*example\.org\/docs-node-js/);
  assert.match(report, /## Academic literature[\s\S]*Word segmentation algorithms for text/);
  assert.match(report, /## Prior art[\s\S]*o\/wc[\s\S]*Reuse the CLI layout/);
  assert.match(report, /## Cross-provider check[\s\S]*checked by codex-cli/);
  assert.equal(report, result.reportMd);

  assert.deepEqual(events.names().filter((n) => ["academic_query", "github_lookup", "research_validated", "research_docs_checked", "research_crosscheck"].includes(n)), [
    "academic_query",
    "github_lookup",
    "research_validated",
    "research_docs_checked",
    "research_crosscheck",
  ]);
  assert.equal(events.names().filter((n) => n === "research_item_done").length, 3);
  assert.equal(execFileSync("git", ["ls-files", "runs/33333333-3333-4333-8333-333333333333/research/report.md"], { cwd: repoDir }).toString().trim(), "runs/33333333-3333-4333-8333-333333333333/research/report.md");
});

test("spec phase FAILS when there are no documentation sources (WS3.5)", async () => {
  const model = fakeModel({ docsType: "article" });
  // Every docs item then fails its own official-docs rule and is reported as not researched...
  const config = defaultOsaConfig();
  await assert.rejects(run(model, config), (e: unknown) => {
    assert.ok(e instanceof StageError);
    return /zero official-documentation sources|Every research item failed|failed/.test(e.message);
  });
});

test("zero doc sources with a docs item that DID pass its own check cannot happen; but zero docs targets + docsRequired still fails", async () => {
  const model = fakeModel();
  const prd = samplePrd();
  const noDocs = { ...prd, researchPlan: { ...prd.researchPlan, docsTargets: [] } };
  const repoDir = await tempGitRepo();
  await assert.rejects(
    runResearchStage({
      repoDir,
      runId: "44444444-4444-4444-8444-444444444444",
      prd: noDocs,
      config: defaultOsaConfig(),
      textCall: model.call,
      events: new MemoryEventSink(),
      http: { fetchFn, sleepFn: () => Promise.resolve() },
      arxivLimiter: new MinIntervalLimiter(0),
      env: {},
    }),
    (e: unknown) => e instanceof StageError && /zero official-documentation sources/.test(e.message),
  );
});

test("research.docsRequired=false lets a docs-less run proceed (explicit opt-out, still reported)", async () => {
  const model = fakeModel();
  const prd = samplePrd();
  const repoDir = await tempGitRepo();
  const events = new MemoryEventSink();
  const result = await runResearchStage({
    repoDir,
    runId: "55555555-5555-4555-8555-555555555555",
    prd: { ...prd, researchPlan: { ...prd.researchPlan, docsTargets: [] } },
    config: OsaConfig.parse({ research: { docsRequired: false } }),
    textCall: model.call,
    events,
    http: { fetchFn, sleepFn: () => Promise.resolve() },
    arxivLimiter: new MinIntervalLimiter(0),
    env: {},
  });
  assert.equal(result.docs.sources.length, 0);
  assert.equal(events.events.find((e) => e.event === "research_docs_checked")?.data["required"], false);
});

test("resume: a second run skips every item whose JSON already validates (WS3.5)", async () => {
  const repoDir = await tempGitRepo();
  const first = fakeModel();
  await run(first, defaultOsaConfig(), repoDir);
  assert.equal(first.log.filter((l) => l.purpose.startsWith("research:")).length, 3);

  const second = fakeModel();
  const { events, result } = await run(second, defaultOsaConfig(), repoDir);
  assert.equal(second.log.filter((l) => l.purpose.startsWith("research:")).length, 0, "no item agent was called on resume");
  assert.ok(result.outcomes.every((o) => o.status === "resumed"));
  assert.equal(events.events.filter((e) => e.event === "research_item_done" && e.data["status"] === "resumed").length, 3);
});

test("cross-provider check refuses a same-provider configuration loudly (WS3.5)", () => {
  assert.throws(() => chooseResearchProviders(["codex-cli", "codex-cli"], () => true), (e: unknown) => e instanceof StageError && /two different providers/.test(e.message));
});

test("a provider without web search is routed around, and logged; no web search anywhere is a loud failure", async () => {
  const hasWeb = (p: ProviderId): boolean => p !== "antigravity-cli";
  const r = chooseResearchProviders(["antigravity-cli", "claude-code"], hasWeb);
  assert.equal(r.researcher, "claude-code");
  assert.equal(r.reviewer, "antigravity-cli");
  assert.equal(r.routedAway, true);
  assert.equal(r.reviewerHasWebSearch, false);
  assert.throws(() => chooseResearchProviders(["antigravity-cli", "codex-cli"], () => false), (e: unknown) => e instanceof StageError && /web search/.test(e.message));

  const model = fakeModel();
  const config = OsaConfig.parse({ providers: { pair: ["antigravity", "claude"] } });
  const { events, result } = await run(model, config);
  assert.equal(result.routing?.researcher, "claude-code");
  assert.ok(events.names().includes("research_routed"));
  // The reviewer has no web access, so the check is degraded -- and says so.
  assert.equal(result.crosscheck?.degraded, true);
  assert.match(result.reportMd, /DEGRADED/);
  assert.ok(result.warnings.some((w) => /consistency-only/.test(w)));
  assert.equal(model.log.find((l) => l.purpose === "research-crosscheck")?.req.webSearch, false);
});

test("unsupported claims from the cross-check are flagged in the report and surfaced as warnings", async () => {
  const model = fakeModel({ crosscheck: { verdict: "issues", summary: "One claim lacks support.", claims: [{ claim: "Node 99 exists", status: "unsupported", note: "no source says so" }] } });
  const { result } = await run(model);
  assert.equal(result.crosscheck?.flagged.length, 1);
  assert.match(result.reportMd, /\[unsupported\] Node 99 exists/);
  assert.ok(result.warnings.some((w) => /not confirmed by the cross-provider check/.test(w)));
});

test("research.crossProviderCheck=false is logged and stamped into the report, never silent", async () => {
  const model = fakeModel();
  const { events, result } = await run(model, OsaConfig.parse({ research: { crossProviderCheck: false } }));
  assert.equal(result.crosscheck, null);
  assert.equal(model.log.filter((l) => l.purpose === "research-crosscheck").length, 0);
  assert.equal(events.events.find((e) => e.event === "research_crosscheck")?.data["skipped"], true);
  assert.match(result.reportMd, /NOT independently checked/);
  assert.ok(result.warnings.some((w) => /disabled by configuration/.test(w)));
});

test("a cross-check that cannot be completed is a loud StageError, not a pass", async () => {
  const model = fakeModel({ failPurposes: new Set(["research-crosscheck"]) });
  await assert.rejects(run(model), (e: unknown) => e instanceof StageError && /could not be completed/.test(e.message));
});

test("academic search finding nothing is a valid, logged result -- the stage succeeds", async () => {
  const empty: FetchFn = (url) => (new URL(url).hostname === "export.arxiv.org" ? Promise.resolve(new Response("<feed></feed>")) : new URL(url).hostname === "api.openalex.org" ? Promise.resolve(new Response(JSON.stringify({ results: [] }))) : fetchFn(url));
  const model = fakeModel();
  const repoDir = await tempGitRepo();
  const events = new MemoryEventSink();
  const result = await runResearchStage({
    repoDir,
    runId: "66666666-6666-4666-8666-666666666666",
    prd: samplePrd(),
    config: defaultOsaConfig(),
    textCall: model.call,
    events,
    http: { fetchFn: empty, sleepFn: () => Promise.resolve() },
    arxivLimiter: new MinIntervalLimiter(0),
    env: {},
  });
  assert.equal(result.academic?.noneRelevant, true);
  assert.match(result.reportMd, /No relevant academic papers were found\. This is a valid result/);
  const q = events.events.find((e) => e.event === "academic_query");
  assert.equal(q?.data["relevant"], 0);
});

test("academic and github lookups can be turned off by config; the report says so", async () => {
  const model = fakeModel();
  const { result, events } = await run(model, OsaConfig.parse({ research: { academic: false, githubLookup: false } }));
  assert.equal(result.academic, null);
  assert.equal(result.priorArt, null);
  assert.ok(!events.names().includes("academic_query") && !events.names().includes("github_lookup"));
  assert.match(result.reportMd, /Academic search was disabled/);
  assert.match(result.reportMd, /Prior-art lookup was disabled/);
});

test("research.enabled=false skips the stage entirely and says so", async () => {
  const model = fakeModel();
  const { result, events } = await run(model, OsaConfig.parse({ research: { enabled: false } }));
  assert.equal(result.skipped, true);
  assert.equal(model.log.length, 0);
  assert.equal(events.events[0]?.data["skipped"], true);
  assert.ok(result.warnings.length > 0);
});

test("an item that cannot be completed is reported as not researched; the others still count", async () => {
  const model = fakeModel({ failPurposes: new Set(["research:node-cli-conventions"]) });
  const { result } = await run(model);
  assert.equal(result.outcomes.find((o) => o.slug === "node-cli-conventions")?.status, "failed");
  assert.match(result.reportMd, /## Not researched[\s\S]*node-cli-conventions/);
  assert.ok(result.warnings.some((w) => /node-cli-conventions/.test(w)));
});
