// Suite 8: step 14 (the plain-language comprehension pass) must happen on EVERY run, including a run whose build halts. A failed run is
// precisely when a non-engineer most needs the plain explanation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { defaultOsaConfig } from "../domain/osa-config.ts";
import { MinIntervalLimiter } from "../research/net/http.ts";
import { NoopTrimmer } from "../trim/trimmer.ts";
import { MemoryEventSink } from "./events.ts";
import { fakeModel, researchFetch, tempGitRepo } from "./fixtures.test.ts";
import { runOsaCommand } from "./pipeline.ts";

const RUN = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";
const io = { show: () => undefined, choose: () => Promise.resolve("lock" as const), edit: () => Promise.resolve() };

test("a build that HALTS in phase 1 still gets a step-14 note and a plain-language summary (no raw jargon outside 'For engineers')", async () => {
  const repoDir = await tempGitRepo();
  const events = new MemoryEventSink(RUN);
  const model = fakeModel();
  const report = await runOsaCommand(
    { prompt: "make a word counter", files: [], repoDir, yes: true, json: false },
    {
      events,
      io,
      interactive: true,
      runId: RUN,
      config: defaultOsaConfig(),
      textCall: model.call,
      research: { http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
      trimmer: { trimmer: new NoopTrimmer("noop"), note: null },
      drive: {
        runDispatchFn: (async (rc: { spec_path: string }) => {
          const dir = rc.spec_path.slice(0, rc.spec_path.lastIndexOf("/") + 1);
          await mkdir(`${repoDir}/${dir}`, { recursive: true });
          return { ok: false, exitCode: 14, turns: [], halt: { reason: "executor B reported blocked: needs a decision" }, problems: ["Failed to parse C:/Users/hp/x/000-executor.json: Unexpected token"], warnings: [] };
        }) as never,
      },
    },
  );
  assert.equal(report.ok, false);
  assert.ok(report.summary_path !== null, "a summary was written even though the build failed");
  const md = await readFile(`${repoDir}/${report.summary_path as string}`, "utf8");
  const split = md.indexOf("## For engineers (technical detail)");
  assert.ok(split > 0);
  const plain = md.slice(0, split);
  assert.match(plain, /did not finish|didn't finish|stopped/i, "the failure is stated first, plainly");
  assert.ok(!/[A-Za-z]:[\x5c/]|\.json|Unexpected token|exit code|stack trace|TypeError|ENOENT/i.test(plain), "no raw path, JSON error or jargon in the plain part");
  assert.match(md.slice(split), /Unexpected token/, "the technical detail IS available, under the engineers heading");

  // step 14 itself: a phase note exists for the phase that failed, and it is in plain language
  const step14Files = await readdir(`${repoDir}/runs/${RUN}/step14`).catch(() => [] as string[]);
  assert.ok(step14Files.some((f) => /phase-1/.test(f)), `step 14 produced a phase-1 note even though the phase failed: ${step14Files.join(", ")}`);
  assert.ok(events.events.some((e) => e.event === "step14_done"), "step14_done was logged");
});

test("a build that completes: every phase has a step-14 note and the summary's plain part has no file paths, hashes or code", async () => {
  const repoDir = await tempGitRepo();
  const events = new MemoryEventSink(RUN);
  const report = await runOsaCommand(
    { prompt: "make a word counter", files: [], repoDir, yes: true, json: false },
    {
      events,
      io,
      interactive: true,
      runId: RUN,
      config: defaultOsaConfig(),
      textCall: fakeModel().call,
      research: { http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
      trimmer: { trimmer: new NoopTrimmer("noop"), note: null },
      drive: {
        runDispatchFn: (async (rc: { spec_path: string; phase: number; is_final_phase: boolean }) => {
          const dir = rc.spec_path.slice(0, rc.spec_path.lastIndexOf("/") + 1);
          await mkdir(`${repoDir}/${dir}`, { recursive: true });
          await writeFile(rc.is_final_phase ? `${repoDir}/BUILD_COMPLETE.md` : `${repoDir}/${dir}PHASE_${String(rc.phase + 1)}_SPEC.md`, "x\n", "utf8");
          return { ok: true, exitCode: 0, turns: [], halt: null, problems: [], warnings: [] };
        }) as never,
      },
    },
  );
  assert.equal(report.ok, true);
  const done = events.events.filter((e) => e.event === "step14_done");
  assert.ok(done.length >= 2, `step 14 ran after each of the ${String(done.length)} phases`);
  const md = await readFile(`${repoDir}/${report.summary_path as string}`, "utf8");
  const plain = md.slice(0, md.indexOf("## For engineers") === -1 ? undefined : md.indexOf("## For engineers"));
  assert.ok(!/[A-Za-z]:[\x5c/]|\/src\/|\b[0-9a-f]{40}\b|```|\.ts\b|\.js\b/.test(plain), "no path, hash, code fence or file extension in the plain part");
});
