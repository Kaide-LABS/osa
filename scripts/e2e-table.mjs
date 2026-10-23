// Renders the Suite 9 comparison table for docs/osa/TEST_REPORT.md from finished run folders (see scripts/e2e-summarize.mjs).
//   node scripts/e2e-table.mjs <label=dir> [<label=dir> ...]
import { execFileSync } from "node:child_process";

const rows = process.argv.slice(2).map((a) => {
  const i = a.indexOf("=");
  const label = a.slice(0, i);
  const dir = a.slice(i + 1);
  const s = JSON.parse(execFileSync("node", [new URL("./e2e-summarize.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), dir, "--json"], { encoding: "utf8" }));
  return { label, s };
});
const k = (n) => (n === undefined || n === null ? "-" : Number(n).toLocaleString("en-US"));
const mins = (sec) => `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
const out = [
  "| run | outcome | wall time | est. tokens (run) | file exploration | research in | spec+PRD | handoffs | tool output | model out | provider-reported in / out / cache-read | trim-1 | code index calls (engine/confidence) | application check |",
  "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|",
];
for (const { label, s } of rows) {
  const c = s.tokens?.categories ?? {};
  const sh = s.tokens?.shares ?? {};
  const pc = (x) => (x === undefined ? "-" : `${k(c[x])} (${(100 * (sh[x] ?? 0)).toFixed(1)}%)`);
  const r = s.tokens?.reported;
  const trim = s.trim.applied > 0 ? `${k(s.trim.beforeTokens)} → ${k(s.trim.afterTokens)}` : s.trim.skipped.some((x) => /enabled is false/.test(x)) ? "off" : "none applied";
  const cs = s.codeSearch.length === 0 ? "-" : s.codeSearch.map((x) => `${x.engine}/${x.confidence}${x.abstained ? " ABSTAIN" : ""}`).join(", ");
  const app = s.application === null ? "not reached" : `${s.application.met}/${s.application.criteria} met${s.application.passed ? "" : " — FAILED"}`;
  out.push(`| ${label} | ${s.application === null ? "STOPPED before the check" : "completed"} | ${mins(s.wallSeconds)} | ${k(s.tokens?.total)} | ${pc("file_exploration")} | ${pc("research_input")} | ${pc("spec_prd")} | ${pc("handoffs")} | ${pc("tool_output")} | ${pc("model_output")} | ${r === undefined ? "-" : `${k(r.inputTokens)} / ${k(r.outputTokens)} / ${k(r.cacheReadTokens)}`} | ${trim} | ${cs} | ${app} |`);
}
process.stdout.write(out.join("\n") + "\n");
