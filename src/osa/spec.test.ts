import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { StageError } from "../domain/errors.ts";
import { OsaConfig, defaultOsaConfig } from "../domain/osa-config.ts";
import type { DocsReport } from "../research/docs.ts";
import { MemoryEventSink } from "./events.ts";
import { FAKE_SPEC_REPLY, scriptedTextCall, tempGitRepo } from "./fixtures.test.ts";
import { appendSpecAssumptions, buildSpecPrompt, ensureDocSources, parseSpecReply, renderDocSourcesSection, runSpecStage } from "./spec.ts";

const docs: DocsReport = { sources: [{ title: "Node docs", url: "https://nodejs.org/docs", itemSlug: "docs-node-js" }], covered: ["Node.js"], uncovered: [] };
const noDocs: DocsReport = { sources: [], covered: [], uncovered: ["Node.js"] };

const base = (over: Record<string, unknown> = {}) => ({
  runId: "77777777-7777-4777-8777-777777777777",
  prdMarkdown: "# Baby PRD\nthe locked text",
  reportMarkdown: "# Research report\nfindings",
  docs,
  flaggedClaims: [] as string[],
  config: defaultOsaConfig(),
  events: new MemoryEventSink(),
  ...over,
});

test("prompt: never ask questions, PRD immutable, includes PRD + report + doc sources + unconfirmed claims + extra sections", () => {
  const p = buildSpecPrompt({ prdMarkdown: "PRD-TEXT", reportMarkdown: "REPORT-TEXT", docs, flaggedClaims: ["Node 99 exists"], extraSections: [{ title: "Architecture proposals", body: "ALT-ARCH" }] });
  assert.match(p, /NEVER ask a question/);
  assert.match(p, /locked PRD is immutable/);
  assert.match(p, /PRD-TEXT[\s\S]*REPORT-TEXT/);
  assert.match(p, /https:\/\/nodejs\.org\/docs/);
  assert.match(p, /UNCONFIRMED CLAIMS[\s\S]*Node 99 exists/);
  assert.match(p, /=== ARCHITECTURE PROPOSALS ===\nALT-ARCH/);
});

