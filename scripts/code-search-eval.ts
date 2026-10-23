// Runs the labelled code-search eval (evals/code-search/queries.json) over the pinned snapshots, for any set of engine configurations, and
// writes results + a markdown table. Reusable: this is how every row of the TEST_REPORT.md comparison table was produced.
//
//   node scripts/code-search-eval.ts --configs grep,lexical,cbm-bm25,cbm-semantic,cbm-guarded --out <dir> [--tag name] [--tuning file.json] [--ids osa-01,osa-02] [--k 5]
//   node scripts/code-search-eval.ts --tunings tunings.json --out <dir> --tag tuning-1      (the tuning loop; see below)
//
// A tunings file is a JSON array of { "name": "...", "config": "cbm-guarded" (default), "tuning": { ...partial Tuning, "weights": { ... } }, "per": per-channel result size }.
// Each entry is one row of the tuning log; the raw CBM channel results are fetched ONCE per question and re-fused under every entry, so changing
// one lever and re-running costs seconds. Entries run in order and each is a complete configuration (nothing carries over from the one before).
//
// Snapshots (git archive of the pinned commits) must exist under --snapshots (default C:/Users/hp/osa-tools/eval-snapshots/{osa,hostel,hms}); see
// evals/code-search/README.md. CBM must be installed at --cbm-work (default C:/osa-cbm; see docs/osa/CBM_NOTES.md).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CbmEngine } from "../src/code-index/cbm/engine.ts";
import type { CbmEngineOptions } from "../src/code-index/cbm/engine.ts";
import { GrepEngine, LexicalEngine } from "../src/code-index/engine.ts";
import type { CodeSearchEngine } from "../src/code-index/engine.ts";
import { aggregate, markdownTable, scoreQuery } from "../src/code-index/eval-score.ts";
import type { Label, QueryScore } from "../src/code-index/eval-score.ts";
import { DEFAULT_TUNING } from "../src/code-index/fusion.ts";
import { tableRewriter } from "../src/code-index/rewrite.ts";
import type { QueryRewrite } from "../src/code-index/rewrite.ts";
import type { ChannelName, Tuning } from "../src/code-index/fusion.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

type TuningPatch = Partial<Omit<Tuning, "weights">> & { weights?: Partial<Record<ChannelName, number>> };
const merge = (patch: TuningPatch): Tuning => ({ ...DEFAULT_TUNING, ...patch, weights: { ...DEFAULT_TUNING.weights, ...(patch.weights ?? {}) } });

const snapshots = arg("snapshots", "C:/Users/hp/osa-tools/eval-snapshots");
const queriesPath = arg("queries", "evals/code-search/queries.json");
const out = arg("out", "evals/code-search/results");
const tag = arg("tag", new Date().toISOString().replace(/[:.]/g, "-"));
const k = Number(arg("k", "5"));
const cbmWork = arg("cbm-work", "C:/osa-cbm");
const idFilter = arg("ids", "") === "" ? null : new Set(arg("ids", "").split(","));
const globalPer = Number(arg("per", "15"));
const globalTuning = merge(arg("tuning", "") === "" ? {} : (JSON.parse(readFileSync(arg("tuning", ""), "utf8")) as TuningPatch));

const ALL: Record<ChannelName, boolean> = { bm25: true, semantic: true, code: true, lexical: true, trace: true };
const ONLY = (c: ChannelName): Record<ChannelName, boolean> => ({ bm25: false, semantic: false, code: false, lexical: false, trace: false, [c]: true });
const CBM_CONFIGS: Record<string, Pick<CbmEngineOptions, "guard" | "channels">> = {
  "cbm-bm25": { guard: false, channels: ONLY("bm25") },
  "cbm-semantic": { guard: false, channels: ONLY("semantic") },
  "cbm-code": { guard: false, channels: ONLY("code") },
  "cbm-fused-unguarded": { guard: false, channels: ALL },
  "cbm-guarded": { guard: true, channels: ALL },
};

/** One row of the run: a label, the engine configuration it is built on, and the tuning it uses. */
interface Run {
  readonly label: string;
  readonly base: string;
  readonly tuning: Tuning;
  /** Per-channel result size (the "result cap" lever); default is the engine's. */
  readonly per?: number;
  /** Name of a rewrite table (--rewrites name=file.json) whose terms are searched in addition to the question. */
  readonly rewrite?: string;
}
let runs: Run[];
const tuningsFile = arg("tunings", "");
if (tuningsFile !== "") {
  const entries = JSON.parse(readFileSync(tuningsFile, "utf8")) as { name: string; config?: string; tuning?: TuningPatch; per?: number; rewrite?: string }[];
  runs = entries.map((e) => ({ label: e.name, base: e.config ?? "cbm-guarded", tuning: merge(e.tuning ?? {}), ...(e.per !== undefined ? { per: e.per } : {}), ...(e.rewrite !== undefined ? { rewrite: e.rewrite } : {}) }));
} else {
  runs = arg("configs", "grep,lexical,cbm-bm25,cbm-semantic,cbm-guarded").split(",").filter((c) => c !== "").map((c) => ({ label: c, base: c, tuning: globalTuning }));
}

