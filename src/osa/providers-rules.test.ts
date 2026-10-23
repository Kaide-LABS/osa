// Suite 6: provider and seat rules at the OSA level. (Config-level and harness-level rules have their own tests; these go through the
// whole `osa` command.) A structurally impossible setup (role pins that leave no reviewer or no executor) is refused before anything is
// dispatched. A setup with ONE provider is not impossible: it runs, with the review separated by model and its independence reported.

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
  const runConfigs: { executor_providers: readonly string[]; seat_models?: readonly (string | null)[] }[] = [];
  const events = new MemoryEventSink(RUN);
  let error: unknown = null;
  let report = null;
  try {
    report = await runOsaCommand(
      { prompt: "make a word counter", files: [], repoDir, yes: true, json: false },
      {
        events,
        io,
        interactive: true,
        runId: RUN,
        config,
        textCall: fakeModel().call,
        research: { http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
        trimmer: { trimmer: new NoopTrimmer("noop"), note: null },
        drive: { runDispatchFn: ((rc: { spec_path: string; executor_providers: readonly string[]; seat_models?: readonly (string | null)[] }) => { dispatched.push(rc.spec_path); runConfigs.push(rc); return Promise.resolve({ ok: true, exitCode: 0, turns: [], halt: null, problems: [], warnings: [] }); }) as never },
      },
    );
  } catch (e) {
    error = e;
  }
  return { error, report, dispatched, runConfigs, events };
}

test("ONE provider in both seats is a valid setup: it parses, runs to completion, hands the build two different models, and reports the review's independence", async () => {
  const cfg = OsaConfig.parse({ providers: { pair: ["claude-code", "claude-code"] } });
  const { error, report, dispatched, runConfigs, events } = await attempt(cfg);
  assert.equal(error, null);
  // (this harness's fake dispatch never writes the next-phase marker, so the run itself ends "ambiguous"; what matters here is that nothing refused it)
  assert.ok(!(report?.problems ?? []).some((x) => /provider|model|seat|independen/i.test(x)), JSON.stringify(report?.problems));
  assert.ok(dispatched.length > 0, "the build was dispatched");
  const rc = runConfigs[0];
  assert.deepEqual(rc?.executor_providers, ["claude-code", "claude-code"]);
  const [m0, m1] = rc?.seat_models ?? [null, null];
  assert.ok(m0 !== null && m1 !== null && m0 !== m1, "the two seats run different models");
  const ev = events.events.find((e) => e.event === "review_independence" && e.data["role"] === "build");
  assert.equal(ev?.data["level"], "different-class");
  assert.match(report?.review?.text ?? "", /same model family but a different capability class/);
  assert.equal(events.names().includes("seats_resolved"), true);
});

test("a same-model setup the person wrote on purpose is still not refused: it runs, and the weak review is a warning with advice", async () => {
  const cfg = OsaConfig.parse({ providers: { pair: ["claude-code", "claude-code"], independence: "off" } });
  const { error, report } = await attempt(cfg);
  assert.equal(error, null);
  assert.ok(!(report?.problems ?? []).some((x) => /provider|model|seat|independen/i.test(x)), JSON.stringify(report?.problems));
  assert.equal(report?.review?.level, "same-model");
  assert.ok(report?.warnings.some((w) => /the same model/.test(w)), "the weak review is stated");
  assert.ok(report?.warnings.some((w) => /install a second provider|seatModels/.test(w)), "with advice on how to make the review more independent");
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
