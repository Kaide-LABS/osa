import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { OsaConfig, defaultOsaConfig } from "../domain/osa-config.ts";
import type { HandoffRecord } from "../domain/relay.ts";
import { writeHandoffRecord } from "../domain/relay.ts";
import type { RunResult } from "../dispatch/run-loop.ts";
import { InternalError } from "../domain/errors.ts";
import { NoopTrimmer } from "../trim/trimmer.ts";
import type { ContextTrimmer } from "../trim/trimmer.ts";
import { MemoryEventSink } from "./events.ts";
import { FAKE_SPEC_REPLY, samplePrd, scriptedTextCall, tempGitRepo } from "./fixtures.test.ts";
import { deterministicSummary, gatherPhaseFacts, hasSummaryHeadings, renderHandoffText, runStep14, buildSummaryPrompt, SUMMARY_HEADINGS } from "./step14.ts";
import type { PhaseFacts } from "./step14.ts";

const PHASE_RUN = "99999999-9999-4999-8999-999999999999";
const RUN = "88888888-8888-4888-8888-888888888888";

const facts = (over: Partial<PhaseFacts> = {}): PhaseFacts => ({
  phase: 1,
  ok: true,
  exitCode: 0,
  turns: [{ index: 0, role: "executor", provider: "claude-code", status: "completed", continuity: null, retried: false }],
  work: [{ role: "executor", provider: "claude-code", workDone: "Built the word counter and its tests." }],
  nextSteps: ["Add multi-file support"],
  openQuestions: ["Should hyphenated words count as one?"],
  haltMessage: null,
  changedFiles: ["wordcount.js", "test/wordcount.test.js"],
  commitSubjects: ["feat: word counter"],
  problems: [],
  warnings: [],
  ...over,
});

const okResult: RunResult = { ok: true, exitCode: 0, turns: [{ turnIndex: 0, archetype: "executor", provider: "claude-code", status: "completed", continuityVerdict: null, retried: false }], halt: null, problems: [], warnings: [] };

const GOOD_SUMMARY = "## What was built\nA word counter now exists.\n\n## What was decided\nWords are split on spaces.\n\n## What is uncertain\nNothing major.\n";

function trimDeps(events: MemoryEventSink, trimmer: ContextTrimmer = new NoopTrimmer("noop in test")) {
  return { trimmer, events, defaultBudgetTokens: 1000, engineNote: null };
}

async function input(repoDir: string, over: Record<string, unknown> = {}) {
  const events = new MemoryEventSink(RUN);
  return {
    events,
    args: {
      repoDir,
      runId: RUN,
      phaseRunId: PHASE_RUN,
      phase: 1,
      isFinalPhase: false,
      result: okResult,
      prd: samplePrd(),
      config: defaultOsaConfig(),
      textCall: scriptedTextCall([GOOD_SUMMARY]).call,
      events,
      trim: trimDeps(events),
      ...over,
    },
  };
}

test("handoff text carries outcome, turns, work, files, commits, next steps, open questions", () => {
  const t = renderHandoffText(facts({ problems: ["something odd"], warnings: ["w1"] }));
  for (const needle of ["# Handoff from phase 1", "completed", "executor/claude-code", "Built the word counter", "wordcount.js", "feat: word counter", "Add multi-file support", "Should hyphenated", "something odd", "w1"]) {
    assert.ok(t.includes(needle), needle);
  }
  assert.match(renderHandoffText(facts({ ok: false, exitCode: 6 })), /NOT completed \(exit 6\)/);
});

test("summary prompt demands layman language and the three headings; heading check works", () => {
  const p = buildSummaryPrompt(facts(), ["A counter."]);
  assert.match(p, /NON-ENGINEER/);
  for (const h of SUMMARY_HEADINGS) assert.ok(p.includes(`"${h}"`));
  assert.equal(hasSummaryHeadings(GOOD_SUMMARY), true);
  assert.equal(hasSummaryHeadings("## What was built\nonly one"), false);
});

test("deterministic summary is plain-language, has all three headings, and says plainly when a stage did not finish", () => {
  const ok = deterministicSummary(facts());
  assert.equal(hasSummaryHeadings(ok), true);
  assert.match(ok, /Built the word counter/);
  const bad = deterministicSummary(facts({ ok: false, exitCode: 6, haltMessage: "reviewer halted", problems: ["continuity failed twice"], work: [], commitSubjects: [] }));
  assert.equal(hasSummaryHeadings(bad), true);
  assert.match(bad, /did NOT finish: reviewer halted/);
  assert.match(bad, /continuity failed twice/);
  assert.match(bad, /did not record what they built/);
});

