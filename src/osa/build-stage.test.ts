// The pipeline's build stage: the real cross-provider driver (runDrive) with a fake per-phase dispatch,
// real git, and the PRD-integrity + step-14 hooks around every phase.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ExitCode, PrdLockViolationError } from "../domain/errors.ts";
import { defaultOsaConfig } from "../domain/osa-config.ts";
import type { RunConfig } from "../domain/run.ts";
import type { RunResult } from "../dispatch/run-loop.ts";
import { MinIntervalLimiter } from "../research/net/http.ts";
import { NoopTrimmer } from "../trim/trimmer.ts";
import { MemoryEventSink } from "./events.ts";
import { fakeModel, researchFetch, tempGitRepo } from "./fixtures.test.ts";
import { runOsaCommand, renderOsaRunReport } from "./pipeline.ts";
import type { OsaDeps } from "./pipeline.ts";
import type { LockIO } from "./lock.ts";

const RUN_ID = "abababab-abab-4bab-8bab-abababababab";
const io: LockIO = { show: () => undefined, choose: () => Promise.resolve("lock"), edit: () => Promise.resolve() };
const ok: RunResult = { ok: true, exitCode: 0, turns: [{ turnIndex: 0, archetype: "executor", provider: "claude-code", status: "completed", continuityVerdict: null, retried: false }], halt: null, problems: [], warnings: [] };

/** A fake per-phase dispatch that "produces" what a real reviewer turn would: the next spec, or BUILD_COMPLETE.md. */
function dispatcher(repoDir: string, log: string[], opts: { tamperPrdOnPhase?: number; failPhase?: number } = {}) {
  return async (rc: RunConfig): Promise<RunResult> => {
    log.push(`phase ${String(rc.phase)} spec=${rc.spec_path} prd=${rc.baby_prd_path} execPrompt=${rc.executor_prompt_path ?? "-"}`);
    if (opts.tamperPrdOnPhase === rc.phase) {
      await writeFile(`${repoDir}/${rc.baby_prd_path}`, `${await readFile(`${repoDir}/${rc.baby_prd_path}`, "utf8")}\nSneaky requirement.\n`, "utf8");
    }
    if (opts.failPhase === rc.phase) return { ok: false, exitCode: ExitCode.CONTINUITY_FAILED, turns: [], halt: null, problems: ["continuity check failed twice"], warnings: [] };
    const specDir = rc.spec_path.slice(0, rc.spec_path.lastIndexOf("/") + 1);
    await mkdir(`${repoDir}/${specDir}`, { recursive: true });
    await writeFile(rc.is_final_phase ? `${repoDir}/BUILD_COMPLETE.md` : `${repoDir}/${specDir}PHASE_${String(rc.phase + 1)}_SPEC.md`, "next\n", "utf8");
    return ok;
  };
}

