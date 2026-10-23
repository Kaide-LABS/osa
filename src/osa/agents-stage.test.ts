// The three agents inside the pipeline: lateral architecture + the planner's recorded decision, the implication
// review, and the post-build application check that FAILS the run on unmet criteria.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ExitCode, InternalError } from "../domain/errors.ts";
import { OsaConfig, defaultOsaConfig } from "../domain/osa-config.ts";
import type { RunConfig } from "../domain/run.ts";
import type { RunResult } from "../dispatch/run-loop.ts";
import { MinIntervalLimiter } from "../research/net/http.ts";
import { NoopTrimmer } from "../trim/trimmer.ts";
import { MemoryEventSink } from "./events.ts";
import { fakeModel, researchFetch, tempGitRepo } from "./fixtures.test.ts";
import { runOsaCommand, renderOsaRunReport } from "./pipeline.ts";
import type { OsaDeps } from "./pipeline.ts";
import type { LockIO } from "./lock.ts";

const RUN_ID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const io: LockIO = { show: () => undefined, choose: () => Promise.resolve("lock"), edit: () => Promise.resolve() };
const ok: RunResult = { ok: true, exitCode: 0, turns: [], halt: null, problems: [], warnings: [] };
const git = (cwd: string, ...a: string[]): string => execFileSync("git", a, { cwd }).toString().trim();

function dispatcher(repoDir: string, fail = false) {
  return async (rc: RunConfig): Promise<RunResult> => {
    if (fail) return { ok: false, exitCode: ExitCode.CONTINUITY_FAILED, turns: [], halt: null, problems: ["continuity failed twice"], warnings: [] };
    const specDir = rc.spec_path.slice(0, rc.spec_path.lastIndexOf("/") + 1);
    await mkdir(`${repoDir}/${specDir}`, { recursive: true });
    await writeFile(rc.is_final_phase ? `${repoDir}/BUILD_COMPLETE.md` : `${repoDir}/${specDir}PHASE_${String(rc.phase + 1)}_SPEC.md`, "next\n", "utf8");
    return ok;
  };
}

