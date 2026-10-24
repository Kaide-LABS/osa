// The one-shot MCP flow: osa_plan -> osa_spec -> (the person confirms the spec) -> osa_build -> osa_status. Runs the real pipeline against a scripted model.

import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { OsaConfig } from "../../domain/osa-config.ts";
import { parseBabyPrd, renderBabyPrd } from "../../osa/baby-prd.ts";
import { fakeModel, researchFetch, samplePrd, tempGitRepo } from "../../osa/fixtures.test.ts";
import type { OsaDeps, OsaRunReport } from "../../osa/pipeline.ts";
import { MinIntervalLimiter } from "../../research/net/http.ts";
import { NoopTrimmer } from "../../trim/trimmer.ts";
import { sha256String } from "../../util/hash.ts";
import { buildMcpServer } from "../server.ts";
import { osaRunStatus, planOsaRun, runningJobs, startOsaBuild, startOsaSpec, waitForJobs } from "./osa.ts";
import type { OsaToolDeps } from "./osa.ts";

/** The real pipeline with a scripted model and fake research HTTP; the config names a pair so no real provider is probed. */
function realDeps(risky = true): OsaToolDeps {
  const pipeline: Partial<OsaDeps> = {
    config: OsaConfig.parse({}),
    textCall: fakeModel({ prd: samplePrd({ risky }) }).call,
    research: { http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
    trimmer: { trimmer: new NoopTrimmer("noop"), note: null },
  };
  return { pipeline };
}
const eventNames = async (repoDir: string, runId: string): Promise<string[]> =>
  (await readFile(`${repoDir}/.osa/runs/${runId}/events.jsonl`, "utf8")).split("\n").filter((l) => l !== "").map((l) => (JSON.parse(l) as { event: string }).event);

test("osa_plan: returns the plan and its fingerprint, writes the request, and locks, researches and builds NOTHING", async () => {
  const repoDir = await tempGitRepo();
  const head = (await readFile(`${repoDir}/.git/HEAD`, "utf8")).trim();
  const plan = await planOsaRun({ repo_dir: repoDir, prompt: "make a word counter", files: [], answers: {} }, realDeps());
  assert.match(plan.run_id, /^[0-9a-f-]{36}$/);
  const onDisk = await readFile(`${repoDir}/runs/${plan.run_id}/baby-prd.md`, "utf8");
  assert.equal(plan.plan_sha256, sha256String(onDisk), "the fingerprint is the hash of exactly the file on disk");
  assert.equal(plan.plan_markdown, onDisk);
  assert.ok(plan.tldr.length > 0 && plan.tldr.includes("\n"), "the TL;DR is several lines, joined");
  assert.equal(plan.risky_assumptions.length, 1);
  assert.match(plan.risky_assumptions[0] ?? "", /personal data/);
  assert.ok(plan.safe_assumptions.length >= 1);
  assert.match(plan.next_step, /explicit yes/);
  assert.match(plan.next_step, /osa_spec/);
  const names = await eventNames(repoDir, plan.run_id);
  assert.ok(names.includes("assumptions_generated"));
  for (const later of ["prd_locked", "research_item_done", "spec_written"]) assert.ok(!names.includes(later), `${later} must not have happened`);
  await assert.rejects(readFile(`${repoDir}/.osa/runs/${plan.run_id}/prd.lock.json`, "utf8"), "no lock record");
  assert.equal((await readFile(`${repoDir}/.git/HEAD`, "utf8")).trim(), head);
  const st = await osaRunStatus({ repo_dir: repoDir, run_id: plan.run_id });
  assert.ok(!("refusal" in st) && st.state === "awaiting_confirmation");
});

test("osa_plan: a folder that is not a git repository is a plain error, not a crash", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()}/osa-notgit-`);
  await assert.rejects(planOsaRun({ repo_dir: dir, prompt: "x", files: [], answers: {} }, realDeps()), /not a git repository/);
});

/** Polls osa_status until the run waits at the post-spec gate (the real pipeline with a scripted model reaches it in a few seconds). */
async function awaitingGate(repoDir: string, runId: string): Promise<Extract<Awaited<ReturnType<typeof osaRunStatus>>, { state: string }>> {
  for (let i = 0; i < 600; i++) {
    const st = await osaRunStatus({ repo_dir: repoDir, run_id: runId });
    if (!("refusal" in st) && st.state === "awaiting_confirmation" && st.stage === "spec") return st;
    if (!("refusal" in st) && (st.state === "stopped" || st.state === "finished")) throw new Error(`the run ended before the gate: ${st.message}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the run never reached the post-spec gate");
}

