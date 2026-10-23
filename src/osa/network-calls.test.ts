// Suite 3: a complete mocked OSA run (intake -> lock -> research -> spec -> agents -> build -> summary) makes network
// requests ONLY through the research clients' injected fetch, only to allowlisted hosts. Anything else that touched
// the global fetch would hit this spy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { defaultOsaConfig } from "../domain/osa-config.ts";
import { ALLOWED_HOSTS, MinIntervalLimiter } from "../research/net/http.ts";
import type { FetchFn } from "../research/net/http.ts";
import { NoopTrimmer } from "../trim/trimmer.ts";
import { MemoryEventSink } from "./events.ts";
import { fakeModel, researchFetch, tempGitRepo } from "./fixtures.test.ts";
import { runOsaCommand } from "./pipeline.ts";

const RUN = "bcdbcdbc-dbcd-4bcd-8bcd-bcdbcdbcdbcd";

test("a full run reaches only allowlisted research hosts and never the global fetch", async () => {
  const globalCalls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    globalCalls.push(String(input));
    return Promise.reject(new Error("global fetch must not be used by a run"));
  }) as typeof fetch;
  const researchHosts: string[] = [];
  const recording: FetchFn = (url, init) => {
    researchHosts.push(new URL(url).hostname);
    return researchFetch(url, init);
  };
  try {
    const repoDir = await tempGitRepo();
    const report = await runOsaCommand(
      { prompt: "make a counter", files: [], repoDir, yes: true, json: false },
      {
        events: new MemoryEventSink(RUN),
        io: { show: () => undefined, choose: () => Promise.resolve("lock" as const), edit: () => Promise.resolve() },
        interactive: true,
        runId: RUN,
        config: defaultOsaConfig(),
        textCall: fakeModel().call,
        research: { http: { fetchFn: recording, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
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
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(globalCalls, [], "nothing used the global fetch directly");
  assert.ok(researchHosts.length > 0, "the research stage did make (mocked) requests");
  for (const h of researchHosts) assert.ok(ALLOWED_HOSTS.includes(h), `unexpected host: ${h}`);
});