function deps(repoDir: string, over: Partial<OsaDeps> = {}, fail = false): OsaDeps {
  return {
    events: new MemoryEventSink(RUN_ID),
    io,
    interactive: true,
    runId: RUN_ID,
    config: defaultOsaConfig(),
    textCall: fakeModel().call,
    research: { http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
    trimmer: { trimmer: new NoopTrimmer("noop in tests"), note: null },
    drive: { runDispatchFn: dispatcher(repoDir, fail) as never },
    ...over,
  };
}

const opts = (repoDir: string, build = true) => ({ prompt: "make me a word counter", files: [], repoDir, yes: true, json: false, build });

test("full flow: lateral review -> planner records the decision -> implication adds S-criteria -> build -> application check passes", async () => {
  const repoDir = await tempGitRepo();
  const model = fakeModel();
  const events = new MemoryEventSink(RUN_ID);
  const report = await runOsaCommand(opts(repoDir), deps(repoDir, { textCall: model.call, events }));
  assert.equal(report.ok, true, report.problems.join("; "));
  assert.equal(report.stage, "done");

  // the lateral agent ran on codex (planner is claude), and the PLANNER recorded the decision
  assert.equal(model.log.find((l) => l.purpose === "lateral-architecture")?.provider, "codex-cli");
  assert.equal(model.log.find((l) => l.purpose === "architecture-decision")?.provider, "claude-code");
  assert.deepEqual(report.agents?.architecture, { chosen: "planned", why: "Files are small, so reading whole files is simpler and meets the criteria.", provider: "codex-cli" });
  const ctx = await readFile(`${repoDir}/runs/${RUN_ID}/spec/context.md`, "utf8");
  assert.match(ctx, /## Architecture decision[\s\S]*Streaming pipeline[\s\S]*\*\*Chosen:\*\* the planned architecture[\s\S]*\*\*Why:\*\* Files are small/);

  // the implication agent ran on the OTHER provider and extended the SPEC (not the PRD)
  assert.equal(model.log.find((l) => l.purpose === "implication")?.provider, "codex-cli");
  const spec = await readFile(`${repoDir}/runs/${RUN_ID}/spec/PHASE_1_SPEC.md`, "utf8");
  assert.match(spec, /## Implications[\s\S]*S1\. A missing file prints an error and the remaining files are still counted\./);
  assert.equal(report.agents?.implications?.acceptanceAdded, 1);
  assert.ok(!(await readFile(`${repoDir}/runs/${RUN_ID}/baby-prd.md`, "utf8")).includes("Implications"), "the locked PRD is untouched");

  // the application agent checked the PRD criteria AND the spec's extra criterion, in a sandbox, and passed
  const app = model.log.find((l) => l.purpose === "application");
  assert.match(app?.req.prompt ?? "", /- AC1:[\s\S]*- AC2:[\s\S]*- S1: A missing file prints an error/);
  assert.equal(app?.req.execute, true);
  assert.notEqual(app?.req.cwd, repoDir, "the check ran in a disposable copy");
  assert.equal(report.agents?.application?.passed, true);
  assert.equal(report.agents?.application?.met, 3);

  // events, in order
  const names = events.names();
  const order = ["spec_written", "lateral_arch_done", "implication_done", "step14_done", "application_check"] as const;
  const idx = order.map((n) => names.indexOf(n));
  assert.ok(idx.every((i, k) => i >= 0 && (k === 0 || i > (idx[k - 1] as number))), `out of order: ${names.join(",")}`);

  // evidence is committed and the summary tells the person plainly
  assert.equal(git(repoDir, "ls-files", `runs/${RUN_ID}/application/evidence.json`), `runs/${RUN_ID}/application/evidence.json`);
  const summary = await readFile(`${repoDir}/${report.summary_path as string}`, "utf8");
  assert.match(summary, /Architecture: kept the original plan after an independent review/);
  assert.match(summary, /## Does it actually work\?\n- 3 of 3 requirements were seen working/);
  const text = renderOsaRunReport(report);
  assert.match(text, /Architecture: kept the original plan after an independent review by codex-cli/);
  assert.match(text, /Spec review: 1 extra requirement\(s\)/);
  assert.match(text, /Final check: passed \(3 requirement\(s\) seen working\)/);
});

test("an UNMET criterion FAILS the run (exit 24, stage 'verify'), says which one, and the summary says it did not finish (WS6.3)", async () => {
  const repoDir = await tempGitRepo();
  const report = await runOsaCommand(opts(repoDir), deps(repoDir, { textCall: fakeModel({ application: "unmet" }).call }));
  assert.equal(report.ok, false);
  assert.equal(report.exit_code, ExitCode.APPLICATION_CHECK_FAILED);
  assert.equal(report.stage, "verify");
  assert.equal(report.build?.ok, true, "the build itself finished");
  assert.equal(report.agents?.application?.passed, false);
  assert.ok(report.problems.some((p) => /Not working/.test(p)));
  const summary = await readFile(`${repoDir}/${report.summary_path as string}`, "utf8");
  assert.match(summary, /^# What OSA got done before it stopped/);
  assert.match(summary, /did not pass the final check/);
  assert.match(renderOsaRunReport(report), /Final check: FAILED \(1 requirement\(s\) not met\)/);
});

test("a 'met' claim with no evidence is downgraded and fails the run; a criterion the agent skipped fails it too", async () => {
  for (const mode of ["no-evidence", "missing"] as const) {
    const repoDir = await tempGitRepo();
    const report = await runOsaCommand(opts(repoDir), deps(repoDir, { textCall: fakeModel({ application: mode }).call }));
    assert.equal(report.exit_code, ExitCode.APPLICATION_CHECK_FAILED, mode);
  }
});

test("an application agent that cannot answer fails the run -- 'could not verify' is never reported as passed", async () => {
  const repoDir = await tempGitRepo();
  const report = await runOsaCommand(opts(repoDir), deps(repoDir, { textCall: fakeModel({ failPurposes: new Set(["application"]) }).call }));
  assert.equal(report.ok, false);
  assert.equal(report.exit_code, ExitCode.APPLICATION_CHECK_FAILED);
  assert.ok(report.agents?.application?.could_not_run !== null);
  assert.match(renderOsaRunReport(report), /Final check: COULD NOT RUN/);
});

test("the application check is skipped when the build failed, and when agents.application is false (with a warning)", async () => {
  const repoDir = await tempGitRepo();
  const model = fakeModel();
  const failed = await runOsaCommand(opts(repoDir), deps(repoDir, { textCall: model.call }, true));
  assert.equal(failed.ok, false);
  assert.equal(failed.stage, "build");
  assert.equal(model.log.filter((l) => l.purpose === "application").length, 0);

  const repoDir2 = await tempGitRepo();
  const model2 = fakeModel();
  const off = await runOsaCommand(opts(repoDir2), deps(repoDir2, { textCall: model2.call, config: OsaConfig.parse({ agents: { application: false } }) }));
  assert.equal(off.ok, true);
  assert.equal(model2.log.filter((l) => l.purpose === "application").length, 0);
  assert.ok(off.warnings.some((w) => /application check is switched off/.test(w)));
});

test("advisory agents are config-gated and their failure is a visible warning, never a silent skip and never a crash", async () => {
  const repoDir = await tempGitRepo();
  const model = fakeModel({ failPurposes: new Set(["lateral-architecture", "implication"]) });
  const report = await runOsaCommand(opts(repoDir, false), deps(repoDir, { textCall: model.call }));
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((w) => /independent architecture review \(codex-cli\) could not be completed/.test(w)));
  assert.ok(report.warnings.some((w) => /implication review \(codex-cli\) could not be completed/.test(w)));
  assert.equal(model.log.filter((l) => l.purpose === "architecture-decision").length, 0, "no alternatives, so no decision call");
  assert.equal(report.agents?.architecture, null);

  const repoDir2 = await tempGitRepo();
  const model2 = fakeModel();
  await runOsaCommand(opts(repoDir2, false), deps(repoDir2, { textCall: model2.call, config: OsaConfig.parse({ agents: { lateralArchitecture: false, implication: false } }) }));
  assert.equal(model2.log.filter((l) => ["lateral-architecture", "architecture-decision", "implication"].includes(l.purpose)).length, 0);
});

test("lateral independence: re-routed away from the planner by default; pinned to the planner => a LOUD warning in the run report", async () => {
  const repoDir = await tempGitRepo();
  const m1 = fakeModel();
  const rerouted = await runOsaCommand(opts(repoDir, false), deps(repoDir, { textCall: m1.call, config: OsaConfig.parse({ providers: { pair: ["codex-cli", "claude-code"] } }) }));
  assert.equal(m1.log.find((l) => l.purpose === "lateral-architecture")?.provider, "claude-code", "not the planner (codex)");
  assert.ok(rerouted.warnings.some((w) => /re-routed to claude-code/.test(w)));

  const repoDir2 = await tempGitRepo();
  const m2 = fakeModel();
  const pinned = await runOsaCommand(opts(repoDir2, false), deps(repoDir2, { textCall: m2.call, config: OsaConfig.parse({ providers: { pair: ["codex-cli", "claude-code"] }, agents: { lateralArchitecturePinned: true } }) }));
  assert.equal(m2.log.find((l) => l.purpose === "lateral-architecture")?.provider, "codex-cli", "pinned to the planner's own provider");
  assert.ok(pinned.warnings.some((w) => /^LOUD WARNING: .*SAME provider as the planner/.test(w)));
});

test("when the planner adopts the alternative, the spec the build reads is the revised one and still carries its documentation sources", async () => {
  const repoDir = await tempGitRepo();
  const decision = ["=== ARCHITECTURE_DECISION ===", "Chosen: Streaming pipeline", "Why: inputs may be huge.", "=== CONTEXT.MD ===", "# Context v2", "=== PHASE_1_SPEC.MD ===", "# Phase 1 v2 (streams)\nBuild it with streams.\n## Part A (first agent)\na\n## Part B (second agent)\nb"].join("\n");
  const report = await runOsaCommand(opts(repoDir, false), deps(repoDir, { textCall: fakeModel({ decision }).call }));
  assert.equal(report.agents?.architecture?.chosen, "Streaming pipeline");
  const spec = await readFile(`${repoDir}/runs/${RUN_ID}/spec/PHASE_1_SPEC.md`, "utf8");
  assert.match(spec, /^# Phase 1 v2 \(streams\)/);
  assert.match(spec, /## Documentation sources/);
  assert.match(spec, /## Implications/, "the implication review then ran on the revised spec");
  assert.match(await readFile(`${repoDir}/runs/${RUN_ID}/spec/context.md`, "utf8"), /^# Context v2[\s\S]*\*\*Chosen:\*\* Streaming pipeline/);
});

test("an invalid planner decision is a loud StageError (recording the choice is the point), not a silent default", async () => {
  const repoDir = await tempGitRepo();
  await assert.rejects(
    runOsaCommand(opts(repoDir, false), deps(repoDir, { textCall: fakeModel({ decision: "I think we should keep it." }).call })),
    (e: unknown) => e instanceof Error && /could not record an architecture decision/.test(e.message),
  );
  void InternalError;
});