/** A build that "succeeds" without a provider: each phase writes the next phase's spec, the last writes BUILD_COMPLETE.md (as in lock-hardening.test.ts). */
function withFakeBuild(deps: OsaToolDeps, repoDir: string): OsaToolDeps {
  const runDispatchFn = (async (rc: { spec_path: string; phase: number; is_final_phase: boolean }) => {
    const dir = rc.spec_path.slice(0, rc.spec_path.lastIndexOf("/") + 1);
    await mkdir(`${repoDir}/${dir}`, { recursive: true });
    await writeFile(rc.is_final_phase ? `${repoDir}/BUILD_COMPLETE.md` : `${repoDir}/${dir}PHASE_${String(rc.phase + 1)}_SPEC.md`, "x\n", "utf8");
    return { ok: true, exitCode: 0, turns: [], halt: null, problems: [], warnings: [] };
  }) as never;
  return { ...deps, pipeline: { ...(deps.pipeline ?? {}), drive: { runDispatchFn } } };
}

test("osa_spec runs research and spec in the background and stops at the gate: osa_status shows awaiting_confirmation with the TL;DR, a spec hash and the risky assumptions; no build has started", async () => {
  const repoDir = await tempGitRepo();
  const deps = realDeps();
  const plan = await planOsaRun({ repo_dir: repoDir, prompt: "make a word counter", files: [], answers: {} }, deps);
  const t0 = Date.now();
  const started = await startOsaSpec({ repo_dir: repoDir, run_id: plan.run_id, plan_sha256: plan.plan_sha256, decision: "go" }, deps);
  assert.ok(!("refusal" in started) && started.status === "started");
  assert.ok(Date.now() - t0 < 5000, "returns at once; the work continues in the background");
  assert.deepEqual(runningJobs(), [plan.run_id]);

  const st = await awaitingGate(repoDir, plan.run_id);
  assert.ok(st.tldr !== null && st.tldr.length > 0, "the TL;DR is there");
  assert.match(st.spec_sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(st.risky_assumptions.length, 1);
  assert.match(st.risky_assumptions[0] ?? "", /personal data/);
  const gateFile = JSON.parse(await readFile(`${repoDir}/.osa/runs/${plan.run_id}/mcp-gate.json`, "utf8")) as { tldr: string[] };
  assert.deepEqual(gateFile.tldr, st.tldr);
  const names = await eventNames(repoDir, plan.run_id);
  assert.ok(names.includes("prd_locked") && names.includes("spec_written"), "the PRD was locked automatically and the spec written");
  assert.ok(!names.includes("step14_done"), "no build has started");
  assert.deepEqual(runningJobs(), [plan.run_id], "the run is still alive, waiting for the person");

  // leave nothing hanging: decline at the gate
  const done = await startOsaBuild({ repo_dir: repoDir, run_id: plan.run_id, spec_sha256: st.spec_sha256 as string, decision: "cancel", accept_risky_assumptions: false });
  assert.ok(!("refusal" in done) && done.status === "cancelled");
  await waitForJobs();
});

test("osa_build refuses, and builds nothing, when the confirmation cannot be applied to the spec the person saw", async () => {
  const repoDir = await tempGitRepo();
  const deps = realDeps();
  const plan = await planOsaRun({ repo_dir: repoDir, prompt: "make a word counter", files: [], answers: {} }, deps);

  const nothingWaiting = await startOsaBuild({ repo_dir: repoDir, run_id: plan.run_id, spec_sha256: "0".repeat(64), decision: "lock", accept_risky_assumptions: true });
  assert.ok("refusal" in nothingWaiting && /No spec is waiting/.test(nothingWaiting.refusal), "before osa_spec there is nothing to confirm");

  await startOsaSpec({ repo_dir: repoDir, run_id: plan.run_id, plan_sha256: plan.plan_sha256, decision: "go" }, deps);
  const st = await awaitingGate(repoDir, plan.run_id);
  const sha = st.spec_sha256 as string;
  const base = { repo_dir: repoDir, run_id: plan.run_id, spec_sha256: sha, decision: "lock" as const, accept_risky_assumptions: true };

  const unknown = await startOsaBuild({ ...base, run_id: "11111111-1111-4111-8111-111111111111" });
  assert.ok("refusal" in unknown && /No spec is waiting/.test(unknown.refusal));

  const wrong = await startOsaBuild({ ...base, spec_sha256: "0".repeat(64) });
  assert.ok("refusal" in wrong && /spec_sha256 does not match/.test(wrong.refusal));

  const noAccept = await startOsaBuild({ ...base, accept_risky_assumptions: false });
  assert.ok("refusal" in noAccept && /risky assumption/.test(noAccept.refusal) && /personal data/.test(noAccept.refusal));

  // a spec file is edited after the TL;DR was shown: the hash the person confirmed no longer describes what is on disk
  const specFile = `${repoDir}/runs/${plan.run_id}/spec/PHASE_1_SPEC.md`;
  const original = await readFile(specFile, "utf8");
  await appendFile(specFile, "\n- sneaked in\n", "utf8");
  const tampered = await startOsaBuild(base);
  assert.ok("refusal" in tampered && /spec_sha256 does not match/.test(tampered.refusal));
  assert.deepEqual(runningJobs(), [plan.run_id], "every refusal left the run waiting at the gate");
  assert.ok(!(await eventNames(repoDir, plan.run_id)).includes("step14_done"), "nothing was built by any refusal");

  await writeFile(specFile, original, "utf8");
  const declined = await startOsaBuild({ ...base, decision: "cancel" });
  assert.ok(!("refusal" in declined) && declined.status === "cancelled");
  await waitForJobs();
});

test("osa_build 'cancel' at the gate ends the run without building; the decision is final", async () => {
  const repoDir = await tempGitRepo();
  const deps = realDeps(false);
  const plan = await planOsaRun({ repo_dir: repoDir, prompt: "make a word counter", files: [], answers: {} }, deps);
  await startOsaSpec({ repo_dir: repoDir, run_id: plan.run_id, plan_sha256: plan.plan_sha256, decision: "go" }, deps);
  const st = await awaitingGate(repoDir, plan.run_id);
  const cancelled = await startOsaBuild({ repo_dir: repoDir, run_id: plan.run_id, spec_sha256: st.spec_sha256 as string, decision: "cancel", accept_risky_assumptions: false });
  assert.ok(!("refusal" in cancelled) && cancelled.status === "cancelled");
  await waitForJobs();
  const after = await osaRunStatus({ repo_dir: repoDir, run_id: plan.run_id });
  assert.ok(!("refusal" in after));
  assert.equal(after.state, "stopped");
  assert.equal((after.report as OsaRunReport).build, null, "no build was started");
  assert.equal((after.report as OsaRunReport).exit_code, 22);
  const again = await startOsaBuild({ repo_dir: repoDir, run_id: plan.run_id, spec_sha256: st.spec_sha256 as string, decision: "lock", accept_risky_assumptions: true });
  assert.ok("refusal" in again && /No spec is waiting/.test(again.refusal), "a decided gate cannot be decided again");
});

test("the whole flow: osa_plan -> osa_spec -> osa_status awaiting -> osa_build lock -> osa_status finished, with the locked plan byte-identical to the one shown", async () => {
  const repoDir = await tempGitRepo();
  const deps = withFakeBuild(realDeps(false), repoDir);
  const plan = await planOsaRun({ repo_dir: repoDir, prompt: "make a word counter", files: [], answers: {} }, deps);
  await startOsaSpec({ repo_dir: repoDir, run_id: plan.run_id, plan_sha256: plan.plan_sha256, decision: "go" }, deps);
  const st = await awaitingGate(repoDir, plan.run_id);
  const released = await startOsaBuild({ repo_dir: repoDir, run_id: plan.run_id, spec_sha256: st.spec_sha256 as string, decision: "lock", accept_risky_assumptions: false });
  assert.ok(!("refusal" in released) && released.status === "started");
  await waitForJobs();
  const done = await osaRunStatus({ repo_dir: repoDir, run_id: plan.run_id });
  assert.ok(!("refusal" in done));
  assert.equal(done.state, "finished", done.message);
  const report = done.report as OsaRunReport;
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(report.prd_sha256, plan.plan_sha256, "the locked plan is byte-identical to the one the person was shown");
  assert.equal(report.run_id, plan.run_id);
  assert.notEqual(report.build, null, "the build ran after the confirmation");
  const names = await eventNames(repoDir, plan.run_id);
  assert.equal(names.filter((n) => n === "assumptions_generated").length, 1, "intake ran once, in osa_plan");
  assert.ok(names.indexOf("spec_written") < names.indexOf("step14_done"), "the spec came before the build");
});

test("only one run per repository at a time; a second must wait", async () => {
  const repoDir = await tempGitRepo();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  // a pipeline that waits on the gate (the plans are written directly below)
  const fakeRun = async (_opts: unknown, d: { runId?: string }): Promise<OsaRunReport> => {
    const runId = d.runId ?? "22222222-2222-4222-8222-222222222222";
    const report = { schema_version: 1, generated_at: "t", run_id: runId, ok: true, exit_code: 0, stage: "spec", lock: "locked", prd_path: null, prd_sha256: null, assumptions: { risky: 0, safe: 1 }, research: null, spec: null, build: null, agents: null, summary_path: null, warnings: [], problems: [] } as unknown as OsaRunReport;
    await gate;
    return report;
  };
  const a = "44444444-4444-4444-8444-444444444444";
  const b = "55555555-5555-4555-8555-555555555555";
  const md = renderBabyPrd(samplePrd());
  const sha = sha256String(md);
  for (const id of [a, b]) {
    await mkdir(`${repoDir}/runs/${id}`, { recursive: true });
    await mkdir(`${repoDir}/.osa/runs/${id}`, { recursive: true });
    await writeFile(`${repoDir}/runs/${id}/baby-prd.md`, md, "utf8");
    await writeFile(`${repoDir}/.osa/runs/${id}/plan-request.json`, JSON.stringify({ prompt: "p", files: [], plan_sha256: sha, created_at: "t" }), "utf8");
  }
  const deps: OsaToolDeps = { run: ((o: never, d: never) => fakeRun(o, d as { runId?: string })) as never };
  const first = await startOsaSpec({ repo_dir: repoDir, run_id: a, plan_sha256: sha, decision: "go" }, deps);
  assert.ok(!("refusal" in first) && first.status === "started");
  const second = await startOsaSpec({ repo_dir: repoDir, run_id: b, plan_sha256: sha, decision: "go" }, deps);
  assert.ok("refusal" in second && /still working in this repository/.test(second.refusal));
  release();
  await waitForJobs();
  const third = await startOsaSpec({ repo_dir: repoDir, run_id: b, plan_sha256: sha, decision: "go" }, deps);
  assert.ok(!("refusal" in third), "once the first has ended, the next may start");
  await waitForJobs();
});

test("osa_status: a run that locked but has no result and no live job (server restarted) is 'interrupted'; no run at all is a clear refusal", async () => {
  const repoDir = await tempGitRepo();
  const none = await osaRunStatus({ repo_dir: repoDir });
  assert.ok("refusal" in none && /No OSA run found/.test(none.refusal));
  const id = "66666666-6666-4666-8666-666666666666";
  await mkdir(`${repoDir}/.osa/runs/${id}`, { recursive: true });
  const line = (event: string) => JSON.stringify({ schema_version: 1, at: "2026-01-01T00:00:00.000Z", run_id: id, event, data: {} }) + "\n";
  await writeFile(`${repoDir}/.osa/runs/${id}/events.jsonl`, line("run_started") + line("assumptions_generated") + line("prd_locked") + line("research_item_done"), "utf8");
  const st = await osaRunStatus({ repo_dir: repoDir, run_id: id });
  assert.ok(!("refusal" in st));
  assert.equal(st.state, "interrupted");
  assert.equal(st.stage, "research");
  assert.match(st.message, /start again with osa_plan/);
  assert.equal(st.recent_events.at(-1)?.event, "research_item_done");
});

test("the tools are registered on the server with the descriptions that tell the assistant to ask the person first", () => {
  const server = buildMcpServer() as unknown as { _registeredTools: Record<string, { description?: string }> };
  const tools = server._registeredTools;
  assert.match(tools["osa_plan"]?.description ?? "", /show the person the plan/i);
  assert.match(tools["osa_plan"]?.description ?? "", /NOTHING is built or locked/);
  assert.match(tools["osa_plan"]?.description ?? "", /recommended questions/);
  assert.match(tools["osa_spec"]?.description ?? "", /start research and spec in the background/);
  assert.match(tools["osa_spec"]?.description ?? "", /after the person has seen the plan/i);
  assert.match(tools["osa_build"]?.description ?? "", /Only after osa_status shows awaiting_confirmation/);
  assert.match(tools["osa_build"]?.description ?? "", /accept_risky_assumptions/);
  assert.match(tools["osa_build"]?.description ?? "", /never set accept_risky_assumptions yourself/i);
  assert.match(tools["osa_build"]?.description ?? "", /spec_sha256/);
  assert.match(tools["osa_status"]?.description ?? "", /awaiting_confirmation/);
});

test("osa_plan returns scope, recommended_questions, and defaulted_assumptions; safe_assumptions excludes defaulted", async () => {
  const repoDir = await tempGitRepo();
  const plan = await planOsaRun({ repo_dir: repoDir, prompt: "make a word counter", files: [], answers: {} }, realDeps());
  assert.match(plan.scope, /^(narrow|broad)$/);
  assert.ok(Array.isArray(plan.recommended_questions));
  assert.ok(Array.isArray(plan.defaulted_assumptions));
  assert.ok(Array.isArray(plan.safe_assumptions));
  // safe_assumptions should exclude defaulted ones
  const allDefaultedTexts = new Set(plan.defaulted_assumptions);
  for (const safe of plan.safe_assumptions) {
    assert.ok(!allDefaultedTexts.has(safe), `safe assumption should not be a defaulted one: ${safe}`);
  }
  const markdown = await readFile(`${repoDir}/runs/${plan.run_id}/baby-prd.md`, "utf8");
  const prd = parseBabyPrd(markdown);
  assert.equal(prd.scope, plan.scope);
  assert.deepEqual(prd.recommendedQuestions, plan.recommended_questions);
});

test("osa_plan: answers reach run() and are persisted in plan-request.json", async () => {
  const repoDir = await tempGitRepo();
  const answers = { "Why?": "Because", "What?": "Everything" };
  const plan = await planOsaRun({ repo_dir: repoDir, prompt: "make a word counter", files: [], answers }, realDeps());
  const requestFile = await readFile(`${repoDir}/.osa/runs/${plan.run_id}/plan-request.json`, "utf8");
  const request = JSON.parse(requestFile);
  assert.deepEqual(request.answers, answers);
});

test("osa_spec refuses on wrong plan_sha256, on unknown run, and while another job runs", async () => {
  const repoDir = await tempGitRepo();
  const deps = realDeps(false);
  const plan = await planOsaRun({ repo_dir: repoDir, prompt: "make a word counter", files: [], answers: {} }, deps);

  const unknown = await startOsaSpec({ repo_dir: repoDir, run_id: "11111111-1111-4111-8111-111111111111", plan_sha256: plan.plan_sha256, decision: "go" }, deps);
  assert.ok("refusal" in unknown && /no plan/.test(unknown.refusal));

  const wrong = await startOsaSpec({ repo_dir: repoDir, run_id: plan.run_id, plan_sha256: "0".repeat(64), decision: "go" }, deps);
  assert.ok("refusal" in wrong && /does not match/.test(wrong.refusal));

  // Start a job and try to start another
  const first = await startOsaSpec({ repo_dir: repoDir, run_id: plan.run_id, plan_sha256: plan.plan_sha256, decision: "go" }, deps);
  assert.ok(!("refusal" in first) && first.status === "started");
  const second = await startOsaSpec({ repo_dir: repoDir, run_id: plan.run_id, plan_sha256: plan.plan_sha256, decision: "go" }, deps);
  assert.ok("refusal" in second && /already waiting/.test(second.refusal));
  // The job now waits at the post-spec gate for the person; decline there so it can end.
  const st = await awaitingGate(repoDir, plan.run_id);
  const declined = await startOsaBuild({ repo_dir: repoDir, run_id: plan.run_id, spec_sha256: st.spec_sha256 as string, decision: "cancel", accept_risky_assumptions: false });
  assert.ok(!("refusal" in declined) && declined.status === "cancelled");
  await waitForJobs();
});

test("osa_spec 'cancel' discards the plan without building", async () => {
  const repoDir = await tempGitRepo();
  const deps = realDeps(false);
  const plan = await planOsaRun({ repo_dir: repoDir, prompt: "make a word counter", files: [], answers: {} }, deps);
  const cancelled = await startOsaSpec({ repo_dir: repoDir, run_id: plan.run_id, plan_sha256: plan.plan_sha256, decision: "cancel" }, deps);
  assert.ok(!("refusal" in cancelled) && cancelled.status === "cancelled");
  const st = await osaRunStatus({ repo_dir: repoDir, run_id: plan.run_id });
  assert.ok(!("refusal" in st) && st.state === "cancelled");
});
