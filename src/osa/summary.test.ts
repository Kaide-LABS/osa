import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderRunSummary, writeRunSummary } from "./summary.ts";
import type { RunSummaryInput } from "./summary.ts";
import { samplePrd, tempGitRepo } from "./fixtures.test.ts";

const base = (over: Partial<RunSummaryInput> = {}): RunSummaryInput => ({
  prd: samplePrd(),
  outcome: "finished",
  stoppedBecause: null,
  stages: [{ phase: 1, ok: true, summary: "## What was built\nA counter.\n\n## What was decided\nSplit on spaces.\n\n## What is uncertain\nNothing.\n" }],
  lockedRiskyAssumptions: [],
  specDecisions: ["Output uses plain text."],
  research: { skipped: false, docSources: 4, papers: 0, repos: 1, crossChecked: true, degradedCheck: false },
  warnings: [],
  ...over,
});

test("a finished run's summary is plain language: TL;DR, stages, choices, how it was checked, nothing flagged", () => {
  const md = renderRunSummary(base());
  assert.match(md, /^# What OSA built/);
  assert.match(md, /## In short[\s\S]*word/i);
  assert.match(md, /### Stage 1\n#### What was built/, "stage headings are demoted so the document has one outline");
  assert.match(md, /## Choices made for you[\s\S]*Output uses plain text\./);
  assert.match(md, /A second, different AI checked the research against its sources\./);
  assert.match(md, /written by one AI and reviewed by a different one/);
  assert.match(md, /## What to look at\n- Nothing was flagged\./);
  assert.ok(!/sha256|runDispatch|HandoffRecord|exit code/i.test(md), "no engineering jargon");
});

test("a stopped run says so first and plainly; risky assumptions the person confirmed are listed as such", () => {
  const md = renderRunSummary(base({ outcome: "stopped", stoppedBecause: "The second AI disagreed with the first twice.", stages: [{ phase: 1, ok: false, summary: "## What was built\nPart of it.\n" }], lockedRiskyAssumptions: ["Input may contain personal data."], warnings: ["3 research claims were not confirmed."] }));
  assert.match(md, /^# What OSA got done before it stopped/);
  assert.match(md, /## It did not finish\nThe second AI disagreed/);
  assert.match(md, /### Stage 1 \(did not complete\)/);
  assert.match(md, /\(you confirmed this risky one\) Input may contain personal data\./);
  assert.match(md, /- 3 research claims were not confirmed\./);
});

test("research caveats are stated honestly: skipped, unchecked, and consistency-only", () => {
  assert.match(renderRunSummary(base({ research: { skipped: true, docSources: 0, papers: 0, repos: 0, crossChecked: false, degradedCheck: false } })), /Research was switched off/);
  assert.match(renderRunSummary(base({ research: { skipped: false, docSources: 2, papers: 0, repos: 0, crossChecked: false, degradedCheck: false } })), /NOT independently checked/);
  assert.match(renderRunSummary(base({ research: { skipped: false, docSources: 2, papers: 0, repos: 0, crossChecked: true, degradedCheck: true } })), /could not open the web sources/);
  assert.ok(!renderRunSummary(base({ research: null })).includes("How it was checked"));
});

test("no stages -> says no build stage ran; application notes appear when present", () => {
  assert.match(renderRunSummary(base({ stages: [] })), /No build stage ran/);
  assert.match(renderRunSummary(base({ applicationNotes: ["Running it on a 5-word file printed 5."] })), /## Does it actually work\?\n- Running it on a 5-word file printed 5\./);
});

test("writeRunSummary writes runs/<id>/summary.md and returns its relative path", async () => {
  const repoDir = await tempGitRepo();
  const rel = await writeRunSummary(repoDir, "abc", base());
  assert.equal(rel, "runs/abc/summary.md");
  assert.match(await readFile(`${repoDir}/${rel}`, "utf8"), /^# What OSA built/);
});

test("raw technical detail appears ONLY under 'For engineers' at the very end; the plain-language sections never carry it", () => {
  const raw = "Failed to parse C:/Users/x/handoff/1/001.json as JSON: Unexpected token";
  const md = renderRunSummary(base({ outcome: "stopped", stoppedBecause: "One AI tool's hand-over note to the next could not be read.", technicalDetail: [raw] }));
  const idx = md.indexOf("## For engineers (technical detail)");
  assert.ok(idx > 0);
  assert.ok(md.indexOf(raw) > idx, "the raw text is only below the engineers heading");
  assert.ok(!md.slice(0, idx).includes(raw));
  assert.ok(md.indexOf("## What to look at") < idx, "it is the last section");
  assert.ok(!renderRunSummary(base()).includes("For engineers"), "absent when there is nothing to show");
});