// --rewrites name=file.json,name2=file2.json : precomputed query rewrites (question -> { identifiers, keywords }), so a run is repeatable and costs no model calls.
const rewriteTables: Record<string, Record<string, QueryRewrite>> = {};
for (const spec of arg("rewrites", "").split(",").filter((s) => s !== "")) {
  const [name, file] = spec.split("=");
  if (name === undefined || file === undefined) throw new Error(`--rewrites wants name=file.json, got "${spec}"`);
  rewriteTables[name] = JSON.parse(readFileSync(file, "utf8")) as Record<string, QueryRewrite>;
}

const doc = JSON.parse(readFileSync(queriesPath, "utf8")) as { queries: (Label & { repo: string })[] };
const labels = doc.queries.filter((q) => idFilter === null || idFilter.has(q.id));
const repos = [...new Set(labels.map((l) => l.repo))];
const scores: QueryScore[] = [];
const details: Record<string, unknown>[] = [];

for (const repo of repos) {
  const root = `${snapshots}/${repo}`;
  const lexical = new LexicalEngine(root);
  const grep = new GrepEngine(root);
  let cbm: CbmEngine | null = null;
  if (runs.some((r) => r.base in CBM_CONFIGS)) {
    const t = Date.now();
    cbm = await CbmEngine.open({ repoDir: root, paths: { binaryPath: `${cbmWork}/bin/codebase-memory-mcp.exe`, workDir: cbmWork }, lexical, tuning: globalTuning, cacheChannels: tuningsFile !== "" });
    process.stderr.write(`[eval] ${repo}: CBM ready in ${String(Date.now() - t)} ms (project ${cbm.projectName})\n`);
  }
  await lexical.refresh();
  for (const run of runs) {
    let engine: CodeSearchEngine;
    if (run.base === "grep") engine = grep;
    else if (run.base === "lexical") engine = lexical;
    else if (cbm !== null && CBM_CONFIGS[run.base] !== undefined) {
      const table = run.rewrite === undefined ? undefined : rewriteTables[run.rewrite];
      if (run.rewrite !== undefined && table === undefined) throw new Error(`run "${run.label}" asks for rewrite table "${run.rewrite}" which was not given with --rewrites`);
      cbm.configure({ ...(CBM_CONFIGS[run.base] as Pick<CbmEngineOptions, "guard" | "channels">), tuning: run.tuning, perChannel: run.per ?? globalPer, rewrite: table === undefined ? undefined : tableRewriter(table) });
      engine = cbm;
    } else throw new Error(`unknown config ${run.base}`);
    for (const label of labels.filter((l) => l.repo === repo)) {
      const answer = await engine.search(label.query, { k });
      const s = scoreQuery(label, answer, run.label, k);
      scores.push(s);
      details.push({ id: label.id, config: run.label, engine: answer.engine, confidence: answer.confidence, abstained: answer.abstained, reason: answer.reason, signals: answer.signals, returned: s.returned, fileRank: s.fileRank, strictRank: s.strictRank, ms: answer.ms });
    }
  }
  await cbm?.close();
}

const names = runs.map((r) => r.label);
const byConfig = (c: string): QueryScore[] => scores.filter((s) => s.config === c);
const overall = names.map((c) => ({ config: c, agg: aggregate(byConfig(c)) }));
const kinds = [...new Set(labels.map((l) => l.kind))];
const byKind = Object.fromEntries(kinds.map((kd) => [kd, names.map((c) => ({ config: c, agg: aggregate(byConfig(c).filter((s) => s.kind === kd)) }))]));
const byRepo = Object.fromEntries(repos.map((r) => [r, names.map((c) => ({ config: c, agg: aggregate(byConfig(c).filter((s) => s.repo === r)) }))]));

mkdirSync(out, { recursive: true });
const result = { tag, at: new Date().toISOString(), k, runs, queries: labels.length, overall, byKind, byRepo, scores, details };
writeFileSync(`${out}/${tag}.json`, JSON.stringify(result, null, 1));
const md = [`## Overall (${String(labels.length)} queries, k=${String(k)})`, "", markdownTable(overall), "", ...kinds.flatMap((kd) => [`### ${kd}`, "", markdownTable(byKind[kd] as typeof overall), ""]), ...repos.flatMap((r) => [`### repo: ${r}`, "", markdownTable(byRepo[r] as typeof overall), ""])].join("\n");
writeFileSync(`${out}/${tag}.md`, md);
process.stdout.write(`${md}\n`);
