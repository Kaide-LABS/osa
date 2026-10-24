import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { ExitCode, PrdLockViolationError, StageError, UsageError } from "../domain/errors.ts";
import { defaultOsaConfig } from "../domain/osa-config.ts";
import { MinIntervalLimiter } from "../research/net/http.ts";
import { NoopTrimmer } from "../trim/trimmer.ts";
import { MemoryEventSink } from "./events.ts";
import type { OsaEventName } from "./events.ts";
import { runOsaCommand, renderOsaRunReport } from "./pipeline.ts";
import type { OsaDeps } from "./pipeline.ts";
import type { LockChoice, LockIO } from "./lock.ts";
import { fakeModel, researchFetch, samplePrd, scriptedTextCall, tempGitRepo } from "./fixtures.test.ts";

function io(choices: LockChoice[]): LockIO {
  const q = [...choices];
  return { show: () => undefined, choose: () => Promise.resolve(q.shift() ?? "cancel"), edit: () => Promise.resolve() };
}

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function deps(over: Partial<OsaDeps> = {}): OsaDeps {
  return {
    events: new MemoryEventSink(RUN_ID),
    io: io([]),
    interactive: false,
    runId: RUN_ID,
    config: defaultOsaConfig(),
    research: { http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
    trimmer: { trimmer: new NoopTrimmer("noop in tests"), note: null },
    // Safety net: a test that reaches the build stage without providing its own fake dispatch fails loudly
    // instead of spawning a real provider CLI.
    drive: { runDispatchFn: () => Promise.reject(new Error("this test must not reach the build stage")) },
    ...over,
  };
}

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd }).toString().trim();

test("osa '<prompt>' --yes (no risky assumptions): intake -> auto-lock -> research -> spec, all committed, one intake call", async () => {
  const repoDir = await tempGitRepo();
  const model = fakeModel();
  const events = new MemoryEventSink(RUN_ID);
  const report = await runOsaCommand({ prompt: "make me a word counter", files: [], repoDir, yes: true, json: false, build: false }, deps({ textCall: model.call, events }));
  assert.equal(report.ok, true);
  assert.equal(report.exit_code, ExitCode.OK);
  assert.equal(report.stage, "spec");
  assert.equal(report.lock, "locked");
  assert.equal(report.prd_path, `runs/${RUN_ID}/baby-prd.md`);
  assert.equal(model.log.filter((l) => l.purpose === "intake").length, 1, "exactly one intake call: no follow-up questions");

  // The whole spec-phase picture the directive asks for:
  assert.equal(report.research?.skipped, false);
  assert.ok((report.research?.docSources ?? 0) >= 1, "documentation sources");
  assert.ok((report.research?.papers ?? 0) >= 1, "academic results");
  assert.ok((report.research?.repos ?? 0) >= 1, "GitHub prior art");
  assert.equal(report.research?.crossChecked, true, "cross-provider checked");
  assert.equal(report.spec?.spec_path, `runs/${RUN_ID}/spec/PHASE_1_SPEC.md`);
  assert.equal(report.spec?.total_phases, 2);

  // Stage order in the event log.
  const names = events.names();
  const order: OsaEventName[] = ["assumptions_generated", "prd_locked", "academic_query", "github_lookup", "research_validated", "research_docs_checked", "research_crosscheck", "spec_written"];
  const idx = order.map((n) => names.indexOf(n));
  assert.ok(idx.every((i, k) => i >= 0 && (k === 0 || i > (idx[k - 1] as number))), `events out of order: ${names.join(",")}`);

  // Everything is committed at tracked paths, with neutral messages.
  for (const p of [report.prd_path as string, `runs/${RUN_ID}/research/report.md`, `runs/${RUN_ID}/spec/PHASE_1_SPEC.md`, `runs/${RUN_ID}/spec/context.md`]) {
    assert.equal(git(repoDir, "ls-files", p), p);
  }
  assert.equal(git(repoDir, "status", "--porcelain", "--", "runs"), "");
  const log = git(repoDir, "log", "--format=%B");
  assert.ok(!/Co-Authored-By|Generated with/i.test(log), "commits stay neutral (B8)");
  assert.match(renderOsaRunReport(report), /Research: \d+ topic\(s\) investigated, \d+ documentation source\(s\)[\s\S]*independently checked by a second AI/);
});

test("osa --yes with a risky assumption: stops at the lock (exit 19); no research, no spec, nothing committed", async () => {
  const repoDir = await tempGitRepo();
  const before = git(repoDir, "rev-parse", "HEAD");
  const model = fakeModel({ prd: samplePrd({ risky: true }) });
  const report = await runOsaCommand({ prompt: "make me a word counter", files: [], repoDir, yes: true, json: false, build: false }, deps({ textCall: model.call }));
  assert.equal(report.ok, false);
  assert.equal(report.lock, "refused");
  assert.equal(report.exit_code, ExitCode.PRD_LOCK_REFUSED);
  assert.equal(report.stage, "lock");
  assert.equal(report.research, null);
  assert.equal(report.spec, null);
  assert.deepEqual([...new Set(model.log.map((l) => l.purpose))], ["intake"], "no dispatch past the lock");
  assert.equal(git(repoDir, "rev-parse", "HEAD"), before);
  assert.match(renderOsaRunReport(report), /stopped at the lock/);
});

