// Renders the Suite 7 tables of docs/osa/TEST_REPORT.md from the saved eval results, so no number in the report is typed by hand.
//   node scripts/report-tables.mjs <results-dir> <final-default-tag> <final-tuned-tag> <answer-tag>
import { readFileSync } from "node:fs";

const [dir, defaultTag, tunedTag, answerTag] = process.argv.slice(2);
if (answerTag === undefined) throw new Error("usage: report-tables.mjs <results-dir> <default-tag> <tuned-tag> <answer-tag>");
const load = (tag) => JSON.parse(readFileSync(`${dir}/${tag}.json`, "utf8"));
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const row = (name, a) =>
  `| ${name} | ${pct(a.recallFile)} | ${pct(a.recallStrict)} | ${a.mrrFile.toFixed(3)} | ${pct(a.top1File)} | **${pct(a.confidentWrongRate)}** | ${pct(a.abstainRate)} | ${pct(a.recallWhenAnswered)} | ${String(Math.round(a.tokensMean))} | ${String(Math.round(a.msMedian))} |`;
const HEAD = ["| engine | recall@5 | recall@5 strict | MRR | top-1 | **CONFIDENT-WRONG** | abstains | recall when answered | tokens/query | median ms |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
const NAMES = {
  grep: "plain grep (definition-aware)",
  lexical: "OSA lexical `code_search`",
  "cbm-bm25": "CBM BM25 `search_graph` (the spike's default)",
  "cbm-semantic": "CBM `semantic_query`",
  "cbm-code": "CBM `search_code` (text, graph-aware)",
  "cbm-fused-unguarded": "CBM, all channels fused, no guard",
  "cbm-guarded": "CBM fused + confidence guard (default tuning)",
};

const d = load(defaultTag);
const t = load(tunedTag);
const out = [];
out.push(`#### Retrieval eval — ${String(d.queries)} labelled queries (osa TS, hostel Py, hms Py), k=5, file-level labels (strict = line range overlaps too)`, "", ...HEAD);
for (const o of d.overall) out.push(row(NAMES[o.config] ?? o.config, o.agg));
const tg = t.overall.find((o) => o.config === "cbm-guarded") ?? t.overall[0];
out.push(row("**CBM fused + guard, TUNED (`TUNED_TUNING`)**", tg.agg));
out.push("");

const kinds = Object.keys(d.byKind);
out.push("#### By query kind — recall@5 (file) / confident-wrong, per engine", "", `| kind | n | ${["grep", "lexical", "cbm-bm25", "cbm-guarded"].join(" | ")} | tuned guard |`, `|---|---:|---:|---:|---:|---:|---:|`);
for (const k of kinds) {
  const cell = (cfg, src) => {
    const a = src.byKind[k].find((x) => x.config === cfg)?.agg;
    return a === undefined ? "-" : `${pct(a.recallFile)} / ${pct(a.confidentWrongRate)}`;
  };
  const n = d.byKind[k][0].agg.n;
  out.push(`| ${k} | ${String(n)} | ${cell("grep", d)} | ${cell("lexical", d)} | ${cell("cbm-bm25", d)} | ${cell("cbm-guarded", d)} | ${cell("cbm-guarded", t)} |`);
}
out.push("");

const a = load(answerTag);
const arms = [...new Set(a.rows.map((r) => r.arm))];
const NAMES2 = { "grep-read": "grep + read top 3 files", cbm: "CBM alone (top 5, 12-line live snippets)", "cbm-trim": "CBM + trim-1", "cbm-wide": "CBM wide (up to 60 lines/hit)", "cbm-wide-trim": "CBM wide + trim-1" };
out.push(`#### Answer eval — a provider (${a.model}) answers each of the ${String(a.rows.length / arms.length)} questions from the retrieved context only`, "", "| arm | correct | NOT FOUND | confident wrong | context tokens/query | tokens per correct answer |", "|---|---:|---:|---:|---:|---:|");
const stats = {};
for (const arm of arms) {
  const r = a.rows.filter((x) => x.arm === arm);
  const c = r.filter((x) => x.verdict === "correct").length;
  const ctx = r.reduce((s, x) => s + x.contextTokens, 0);
  stats[arm] = { c, n: r.length, ctx };
  out.push(`| ${NAMES2[arm] ?? arm} | ${pct(c / r.length)} | ${pct(r.filter((x) => x.verdict === "not-found").length / r.length)} | ${pct(r.filter((x) => x.verdict === "wrong").length / r.length)} | ${String(Math.round(ctx / r.length))} | ${c === 0 ? "-" : String(Math.round(ctx / c))} |`);
}
out.push("", "Hybrid an agent would actually follow — use CBM, and when it says NOT FOUND fall back to grep + read:", "", "| arm | correct | wrong | context tokens/query | tokens per correct answer | fell back |", "|---|---:|---:|---:|---:|---:|");
const byId = (arm) => Object.fromEntries(a.rows.filter((x) => x.arm === arm).map((x) => [x.id, x]));
const gr = byId("grep-read");
for (const arm of arms.filter((x) => x !== "grep-read")) {
  const m = byId(arm);
  let c = 0, w = 0, tok = 0, fb = 0;
  const ids = Object.keys(m);
  for (const id of ids) {
    tok += m[id].contextTokens;
    let v = m[id].verdict;
    if (v === "not-found") { fb++; tok += gr[id].contextTokens; v = gr[id].verdict; }
    if (v === "correct") c++; else if (v === "wrong") w++;
  }
  out.push(`| ${NAMES2[arm] ?? arm} + grep fallback | ${pct(c / ids.length)} | ${pct(w / ids.length)} | ${String(Math.round(tok / ids.length))} | ${String(Math.round(tok / Math.max(1, c)))} | ${String(fb)} of ${String(ids.length)} |`);
}
out.push("");
const cbmRows = a.rows.filter((x) => x.arm === "cbm");
const split = {};
for (const r of cbmRows) {
  const k = r.engine === "cbm" ? "CBM answered (guard said high/medium)" : "guard abstained → local index (low confidence)";
  split[k] ??= { n: 0, correct: 0, wrong: 0, nf: 0 };
  split[k].n++;
  split[k][r.verdict === "correct" ? "correct" : r.verdict === "wrong" ? "wrong" : "nf"]++;
}
out.push("What the guard's label means for the answer (CBM-alone arm):", "", "| engine said | n | correct | wrong | NOT FOUND |", "|---|---:|---:|---:|---:|");
for (const [k, v] of Object.entries(split)) out.push(`| ${k} | ${String(v.n)} | ${String(v.correct)} | ${String(v.wrong)} | ${String(v.nf)} |`);
out.push("");
process.stdout.write(out.join("\n") + "\n");

// Optional 5th argument: comma-separated tuning-run tags, printed as the 7f tuning log (one row per configuration tried, in order).
if (process.argv[6] !== undefined) {
  const lines = [];
  for (const tag of process.argv[6].split(",")) {
    const r = load(tag);
    lines.push(`##### ${tag}`, "", "| configuration | recall@5 | MRR | top-1 | **CONFIDENT-WRONG** | abstains | recall when answered |", "|---|---:|---:|---:|---:|---:|---:|");
    for (const o of r.overall) lines.push(`| ${o.config} | ${pct(o.agg.recallFile)} | ${o.agg.mrrFile.toFixed(3)} | ${pct(o.agg.top1File)} | **${pct(o.agg.confidentWrongRate)}** | ${pct(o.agg.abstainRate)} | ${pct(o.agg.recallWhenAnswered)} |`);
    lines.push("");
  }
  process.stdout.write(lines.join("\n") + "\n");
}
