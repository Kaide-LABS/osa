// The one-shot MCP flow: osa_plan -> (the person confirms) -> osa_build -> osa_status. Runs the real pipeline against a scripted model.

import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { OsaConfig } from "../../domain/osa-config.ts";
import { renderBabyPrd } from "../../osa/baby-prd.ts";
import { fakeModel, researchFetch, samplePrd, tempGitRepo } from "../../osa/fixtures.test.ts";
import type { OsaDeps, OsaRunReport } from "../../osa/pipeline.ts";
import { MinIntervalLimiter } from "../../research/net/http.ts";
import { NoopTrimmer } from "../../trim/trimmer.ts";
import { sha256String } from "../../util/hash.ts";
import { buildMcpServer } from "../server.ts";
import { osaRunStatus, planOsaRun, runningJobs, startOsaBuild, waitForJobs } from "./osa.ts";
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
  const plan = await planOsaRun({ repo_dir: repoDir, prompt: "make a word counter", files: [] }, realDeps());
  assert.match(plan.run_id, /^[0-9a-f-]{36}$/);
  const onDisk = await readFile(`${repoDir}/runs/${plan.run_id}/baby-prd.md`, "utf8");
  assert.equal(plan.plan_sha256, sha256String(onDisk), "the fingerprint is the hash of exactly the file on disk");
  assert.equal(plan.plan_markdown, onDisk);
  assert.ok(plan.tldr.length > 0 && plan.tldr.includes("\n"), "the TL;DR is several lines, joined");
  assert.equal(plan.risky_assumptions.length, 1);
  assert.match(plan.risky_assumptions[0] ?? "", /personal data/);
  assert.ok(plan.safe_assumptions.length >= 1);
  assert.match(plan.next_step, /explicit yes/);
  assert.match(plan.next_step, /accept_risky_assumptions true/);
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
  await assert.rejects(planOsaRun({ repo_dir: dir, prompt: "x", files: [] }, realDeps()), /not a git repository/);
});

test("osa_build refuses, and locks nothing, when the confirmation cannot be applied to the plan the person saw", async () => {
  const repoDir = await tempGitRepo();
  const deps = realDeps();
  const plan = await planOsaRun({ repo_dir: repoDir, prompt: "make a word counter", files: [] }, deps);
  const base = { repo_dir: repoDir, run_id: plan.run_id, plan_sha256: plan.plan_sha256, decision: "lock" as const, accept_risky_assumptions: true, spec_only: true };

  const unknown = await startOsaBuild({ ...base, run_id: "11111111-1111-4111-8111-111111111111" }, deps);
  assert.ok("refusal" in unknown && /Call osa_plan first/.test(unknown.refusal));

  const wrong = await startOsaBuild({ ...base, plan_sha256: "0".repeat(64) }, deps);
  assert.ok("refusal" in wrong && /does not match the plan on disk/.test(wrong.refusal));

  const noAccept = await startOsaBuild({ ...base, accept_risky_assumptions: false }, deps);
  assert.ok("refusal" in noAccept && /risky assumption/.test(noAccept.refusal) && /personal data/.test(noAccept.refusal));

  // the plan file is edited after it was shown: the fingerprint no longer matches
  await appendFile(`${repoDir}/runs/${plan.run_id}/baby-prd.md`, "\n- sneaked in\n", "utf8");
  const tampered = await startOsaBuild(base, deps);
  assert.ok("refusal" in tampered && /does not match the plan on disk/.test(tampered.refusal));

  assert.deepEqual(runningJobs(), []);
  assert.ok(!(await eventNames(repoDir, plan.run_id)).includes("prd_locked"), "nothing was locked by any refusal");
});

test("osa_build 'cancel' discards the plan; the decision is final", async () => {
  const repoDir = await tempGitRepo();
  const deps = realDeps(false);
  const plan = await planOsaRun({ repo_dir: repoDir, prompt: "make a word counter", files: [] }, deps);
  const cancelled = await startOsaBuild({ repo_dir: repoDir, run_id: plan.run_id, plan_sha256: plan.plan_sha256, decision: "cancel", accept_risky_assumptions: false, spec_only: false }, deps);
  assert.ok(!("refusal" in cancelled) && cancelled.status === "cancelled");
  const st = await osaRunStatus({ repo_dir: repoDir, run_id: plan.run_id });
  assert.ok(!("refusal" in st) && st.state === "cancelled");
  const again = await startOsaBuild({ repo_dir: repoDir, run_id: plan.run_id, plan_sha256: plan.plan_sha256, decision: "lock", accept_risky_assumptions: true, spec_only: true }, deps);
  assert.ok("refusal" in again && /already decided/.test(again.refusal));
});