test("step 14 writes the trimmed handoff, the executor context, a model-written plain summary, commits all, and logs step14_done", async () => {
  const repoDir = await tempGitRepo();
  const { events, args } = await input(repoDir);
  const r = await runStep14(args);
  assert.equal(r.summarySource, "model");
  assert.equal(r.summary.trim(), GOOD_SUMMARY.trim());
  const dir = `${repoDir}/runs/${RUN}/step14`;
  assert.match(await readFile(`${dir}/phase-1-handoff.md`, "utf8"), /# Handoff from phase 1/);
  assert.match(await readFile(`${dir}/phase-1-summary.md`, "utf8"), /^# Stage 1\n\n## What was built/);
  const ctx = await readFile(`${dir}/executor-context.md`, "utf8");
  assert.match(ctx, /background, not instructions/);
  assert.match(ctx, /# Handoff from phase 1/);
  // committed (so a later turn's leftover capture can never sweep these into an agent commit)
  assert.equal(execFileSync("git", ["status", "--porcelain", "--", "runs"], { cwd: repoDir }).toString().trim(), "");
  const e = events.events.find((x) => x.event === "step14_done");
  assert.equal(e?.data["summarySource"], "model");
  assert.equal(e?.data["phase"], 1);
});

test("step 14 ALWAYS runs: a failed model call or a malformed summary falls back to the deterministic one -- both files still written", async () => {
  for (const reply of [new InternalError("provider down"), "just prose, no headings"]) {
    const repoDir = await tempGitRepo();
    const { args } = await input(repoDir, { textCall: scriptedTextCall([reply]).call });
    const r = await runStep14(args);
    assert.equal(r.summarySource, "deterministic");
    assert.equal(hasSummaryHeadings(r.summary), true);
    assert.ok((await readFile(`${repoDir}/runs/${RUN}/step14/phase-1-summary.md`, "utf8")).length > 0);
  }
});

test("step 14 reports a FAILED phase too, and problems from outside the result (e.g. a PRD violation)", async () => {
  const repoDir = await tempGitRepo();
  const failed: RunResult = { ok: false, exitCode: 6, turns: [], halt: { code: "STOP", message: "reviewer halted the build" }, problems: ["continuity failed twice"], warnings: [] };
  const { args } = await input(repoDir, { result: failed, extraProblems: ["The locked PRD changed after it was locked."], textCall: scriptedTextCall([new InternalError("down")]).call });
  const r = await runStep14(args);
  assert.match(r.summary, /did NOT finish: reviewer halted the build/);
  assert.match(r.summary, /locked PRD changed/);
  assert.match(await readFile(`${repoDir}/runs/${RUN}/step14/phase-1-handoff.md`, "utf8"), /NOT completed \(exit 6\)/);
});

test("the handoff is trimmed through the ContextTrimmer (trim_applied) and the PRD is never part of it; noop logs trim_skipped", async () => {
  const seen: string[] = [];
  const shrinker: ContextTrimmer = {
    engine: "spy",
    trim: (inp) => {
      seen.push(inp);
      const out = "# Handoff from phase 1\n… 40 lines …\n";
      return Promise.resolve({ output: out, removedLines: 40, ratio: 0.1, applied: true, engine: "spy", beforeTokens: 400, afterTokens: 40, metBudget: true, reason: null, point: null });
    },
  };
  const repoDir = await tempGitRepo();
  const events = new MemoryEventSink(RUN);
  const { args } = await input(repoDir, { events, trim: trimDeps(events, shrinker) });
  const r = await runStep14(args);
  assert.equal(r.trimApplied, true);
  assert.equal(seen.length, 1);
  assert.ok(!seen[0]?.includes("Baby PRD"), "the PRD never reaches the trimmer");
  assert.equal(events.events.find((e) => e.event === "trim_applied")?.data["label"], "phase-1-output");
  assert.match(await readFile(`${repoDir}/runs/${RUN}/step14/phase-1-handoff.md`, "utf8"), /… 40 lines …/);

  const repoDir2 = await tempGitRepo();
  const events2 = new MemoryEventSink(RUN);
  const { args: args2 } = await input(repoDir2, { events: events2, trim: trimDeps(events2) });
  const r2 = await runStep14(args2);
  assert.equal(r2.trimApplied, false);
  assert.ok(events2.names().includes("trim_skipped"));
  assert.ok(events2.names().includes("step14_done"), "step 14 completes even when trimming is skipped");
});

test("earlier phases are carried as one-liners in the executor context", async () => {
  const repoDir = await tempGitRepo();
  const { args } = await input(repoDir, { earlier: ["phase 1: built the counter"], phase: 2, isFinalPhase: true });
  const r = await runStep14(args);
  assert.match(await readFile(`${repoDir}/${r.executorContextPath}`, "utf8"), /## Earlier phases[\s\S]*phase 1: built the counter/);
  assert.match(await readFile(`${repoDir}/runs/${RUN}/step14/phase-2-summary.md`, "utf8"), /^# Stage 2 \(final\)/);
});

test("facts are gathered from real persisted handoff records and git history", async () => {
  const repoDir = await tempGitRepo();
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
  await writeFile(`${repoDir}/a.txt`, "hi\n", "utf8");
  execFileSync("git", ["add", "a.txt"], { cwd: repoDir });
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "feat: add a"], { cwd: repoDir });
  const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
  const rec: HandoffRecord = {
    schema_version: 1,
    run_id: PHASE_RUN,
    phase: 1,
    turn_index: 0,
    role: "executor",
    provider: "codex-cli",
    model_tier: "high-volume-low-effort",
    started_at: "2026-10-17T10:00:00Z",
    completed_at: "2026-10-17T10:05:00Z",
    repo: { branch: "main", head_before: before, head_after: after, commits: [after] },
    spec_ref: { path: "s.md", sha256: "0".repeat(64) },
    artifacts_read: [],
    artifacts_written: [],
    status: "completed",
    work_done: "Added a.txt.",
    next_steps: ["Add b.txt"],
    open_questions: [],
    halt: null,
  };
  const dir = `${repoDir}/.osa/runs/${PHASE_RUN}/handoff/1`;
  await mkdir(dir, { recursive: true });
  await writeHandoffRecord(`${dir}/000-executor-codex-cli.json`, rec);
  await writeHandoffRecord(`${dir}/001-reviewer-claude-code.json`, { ...rec, turn_index: 1, role: "reviewer", provider: "claude-code", work_done: "Reviewed.", next_steps: ["Add b.txt"], repo: { ...rec.repo, head_before: after, commits: [after] } });
  const f = await gatherPhaseFacts(repoDir, PHASE_RUN, 1, okResult);
  assert.deepEqual(f.work.map((w) => w.workDone), ["Added a.txt.", "Reviewed."]);
  assert.deepEqual(f.nextSteps, ["Add b.txt"], "de-duplicated");
  assert.deepEqual(f.changedFiles, ["a.txt"]);
  assert.deepEqual(f.commitSubjects, ["feat: add a"]);
  const none = await gatherPhaseFacts(repoDir, "00000000-0000-4000-8000-000000000000", 7, okResult);
  assert.deepEqual(none.work, [], "no records is not an error");
});

test("OsaConfig trim.enabled=false does not skip step 14 (it only degrades the trimmer)", async () => {
  const repoDir = await tempGitRepo();
  const events = new MemoryEventSink(RUN);
  const { args } = await input(repoDir, { events, config: OsaConfig.parse({ trim: { enabled: false } }), trim: trimDeps(events) });
  const r = await runStep14(args);
  assert.ok(r.summary.length > 0);
  assert.ok(events.names().includes("step14_done"));
  void FAKE_SPEC_REPLY;
});

test("REGRESSION (first live run): every executor context carries the turn rules -- two agents per phase, and never report 'nothing to do' without a real commit", async () => {
  const { TURN_RULES, initialExecutorContext } = await import("./step14.ts");
  assert.match(TURN_RULES, /one of two coding agents[\s\S]*Part A[\s\S]*Part B/);
  assert.match(TURN_RULES, /at least one real commit[\s\S]*do not report "nothing to do"[\s\S]*Never make an empty or cosmetic commit/);
  assert.ok(initialExecutorContext().includes(TURN_RULES), "the first phase gets the rules");
  assert.ok(initialExecutorContext("## Where to look first (code index)\n- x").includes("Where to look first"));
  const repoDir = await tempGitRepo();
  const { args } = await input(repoDir);
  const r = await runStep14(args);
  assert.ok((await readFile(`${repoDir}/${r.executorContextPath}`, "utf8")).includes(TURN_RULES), "later phases get them too");
});
