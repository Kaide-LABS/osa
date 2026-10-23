// Precomputes query rewrites (src/code-index/rewrite.ts) for the labelled code-search queries, with a small model, so an evaluation run is repeatable and
// costs no model calls. One file per variant:
//
//   node scripts/code-search-rewrites.ts --queries evals/code-search/queries.json,evals/code-search/queries-heldout.json --out <file.json> [--paths] [--model <name>] [--provider claude-code]
//
// --paths shows the model the project's file paths (a cheap listing) so guessed names can follow the project's own vocabulary.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { makeTextCall } from "../src/dispatch/text-call.ts";
import { buildRewritePrompt, parseRewrite } from "../src/code-index/rewrite.ts";
import type { QueryRewrite } from "../src/code-index/rewrite.ts";
import type { ProviderId } from "../src/domain/run.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}
const files = arg("queries", "evals/code-search/queries.json").split(",");
const out = arg("out", "rewrites.json");
const withPaths = process.argv.includes("--paths");
const model = arg("model", "haiku");
const provider = arg("provider", "claude-code") as ProviderId;
const snapshots = arg("snapshots", "C:/Users/hp/osa-tools/eval-snapshots");
const concurrency = Number(arg("concurrency", "4"));
const SKIP = new Set(["node_modules", "dist", ".git", ".osa", "__pycache__", ".venv", "build", "coverage"]);

function listPaths(root: string, cap = 400): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP.has(name)) continue;
      const abs = `${dir}/${name}`;
      const r = rel === "" ? name : `${rel}/${name}`;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else found.push(r);
    }
  };
  walk(root, "");
  return found.slice(0, cap);
}

const LANG: Record<string, string> = { osa: "TypeScript", "osa-clean": "TypeScript", hostel: "Python", hms: "Python" };
const pathCache = new Map<string, string[]>();
const jobs: { repo: string; query: string }[] = [];
for (const f of files) for (const q of (JSON.parse(readFileSync(f, "utf8")) as { queries: { repo: string; query: string }[] }).queries) jobs.push({ repo: q.repo, query: q.query });

const call = makeTextCall({});
const table: Record<string, QueryRewrite> = {};
let done = 0;
let failed = 0;
async function worker(): Promise<void> {
  for (;;) {
    const job = jobs.shift();
    if (job === undefined) return;
    if (withPaths && !pathCache.has(job.repo)) pathCache.set(job.repo, listPaths(`${snapshots}/${job.repo}`));
    const prompt = buildRewritePrompt(job.query, { ...(LANG[job.repo] !== undefined ? { language: LANG[job.repo] as string } : {}), ...(withPaths ? { paths: pathCache.get(job.repo) as string[] } : {}) });
    const r = await call(provider, { prompt, cwd: process.cwd(), timeoutMs: 120_000, tier: "high-volume-low-effort", webSearch: false, modelOverride: model }, "query-rewrite");
    const parsed = r.outcome.ok && r.outcome.text !== null ? parseRewrite(r.outcome.text) : null;
    if (parsed === null) failed++;
    else table[job.query] = parsed;
    done++;
    process.stderr.write(`[rewrites] ${String(done)} done, ${String(failed)} failed\r`);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
writeFileSync(out, JSON.stringify(table, null, 1));
process.stdout.write(`\nwrote ${String(Object.keys(table).length)} rewrites (${String(failed)} failed) to ${out}\n`);