test("osa_build locks EXACTLY the plan that was shown, starts at once, and osa_status follows the run to its report", async () => {
  const repoDir = await tempGitRepo();
  const deps = realDeps();
  const plan = await planOsaRun({ repo_dir: repoDir, prompt: "make a word counter", files: [] }, deps);
  const t0 = Date.now();
  const started = await startOsaBuild({ repo_dir: repoDir, run_id: plan.run_id, plan_sha256: plan.plan_sha256, decision: "lock", accept_risky_assumptions: true, spec_only: true }, deps);
  assert.ok(!("refusal" in started) && started.status === "started");
  assert.ok(Date.now() - t0 < 5000, "returns at once; the work continues in the background");
  assert.deepEqual(runningJobs(), [plan.run_id]);
  const during = await osaRunStatus({ repo_dir: repoDir });
  assert.ok(!("refusal" in during) && during.run_id === plan.run_id && (during.state === "running" || during.state === "finished"));

  await waitForJobs();
  assert.deepEqual(runningJobs(), []);
  const done = await osaRunStatus({ repo_dir: repoDir, run_id: plan.run_id });
  assert.ok(!("refusal" in done));
  assert.equal(done.state, "finished", done.message);
  const report = done.report as OsaRunReport;
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(report.stage, "spec", "spec_only stops after the spec");
  assert.equal(report.prd_sha256, plan.plan_sha256, "the locked plan is byte-identical to the one the person was shown");
  assert.equal(report.run_id, plan.run_id);
  const names = await eventNames(repoDir, plan.run_id);
  assert.ok(names.includes("prd_locked") && names.includes("spec_written"));
  assert.ok(names.filter((n) => n === "assumptions_generated").length === 1, "intake ran once, in osa_plan; the build did not ask the model for a second plan");
  assert.ok((await readdir(`${repoDir}/runs/${plan.run_id}/spec`)).includes("PHASE_1_SPEC.md"));
});

test("only one build per repository at a time; a second must wait", async () => {
  const repoDir = await tempGitRepo();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  // a pipeline whose build call waits on the gate (the plans are written directly below)
  const fakeRun = async (opts: { stopAfterPlan?: boolean; fromDraft?: boolean }, d: { runId?: string }): Promise<OsaRunReport> => {
    const runId = d.runId ?? "22222222-2222-4222-8222-222222222222";
    const report = { schema_version: 1, generated_at: "t", run_id: runId, ok: true, exit_code: 0, stage: "spec", lock: "locked", prd_path: null, prd_sha256: null, assumptions: { risky: 0, safe: 1 }, research: null, spec: null, build: null, agents: null, summary_path: null, warnings: [], problems: [] } as unknown as OsaRunReport;
    await gate;
    return report;
  };
  const a = "44444444-4444-4444-8444-444444444444";
  const b = "55555555-5555-4555-8555-555555555555";
  for (const id of [a, b]) {
    await mkdir(`${repoDir}/runs/${id}`, { recursive: true });
    await mkdir(`${repoDir}/.osa/runs/${id}`, { recursive: true });
    const md = renderBabyPrd(samplePrd());
    await writeFile(`${repoDir}/runs/${id}/baby-prd.md`, md, "utf8");
    await writeFile(`${repoDir}/.osa/runs/${id}/plan-request.json`, JSON.stringify({ prompt: "p", files: [], plan_sha256: sha256String(md), created_at: "t" }), "utf8");
  }
  const sha = sha256String(renderBabyPrd(samplePrd()));
  const deps: OsaToolDeps = { run: ((o: never, d: never) => fakeRun(o, d as { runId?: string })) as never };
  const first = await startOsaBuild({ repo_dir: repoDir, run_id: a, plan_sha256: sha, decision: "lock", accept_risky_assumptions: true, spec_only: false }, deps);
  assert.ok(!("refusal" in first) && first.status === "started");
  const second = await startOsaBuild({ repo_dir: repoDir, run_id: b, plan_sha256: sha, decision: "lock", accept_risky_assumptions: true, spec_only: false }, deps);
  assert.ok("refusal" in second && /still building in this repository/.test(second.refusal));
  release();
  await waitForJobs();
  const third = await startOsaBuild({ repo_dir: repoDir, run_id: b, plan_sha256: sha, decision: "lock", accept_risky_assumptions: true, spec_only: false }, deps);
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

test("the three tools are registered on the server with the descriptions that tell the assistant to ask the person first", () => {
  const server = buildMcpServer() as unknown as { _registeredTools: Record<string, { description?: string }> };
  const tools = server._registeredTools;
  assert.match(tools["osa_plan"]?.description ?? "", /MUST show the person the plan/);
  assert.match(tools["osa_plan"]?.description ?? "", /NOTHING is built or locked/);
  assert.match(tools["osa_build"]?.description ?? "", /Only after the person has approved/);
  assert.match(tools["osa_build"]?.description ?? "", /accept_risky_assumptions/);
  assert.match(tools["osa_status"]?.description ?? "", /tens of minutes/);
});
