// Re-runs ONLY the application check (the pipeline's last agent) on an already-built OSA project, with the checking provider of your choice.
// Used by Suite 9 to find out whether a failed check was the build's fault or the checking agent's environment: the Streamlit run's check was
// carried out by Codex, whose sandbox could not start `streamlit`, so 14 of 17 criteria were "unmet" because nothing could be exercised.
//
//   node scripts/app-check-rerun.ts --repo-dir <dir> --provider claude-code [--out verdict.json]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { runApplicationAgent } from "../src/agents/application.ts";
import { makeTextCall } from "../src/dispatch/text-call.ts";
import { MemoryEventSink } from "../src/osa/events.ts";
import { parseBabyPrd } from "../src/osa/baby-prd.ts";
import type { ProviderId } from "../src/domain/run.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const repoDir = arg("repo-dir");
const provider = (arg("provider") ?? "claude-code") as ProviderId;
if (repoDir === undefined) throw new Error("--repo-dir is required");
const runDir = readdirSync(`${repoDir}/runs`).find((d) => readdirSync(`${repoDir}/runs/${d}`).includes("baby-prd.md"));
if (runDir === undefined) throw new Error("no OSA run (runs/<id>/baby-prd.md) in " + repoDir);
const base = `runs/${runDir}`;
const events = new MemoryEventSink();
const verdict = await runApplicationAgent({
  repoDir,
  prd: parseBabyPrd(readFileSync(`${repoDir}/${base}/baby-prd.md`, "utf8")),
  specMarkdown: readFileSync(`${repoDir}/${base}/spec/PHASE_1_SPEC.md`, "utf8"),
  prdPath: `${base}/baby-prd.md`,
  specPath: `${base}/spec/PHASE_1_SPEC.md`,
  contextPath: `${base}/spec/context.md`,
  provider,
  textCall: makeTextCall({ events, modelOverrides: { "codex-cli": "gpt-6-luna" } }),
  events,
  timeoutMs: 900_000,
  modelOverride: provider === "codex-cli" ? "gpt-6-luna" : null,
});
const out = arg("out");
if (out !== undefined) writeFileSync(out, JSON.stringify({ provider, verdict, events: events.events }, null, 2));
process.stdout.write(`${provider}: ${verdict.passed ? "PASSED" : "FAILED"} -- ${String(verdict.results.filter((r) => r.status === "met").length)} of ${String(verdict.results.length)} met${verdict.couldNotRun !== null ? `; could not run: ${verdict.couldNotRun}` : ""}\n`);
for (const r of verdict.results) process.stdout.write(`  ${r.id}: ${r.status} -- ${r.summary}\n`);
process.exitCode = verdict.passed ? 0 : 1;
