// Suite 6: cross-provider rules at the OSA level. (Config-level and harness-level rules have their own tests; these go through the
// whole `osa` command so a bad setup is proven to fail BEFORE anything is dispatched.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { OsaConfig, defaultOsaConfig } from "../domain/osa-config.ts";
import { MinIntervalLimiter } from "../research/net/http.ts";
import { NoopTrimmer } from "../trim/trimmer.ts";
import { MemoryEventSink } from "./events.ts";
import { fakeModel, researchFetch, tempGitRepo } from "./fixtures.test.ts";
import { runOsaCommand } from "./pipeline.ts";

const RUN = "eff0eff0-eff0-4ff0-8ff0-eff0eff0eff0";
const io = { show: () => undefined, choose: () => Promise.resolve("lock" as const), edit: () => Promise.resolve() };

async function attempt(config: ReturnType<typeof defaultOsaConfig>) {
  const repoDir = await tempGitRepo();
  const dispatched: string[] = [];
  let error: unknown = null;
  let report = null;
  try {
    report = await runOsaCommand(
      { prompt: "make a word counter", files: [], repoDir, yes: true, json: false },
      {
        events: new MemoryEventSink(RUN),
        io,
        interactive: true,
        runId: RUN,
        config,
        textCall: fakeModel().call,
        research: { http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
        trimmer: { trimmer: new NoopTrimmer("noop"), note: null },
        drive: { runDispatchFn: ((rc: { spec_path: string }) => { dispatched.push(rc.spec_path); return Promise.resolve({ ok: true, exitCode: 0, turns: [], halt: null, problems: [], warnings: [] }); }) as never },
      },
    );
  } catch (e) {
    error = e;
  }
  return { error, report, dispatched };
}

test("a setup where both providers are the same fails when the config is parsed, loudly, before any run", () => {
  assert.throws(() => OsaConfig.parse({ providers: { pair: ["claude-code", "claude-code"] } }), /two different providers/);
});

test("role pins that remove the reviewer (both providers pinned to executor) are refused by the whole command and nothing is dispatched", async () => {
  const cfg = OsaConfig.parse({ providers: { pair: ["claude-code", "codex-cli"], rolePins: { "claude-code": "executor", "codex-cli": "executor" } } });
  const { error, report, dispatched } = await attempt(cfg);
  assert.deepEqual(dispatched, [], "no build turn was handed to anyone");
  const msg = error instanceof Error ? error.message : report !== null ? JSON.stringify(report.problems) : "";
  assert.ok(error !== null || report?.ok === false, "the run did not succeed");
  assert.match(msg, /role|pin|reviewer|executor|cross-provider/i, msg);
});

test("role pins that remove an executor are refused too", async () => {
  const cfg = OsaConfig.parse({ providers: { pair: ["claude-code", "codex-cli"], rolePins: { "claude-code": "reviewer", "codex-cli": "reviewer" } } });
  const { error, report, dispatched } = await attempt(cfg);
  assert.deepEqual(dispatched, []);
  assert.ok(error !== null || report?.ok === false);
});