function deps(repoDir: string, log: string[], over: Partial<OsaDeps> = {}, dopts: Parameters<typeof dispatcher>[2] = {}): OsaDeps {
  return {
    events: new MemoryEventSink(RUN_ID),
    io,
    interactive: true,
    runId: RUN_ID,
    config: defaultOsaConfig(),
    textCall: fakeModel().call,
    research: { http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
    trimmer: { trimmer: new NoopTrimmer("noop in tests"), note: null },
    drive: { runDispatchFn: dispatcher(repoDir, log, dopts) as never },
    ...over,
  };
}

const opts = (repoDir: string) => ({ prompt: "make me a word counter", files: [], repoDir, yes: true, json: false });

test("build: phases are driven from the spec, with the locked PRD, committed context and per-run step-14 context wired in", async () => {
  const repoDir = await tempGitRepo();
  const log: string[] = [];
  const report = await runOsaCommand(opts(repoDir), deps(repoDir, log));
  assert.equal(report.ok, true, report.problems.join("; "));
  assert.equal(report.stage, "done");
  assert.equal(report.build?.ok, true);
  assert.equal(report.spec?.total_phases, 2);
  assert.deepEqual(log, [
    `phase 1 spec=runs/${RUN_ID}/spec/PHASE_1_SPEC.md prd=runs/${RUN_ID}/baby-prd.md execPrompt=runs/${RUN_ID}/step14/executor-context.md`,
    `phase 2 spec=runs/${RUN_ID}/spec/PHASE_2_SPEC.md prd=runs/${RUN_ID}/baby-prd.md execPrompt=runs/${RUN_ID}/step14/executor-context.md`,
  ]);
  assert.match(renderOsaRunReport(report), /Build: finished after 2 phase\(s\)/);
});

test("step 14 runs after EVERY phase (incl. the final one) and the executor context is refreshed between phases", async () => {
  const repoDir = await tempGitRepo();
  const events = new MemoryEventSink(RUN_ID);
  const report = await runOsaCommand(opts(repoDir), deps(repoDir, [], { events }));
  assert.equal(events.events.filter((e) => e.event === "step14_done").length, 2);
  const dir = `${repoDir}/runs/${RUN_ID}/step14`;
  for (const f of ["phase-1-handoff.md", "phase-1-summary.md", "phase-2-handoff.md", "phase-2-summary.md", "executor-context.md"]) {
    assert.ok((await readFile(`${dir}/${f}`, "utf8")).length > 0, f);
  }
  assert.match(await readFile(`${dir}/executor-context.md`, "utf8"), /# Handoff from phase 2[\s\S]*## Earlier phases[\s\S]*phase 1:/);
  assert.ok(report.summary_path !== null);
  // everything OSA wrote between phases is committed, so no agent turn's leftover-capture could sweep it up
  assert.equal(execFileSync("git", ["status", "--porcelain", "--", `runs/${RUN_ID}/step14`, `runs/${RUN_ID}/summary.md`, `runs/${RUN_ID}/research`, `runs/${RUN_ID}/baby-prd.md`], { cwd: repoDir }).toString().trim(), "");
});

test("the run summary is written in plain language, committed, and mentions the stages", async () => {
  const repoDir = await tempGitRepo();
  const report = await runOsaCommand(opts(repoDir), deps(repoDir, []));
  const md = await readFile(`${repoDir}/${report.summary_path as string}`, "utf8");
  assert.match(md, /^# What OSA built/);
  assert.match(md, /### Stage 1[\s\S]*### Stage 2/);
  assert.match(md, /## How it was checked/);
  assert.equal(execFileSync("git", ["ls-files", report.summary_path as string], { cwd: repoDir }).toString().trim(), report.summary_path);
});

test("a PRD rewritten during a phase is a HARD FAIL (exit 20) -- phase 2 is never dispatched -- and step 14 still reported that phase", async () => {
  const repoDir = await tempGitRepo();
  const log: string[] = [];
  const events = new MemoryEventSink(RUN_ID);
  await assert.rejects(runOsaCommand(opts(repoDir), deps(repoDir, log, { events }, { tamperPrdOnPhase: 1 })), (e: unknown) => e instanceof PrdLockViolationError && e.exitCode === ExitCode.PRD_LOCK_VIOLATION && /after phase 1/.test(e.message));
  assert.equal(log.length, 1, "phase 2 never started");
  assert.ok(events.names().includes("step14_done"), "step 14 ran for the tampered phase before the run aborted");
  assert.match(await readFile(`${repoDir}/runs/${RUN_ID}/step14/phase-1-summary.md`, "utf8"), /locked PRD .* changed after it was locked/);
});

test("a phase that fails stops the build (non-zero exit), is reported plainly, and still gets its step-14 notes and a summary", async () => {
  const repoDir = await tempGitRepo();
  const report = await runOsaCommand(opts(repoDir), deps(repoDir, [], {}, { failPhase: 1 }));
  assert.equal(report.ok, false);
  assert.equal(report.stage, "build");
  assert.equal(report.build?.ok, false);
  assert.notEqual(report.exit_code, ExitCode.OK);
  const md = await readFile(`${repoDir}/${report.summary_path as string}`, "utf8");
  assert.match(md, /^# What OSA got done before it stopped/);
  assert.match(md, /It did not finish/);
  assert.match(md, /### Stage 1 \(did not complete\)/);
});

test("--spec-only (build:false) stops after the spec: no dispatch, no step 14, no summary", async () => {
  const repoDir = await tempGitRepo();
  const log: string[] = [];
  const events = new MemoryEventSink(RUN_ID);
  const report = await runOsaCommand({ ...opts(repoDir), build: false }, deps(repoDir, log, { events }));
  assert.equal(report.stage, "spec");
  assert.equal(report.build, null);
  assert.equal(report.summary_path, null);
  assert.equal(log.length, 0);
  assert.ok(!events.names().includes("step14_done"));
});

test("the research report reaches the spec author through the trimmer, while the PRD reaches it verbatim", async () => {
  const repoDir = await tempGitRepo();
  const seenByTrimmer: string[] = [];
  const spy = {
    engine: "spy",
    trim: (input: string) => {
      seenByTrimmer.push(input);
      return Promise.resolve({ output: "# Research report (trimmed)\n… 99 lines …\n", removedLines: 99, ratio: 0.1, applied: true, engine: "spy", beforeTokens: 1000, afterTokens: 100, metBudget: true, reason: null, point: null });
    },
  };
  const model = fakeModel();
  const events = new MemoryEventSink(RUN_ID);
  await runOsaCommand({ ...opts(repoDir), build: false }, deps(repoDir, [], { events, textCall: model.call, trimmer: { trimmer: spy, note: null } }));
  const specPrompt = model.log.find((l) => l.purpose === "spec")?.req.prompt ?? "";
  assert.match(specPrompt, /# Research report \(trimmed\)/, "the spec author got the trimmed report");
  assert.ok(seenByTrimmer.some((t) => t.startsWith("# Research report --")), "the trimmer was given the research report");
  assert.ok(!seenByTrimmer.some((t) => t.includes("# Baby PRD")), "the trimmer never saw the PRD");
  const prdOnDisk = await readFile(`${repoDir}/runs/${RUN_ID}/baby-prd.md`, "utf8");
  assert.ok(specPrompt.includes(prdOnDisk.trim()), "the locked PRD was passed to the spec author byte-for-byte");
  assert.ok(events.events.some((e) => e.event === "trim_applied" && e.data["label"] === "research-report"));
});

test("a stopped run's summary says WHY in plain language, with the raw error only under 'For engineers' (found by the first live run)", async () => {
  const { plainStop } = await import("./pipeline.ts");
  assert.match(plainStop([], ExitCode.RELAY_SCHEMA_INVALID), /hand-over note .* could not be read/);
  assert.match(plainStop([], ExitCode.CONTINUITY_FAILED), /could not confirm/);
  assert.match(plainStop([], ExitCode.RUN_HALTED), /stopped the build on purpose/);
  assert.match(plainStop([], 999), /stopped before it was finished/);
  const repoDir = await tempGitRepo();
  const report = await runOsaCommand(opts(repoDir), deps(repoDir, [], {}, { failPhase: 1 }));
  const md = await readFile(`${repoDir}/${report.summary_path as string}`, "utf8");
  const split = md.indexOf("## For engineers (technical detail)");
  assert.match(md.slice(0, split), /## It did not finish\nThe second AI tool could not confirm/);
  assert.ok(!md.slice(0, split).includes("runDispatch"));
  assert.match(md.slice(split), /runDispatch\(\) call did not complete successfully: continuity check failed twice/);
});
