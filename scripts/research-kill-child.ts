// Test helper (src/research/resume-kill.test.ts): runs the research stage against fakes and DIES ABRUPTLY (exit 137, no cleanup,
// like SIGKILL) at the moment the (killAfter+1)-th research item starts. Usage: node scripts/research-kill-child.ts <repoDir> <runId> <killAfter>
import { OsaConfig } from "../src/domain/osa-config.ts";
import { MemoryEventSink } from "../src/osa/events.ts";
import { fakeModel, researchFetch, samplePrd } from "../src/osa/fixtures.test.ts";
import { MinIntervalLimiter } from "../src/research/net/http.ts";
import { runResearchStage } from "../src/research/stage.ts";

const [repoDir, runId, killAfterRaw] = process.argv.slice(2);
if (repoDir === undefined || runId === undefined || killAfterRaw === undefined) throw new Error("usage: research-kill-child.ts <repoDir> <runId> <killAfter>");
const killAfter = Number(killAfterRaw);
const base = fakeModel();
let started = 0;
await runResearchStage({
  repoDir,
  runId,
  prd: samplePrd(),
  config: OsaConfig.parse({ research: { batchSize: 2 } }),
  events: new MemoryEventSink(runId),
  http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() },
  arxivLimiter: new MinIntervalLimiter(0),
  env: {},
  textCall: (provider, req, purpose) => {
    if (purpose.startsWith("research:")) {
      if (started >= killAfter) process.exit(137);
      started += 1;
    }
    return base.call(provider, req, purpose);
  },
});
process.exit(0);
