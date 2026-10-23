// Summarises one finished OSA run from its event log (Suite 9). Usage: node scripts/e2e-summarize.mjs <repo-dir> [--json]
// Prints wall time, the run-level token breakdown by category (estimated, chars/4) and the providers' reported usage, trim-1 savings,
// every code_search_engine event (engine, confidence, abstention) and the application-check result.
import { existsSync, readFileSync, readdirSync } from "node:fs";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: e2e-summarize.mjs <repo-dir> [--json]");
let events = null;
for (const f of readdirSync(`${dir}/.osa/runs`)) {
  const p = `${dir}/.osa/runs/${f}/events.jsonl`;
  if (!existsSync(p)) continue;
  const l = readFileSync(p, "utf8").trim().split("\n").map((x) => JSON.parse(x));
  if (l.some((e) => e.event === "run_started")) events = l;
}
if (events === null) throw new Error("no OSA run in " + dir);
const by = (name) => events.filter((e) => e.event === name).map((e) => e.data);
const t0 = Date.parse(events[0].at);
const t1 = Date.parse(events.at(-1).at);
const breakdowns = by("token_breakdown");
const run = breakdowns.find((b) => b.scope === "run") ?? null;
const phases = breakdowns.filter((b) => String(b.scope).startsWith("phase-"));
const trimApplied = by("trim_applied");
const trimSkipped = by("trim_skipped");
const cse = by("code_search_engine");
const app = by("application_check")[0] ?? null;
const sum = (a, k) => a.reduce((s, x) => s + (Number(x[k]) || 0), 0);
const out = {
  dir,
  wallSeconds: Math.round((t1 - t0) / 1000),
  finished: events.some((e) => e.event === "run_finished"),
  phases: phases.length,
  textCalls: by("text_call").length,
  failedTextCalls: by("text_call").filter((c) => c.ok === false).map((c) => ({ provider: c.provider, purpose: c.purpose, kind: c.failureKind, evidence: c.evidence ?? null })),
  tokens: run === null ? null : { total: run.total, categories: run.categories, shares: run.shares, reported: run.reported, toolCalls: run.toolCalls, explorationCalls: run.explorationCalls },
  perPhaseTotals: phases.map((p) => ({ scope: p.scope, total: p.total, explorationShare: p.shares?.file_exploration })),
  trim: { applied: trimApplied.length, skipped: trimSkipped.map((s) => `${s.label}: ${s.reason}`), beforeTokens: sum(trimApplied, "beforeTokens"), afterTokens: sum(trimApplied, "afterTokens") },
  codeSearch: cse.map((c) => ({ requested: c.requested, engine: c.engine, confidence: c.confidence, abstained: c.abstained, hits: c.hits, stale: c.stale, ms: c.ms, purpose: c.purpose })),
  application: app === null ? null : { provider: app.provider, criteria: app.criteria, met: app.met, unmet: app.unmet, passed: app.passed, couldNotRun: app.couldNotRun },
  injectionFlags: by("injection_flagged").map((f) => ({ kind: f.kind, source: f.source, rules: f.rules })),
  sandboxLeftover: by("application_sandbox_leftover").length,
};
if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
else {
  const k = (n) => (n === undefined || n === null ? "-" : String(n));
  process.stdout.write(
    [
      `run in ${dir}`,
      `wall time ${k(out.wallSeconds)} s, phases ${k(out.phases)}, text calls ${k(out.textCalls)}, finished: ${String(out.finished)}`,
      out.tokens === null ? "no run-level token_breakdown (the run did not reach its end)" : `tokens (estimated) total ${k(out.tokens.total)}: ${Object.entries(out.tokens.categories).map(([c, n]) => `${c} ${k(n)} (${(100 * (out.tokens.shares[c] ?? 0)).toFixed(1)}%)`).join(", ")}`,
      out.tokens === null ? "" : `provider-reported: ${JSON.stringify(out.tokens.reported)}`,
      `trim-1: ${k(out.trim.applied)} applied (${k(out.trim.beforeTokens)} -> ${k(out.trim.afterTokens)} tokens), skipped: ${out.trim.skipped.join("; ") || "none"}`,
      `code_search_engine: ${out.codeSearch.map((c) => `${c.engine}/${c.confidence}${c.abstained ? " ABSTAINED" : ""} (${k(c.hits)} hits, ${k(c.ms)} ms, ${c.purpose})`).join("; ") || "none"}`,
      `application check: ${out.application === null ? "none" : `${out.application.met}/${out.application.criteria} met, passed ${String(out.application.passed)}${out.application.couldNotRun ? `, could not run: ${out.application.couldNotRun}` : ""}`}`,
      `injection flags: ${out.injectionFlags.length}; failed text calls: ${out.failedTextCalls.length}${out.sandboxLeftover > 0 ? "; sandbox leftover: yes" : ""}`,
    ].filter((l) => l !== "").join("\n") + "\n",
  );
}
