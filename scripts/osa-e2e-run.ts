// Runs one OSA build exactly as `osa "<prompt>"` does, except that the lock is answered by a SCRIPTED reviewer instead of a person at a terminal:
// it prints the TL;DR + PRD it was shown (so the risky assumptions it accepted are on record) and chooses "lock". Used by the Suite 9 live runs
// because --yes refuses to lock whenever intake tags any assumption risky, and intake does so for most prompts (docs/osa/TEST_REPORT.md).
//
//   node scripts/osa-e2e-run.ts --repo-dir <dir> --prompt-file <file> [--out report.json] [--spec-only]
import { readFileSync, writeFileSync } from "node:fs";
import { renderOsaRunReport, runOsaCommand } from "../src/osa/pipeline.ts";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}
const repoDir = arg("repo-dir");
const prompt = readFileSync(arg("prompt-file"), "utf8").trim();
const shown: string[] = [];
const report = await runOsaCommand(
  { prompt, files: [], repoDir, yes: false, json: true, build: !process.argv.includes("--spec-only") },
  { interactive: true, io: { show: (t) => void shown.push(t), choose: () => Promise.resolve<"lock">("lock"), edit: () => Promise.resolve() } },
);
const out = process.argv.includes("--out") ? arg("out") : null;
if (out !== null) writeFileSync(out, JSON.stringify({ report, lockScreen: shown.join("\n") }, null, 2));
process.stdout.write(`${renderOsaRunReport(report)}\n`);
process.exitCode = report.exit_code;