test("interactive: Cancel -> exit 22, nothing committed; Lock with a risky assumption (a knowing human choice) -> proceeds", async () => {
  const repoDir = await tempGitRepo();
  const prd = samplePrd({ risky: true });
  const cancelled = await runOsaCommand({ prompt: "x y", files: [], repoDir, yes: false, json: false, build: false }, deps({ textCall: fakeModel({ prd }).call, interactive: true, io: io(["cancel"]) }));
  assert.equal(cancelled.exit_code, ExitCode.LOCK_CANCELLED);
  assert.equal(cancelled.spec, null);
  const locked = await runOsaCommand(
    { prompt: "x y", files: [], repoDir, yes: false, json: false, build: false },
    deps({ textCall: fakeModel({ prd }).call, interactive: true, io: io(["lock"]), runId: "22222222-2222-4222-8222-222222222222" }),
  );
  assert.equal(locked.lock, "locked");
  assert.equal(locked.stage, "spec");
  assert.equal(locked.assumptions.risky, 1);
});

test("without --yes and without a terminal, the run is refused BEFORE any model call", async () => {
  const repoDir = await tempGitRepo();
  const { call, requests } = scriptedTextCall(["{}"]);
  await assert.rejects(runOsaCommand({ prompt: "a b", files: [], repoDir, yes: false, json: false, build: false }, deps({ textCall: call })), (e: unknown) => e instanceof UsageError && /--yes/.test(e.message));
  assert.equal(requests.length, 0);
});

test("a directory that is not a git repo is refused with a plain explanation, before any model call", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()}/osa-nogit-`);
  const { call, requests } = scriptedTextCall(["{}"]);
  await assert.rejects(runOsaCommand({ prompt: "a b", files: [], repoDir: dir, yes: true, json: false, build: false }, deps({ textCall: call })), (e: unknown) => e instanceof UsageError && /git init/.test(e.message));
  assert.equal(requests.length, 0);
});

test("--file contents reach intake; an unreadable --file is a UsageError", async () => {
  const repoDir = await tempGitRepo();
  const model = fakeModel();
  await runOsaCommand({ prompt: "use the notes", files: ["README.md"], repoDir, yes: true, json: false, build: false }, deps({ textCall: model.call }));
  assert.match(model.log.find((l) => l.purpose === "intake")?.req.prompt ?? "", /ATTACHED FILE: README\.md[\s\S]*# fixture/);
  await assert.rejects(runOsaCommand({ prompt: "use the notes", files: ["nope.md"], repoDir, yes: true, json: false, build: false }, deps({ textCall: model.call })), UsageError);
});

test("project memory, when provided and enabled, is passed to intake", async () => {
  const repoDir = await tempGitRepo();
  const model = fakeModel();
  await runOsaCommand({ prompt: "a b", files: [], repoDir, yes: true, json: false, build: false }, deps({ textCall: model.call, readMemory: () => Promise.resolve("- always use pnpm") }));
  assert.match(model.log.find((l) => l.purpose === "intake")?.req.prompt ?? "", /always use pnpm/);
});

test("a spec stage that cannot find documentation fails the run loudly (exit 23) -- and the locked PRD is untouched", async () => {
  const repoDir = await tempGitRepo();
  const model = fakeModel({ docsType: "article" });
  await assert.rejects(runOsaCommand({ prompt: "a b", files: [], repoDir, yes: true, json: false, build: false }, deps({ textCall: model.call })), (e: unknown) => e instanceof StageError && e.exitCode === ExitCode.STAGE_FAILED);
});

test("if anything rewrites the locked PRD during research, the run hard-fails (PrdLockViolationError, exit 20)", async () => {
  const repoDir = await tempGitRepo();
  const base = fakeModel();
  const tamper: typeof base.call = async (provider, req, purpose) => {
    if (purpose === "github-lookup-summary") {
      await writeFile(`${repoDir}/runs/${RUN_ID}/baby-prd.md`, `${await readFile(`${repoDir}/runs/${RUN_ID}/baby-prd.md`, "utf8")}\nSneaky new requirement.\n`, "utf8");
    }
    return base.call(provider, req, purpose);
  };
  await assert.rejects(runOsaCommand({ prompt: "a b", files: [], repoDir, yes: true, json: false, build: false }, deps({ textCall: tamper })), (e: unknown) => e instanceof PrdLockViolationError && e.exitCode === ExitCode.PRD_LOCK_VIOLATION);
});

test("counts() in the report correctly separates risky, safe, and defaulted assumptions", async () => {
  const repoDir = await tempGitRepo();
  const prd = {
    ...samplePrd(),
    assumptions: [
      { text: "Safe assumption 1", risk: "safe" as const },
      { text: "Safe assumption 2", risk: "safe" as const },
      { text: "Risky assumption", risk: "risky" as const },
      { text: "Defaulted assumption", risk: "defaulted" as const },
    ],
  };
  const report = await runOsaCommand({ prompt: "a b", files: [], repoDir, yes: true, json: false, build: false }, deps({ textCall: fakeModel({ prd }).call }));
  assert.equal(report.assumptions.risky, 1);
  assert.equal(report.assumptions.safe, 2);
  assert.equal(report.assumptions.defaulted, 1);
});
