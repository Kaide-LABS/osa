// Suite 5: kill the research stage mid-batch (a real child process that dies with exit 137 and no cleanup), re-run it, and the items that
// finished before the kill are skipped -- only the unfinished item is researched again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { OsaConfig } from "../domain/osa-config.ts";
import { MemoryEventSink } from "../osa/events.ts";
import { fakeModel, researchFetch, samplePrd, tempGitRepo } from "../osa/fixtures.test.ts";
import { MinIntervalLimiter } from "./net/http.ts";
import { runResearchStage } from "./stage.ts";

const RUN = "eeffeeff-effe-4eef-8eef-eeffeeffeeff";
const CHILD = new URL("../../scripts/research-kill-child.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("RESUME after a hard kill mid-batch: finished items are skipped, only the unfinished one is researched, and the report is complete", async () => {
  const repoDir = await tempGitRepo();
  const child = spawnSync(process.execPath, [CHILD, repoDir, RUN, "2"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(child.status, 137, `the child must die abruptly: ${child.stderr}`);

  const resultsDir = `${repoDir}/runs/${RUN}/research/results`;
  const survivors = (await readdir(resultsDir)).filter((f) => f.endsWith(".json") && f !== "academic-papers.json" && f !== "prior-art.json").sort();
  assert.equal(survivors.length, 2, `two items finished before the kill: ${survivors.join(", ")}`);

  const events = new MemoryEventSink(RUN);
  const base = fakeModel();
  const researched: string[] = [];
  const r = await runResearchStage({
    repoDir,
    runId: RUN,
    prd: samplePrd(),
    config: OsaConfig.parse({ research: { batchSize: 2 } }),
    events,
    http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() },
    arxivLimiter: new MinIntervalLimiter(0),
    env: {},
    textCall: (provider, req, purpose) => {
      if (purpose.startsWith("research:")) researched.push(purpose.slice("research:".length));
      return base.call(provider, req, purpose);
    },
  });
  const done = events.events.filter((e) => e.event === "research_item_done");
  assert.equal(done.filter((e) => e.data["status"] === "resumed").length, 2, "both finished items were resumed from disk");
  assert.equal(done.filter((e) => e.data["status"] === "done").length, 1, "exactly one item was researched again");
  assert.equal(researched.length, 1, `only the unfinished item reached a model: ${researched.join(", ")}`);
  assert.ok(!survivors.includes(`${researched[0] as string}.json`), "and it is not one of the survivors");
  assert.equal(r.outcomes.length, 3);
  assert.ok(r.outcomes.every((o) => o.status !== "failed"));
  assert.match(r.reportMd, /## Findings/);
});