test("parseSpecReply: four sections, bounded phase count, assumptions list", () => {
  const r = parseSpecReply(FAKE_SPEC_REPLY);
  assert.equal(r.totalPhases, 2);
  assert.deepEqual(r.assumptions, ["Output uses plain text.", "Nothing from the unconfirmed claims was relied on."]);
  assert.match(r.contextMd, /# Context/);
  assert.match(r.specMd, /# Phase 1/);
  assert.throws(() => parseSpecReply("=== TOTAL_PHASES ===\n2"), (e: unknown) => e instanceof StageError && /missing section/.test(e.message));
  for (const bad of ["0", "13", "many"]) {
    assert.throws(() => parseSpecReply(FAKE_SPEC_REPLY.replace("\n2\n", `\n${bad}\n`)), (e: unknown) => e instanceof StageError && /TOTAL_PHASES/.test(e.message), bad);
  }
  assert.deepEqual(parseSpecReply(FAKE_SPEC_REPLY.replace(/- Output[\s\S]*?relied on\./, "- none")).assumptions, []);
});

test("ensureDocSources: a spec that cites no research doc URL gets the deterministic section; one that does is left alone", () => {
  const without = ensureDocSources("# Phase 1\nno links", docs);
  assert.equal(without.cited, 1);
  assert.match(without.specMd, /## Documentation sources[\s\S]*\[Node docs\]\(https:\/\/nodejs\.org\/docs\)/);
  const withLink = "# Phase 1\nSee https://nodejs.org/docs.";
  assert.deepEqual(ensureDocSources(withLink, docs), { specMd: withLink, cited: 1 });
  assert.equal(ensureDocSources("x", noDocs).cited, 0);
  assert.equal(renderDocSourcesSection(docs).split("\n").length, 3);
});

test("appendSpecAssumptions adds a visible section only when there are assumptions", () => {
  assert.equal(appendSpecAssumptions("spec", []), "spec");
  assert.match(appendSpecAssumptions("spec", ["a", "b"]), /## Spec assumptions[\s\S]*nobody was asked[\s\S]*- a\n- b/);
});

test("runSpecStage writes context.md + PHASE_1_SPEC.md, logs each spec assumption, never asks anything", async () => {
  const repoDir = await tempGitRepo();
  const { call, requests } = scriptedTextCall([FAKE_SPEC_REPLY]);
  const events = new MemoryEventSink();
  const r = await runSpecStage({ ...base({ events }), repoDir, textCall: call });
  assert.equal(r.specPath, "runs/77777777-7777-4777-8777-777777777777/spec/PHASE_1_SPEC.md");
  assert.equal(r.totalPhases, 2);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.purpose, "spec");
  assert.equal(requests[0]?.req.webSearch, false);
  const spec = await readFile(`${repoDir}/${r.specPath}`, "utf8");
  assert.match(spec, /## Documentation sources/);
  assert.match(spec, /## Spec assumptions[\s\S]*Output uses plain text\./);
  assert.match(await readFile(`${repoDir}/${r.contextPath}`, "utf8"), /# Context/);
  assert.equal(events.events.filter((e) => e.event === "spec_assumption").length, 2);
  assert.equal(events.events.find((e) => e.event === "spec_written")?.data["totalPhases"], 2);
});

test("SPEC PHASE FAILS when there are zero documentation sources (WS3.5)", async () => {
  const repoDir = await tempGitRepo();
  const { call, requests } = scriptedTextCall([FAKE_SPEC_REPLY]);
  await assert.rejects(runSpecStage({ ...base({ docs: noDocs }), repoDir, textCall: call }), (e: unknown) => e instanceof StageError && /zero official-documentation sources/.test(e.message));
  assert.equal(requests.length, 0, "fails before spending a model call");
});

test("documentation is not demanded when research is disabled or docsRequired is false (explicit opt-outs)", async () => {
  const a = await tempGitRepo();
  await runSpecStage({ ...base({ docs: noDocs, config: OsaConfig.parse({ research: { docsRequired: false } }) }), repoDir: a, textCall: scriptedTextCall([FAKE_SPEC_REPLY]).call });
  const b = await tempGitRepo();
  await runSpecStage({ ...base({ docs: noDocs, config: OsaConfig.parse({ research: { enabled: false } }) }), repoDir: b, textCall: scriptedTextCall([FAKE_SPEC_REPLY]).call });
});

test("a malformed reply is retried once with the problem quoted; two bad replies fail loudly", async () => {
  const repoDir = await tempGitRepo();
  const { call, requests } = scriptedTextCall(["just prose", FAKE_SPEC_REPLY]);
  const r = await runSpecStage({ ...base(), repoDir, textCall: call });
  assert.equal(requests.length, 2);
  assert.match(requests[1]?.req.prompt ?? "", /YOUR PREVIOUS REPLY WAS REJECTED[\s\S]*missing section/);
  assert.equal(r.totalPhases, 2);
  await assert.rejects(runSpecStage({ ...base(), repoDir, textCall: scriptedTextCall(["nope", "still nope"]).call }), StageError);
});

test("REGRESSION (first live run): a spec must split the phase into Part A and Part B -- otherwise the second executor has nothing to commit and the harness's R3 rule rejects its turn", async () => {
  const { assertTwoParts } = await import("./spec.ts");
  assert.doesNotThrow(() => assertTwoParts("## Part A (first agent)\nx\n## Part B (second agent)\ny"));
  assert.throws(() => assertTwoParts("# Phase 1\nbuild everything"), (e: unknown) => e instanceof StageError && /Part A.*Part B/.test(e.message));
  assert.throws(() => assertTwoParts("## Part A\nonly one half"), StageError);
  assert.match(buildSpecPrompt({ prdMarkdown: "P", reportMarkdown: "R", docs, flaggedClaims: [] }), /EXECUTION MODEL: each build phase is carried out by TWO coding agents[\s\S]*Part A[\s\S]*Part B/);

  // a reply without the parts is retried once with the problem quoted; two such replies fail loudly
  const noParts = FAKE_SPEC_REPLY.replace(/## Part A[\s\S]*?(?=## Documentation sources)/, "");
  const repoDir = await tempGitRepo();
  const s = scriptedTextCall([noParts, FAKE_SPEC_REPLY]);
  await runSpecStage({ ...base(), repoDir, textCall: s.call });
  assert.equal(s.requests.length, 2);
  assert.match(s.requests[1]?.req.prompt ?? "", /YOUR PREVIOUS REPLY WAS REJECTED[\s\S]*Part A/);
  await assert.rejects(runSpecStage({ ...base(), repoDir, textCall: scriptedTextCall([noParts, noParts]).call }), (e: unknown) => e instanceof StageError && /Part A/.test(e.message));
});

test("the spec author is told the PRD's 'Original request (authoritative)' section is the person's own wording and wins over the summary above it", () => {
  const p = buildSpecPrompt({ prdMarkdown: "P", reportMarkdown: "R", docs, flaggedClaims: [] });
  assert.match(p, /Original request \(authoritative\)' section, that is the person's own wording/);
  assert.match(p, /MUST appear in the spec exactly as stated/);
  assert.match(p, /the original request wins/);
});
