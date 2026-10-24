// Suite 7g: does the retrieval actually let a provider ANSWER the question, and at what token cost?
//
//   node scripts/code-search-answer-eval.ts --out evals/code-search/results --tag answer-1 [--ids a,b] [--model claude-haiku-5-5] [--arms grep-read,cbm,cbm-trim,cbm-wide,cbm-wide-trim]
//
// For each of the 40 labelled questions and each arm, builds the context an agent would have read, hands it to a provider with NO tools
// ("answer only from this context, name the file; say NOT FOUND if it is not there"), and grades the reply mechanically: correct = it names the
// labelled file, NOT FOUND = no answer, otherwise a confident wrong answer. Arms:
//   grep-read      what an agent without an index does: grep the question's words, read the top 3 files in full (capped at 250 lines each)
//   cbm            the tuned, guarded CBM engine's top 5 hits (12-line live snippets; a low-confidence answer is labelled as such)
//   cbm-trim       the same text through trim-1 with the question as the query
//   cbm-wide       the same top 5 hits but each shows up to 60 lines of its live range (more context per hit)
//   cbm-wide-trim  that, through trim-1 (budget 1500 tokens)
//   lexical        OSA's own default index: its top 5 hits (12-line snippets)
//   ranked         the shipped CBM setting (ranked, no abstaining, query rewrite from --rewrites): top 5 hits, 12-line snippets
//   ranked-wide    the same with up to 60 lines per hit
// Token numbers: `context` is the estimated tokens of the retrieved text (chars/4); `billed` is what the provider reported (includes a ~1.3k fixed
// system overhead that is identical for every arm). Results are cached per (arm, question) so an interrupted run resumes.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { runProcess } from "../src/util/exec.ts";
import { CbmEngine } from "../src/code-index/cbm/engine.ts";
import { GrepEngine, LexicalEngine } from "../src/code-index/engine.ts";
import { RANKED_PER_CHANNEL, RANKED_TUNING, TUNED_PER_CHANNEL, TUNED_TUNING } from "../src/code-index/fusion.ts";
import { tableRewriter } from "../src/code-index/rewrite.ts";
import type { QueryRewrite } from "../src/code-index/rewrite.ts";
import type { Label } from "../src/code-index/eval-score.ts";
import { OsaConfig } from "../src/domain/osa-config.ts";
import { estimateTokens } from "../src/trim/trimmer.ts";
import { resolveTrimmer } from "../src/trim/trim1.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}
const snapshots = arg("snapshots", "C:/Users/hp/osa-tools/eval-snapshots");
const out = arg("out", "evals/code-search/results");
const tag = arg("tag", "answer-1");
const model = arg("model", "claude-haiku-5-5");
const ARMS = arg("arms", "grep-read,cbm,cbm-trim,cbm-wide,cbm-wide-trim").split(",");
const idFilter = arg("ids", "") === "" ? null : new Set(arg("ids", "").split(","));
const cachePath = `${out}/${tag}.cache.json`;
const cache: Record<string, Answer> = existsSync(cachePath) ? (JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, Answer>) : {};

interface Answer {
  readonly arm: string;
  readonly id: string;
  readonly kind: string;
  readonly contextTokens: number;
  readonly billedTokens: number;
  readonly outputTokens: number;
  readonly reply: string;
  readonly verdict: "correct" | "not-found" | "wrong";
  readonly engine: string;
  readonly ms: number;
}

// --queries a.json,b.json (default: the 40-query set); --rewrites file.json is the table the "ranked" arms use (src/code-index/rewrite.ts).
const labels = arg("queries", "evals/code-search/queries.json")
  .split(",")
  .flatMap((f) => (JSON.parse(readFileSync(f, "utf8")) as { queries: (Label & { repo: string })[] }).queries)
  .filter((q) => idFilter === null || idFilter.has(q.id));
const rewriteTable = arg("rewrites", "") === "" ? {} : (JSON.parse(readFileSync(arg("rewrites", ""), "utf8")) as Record<string, QueryRewrite>);

const { trimmer } = await resolveTrimmer(OsaConfig.parse({ trim: { enabled: true, binaryPath: "C:/Users/hp/go/bin/trim.exe" } }).trim);
if (ARMS.some((x) => x.endsWith("-trim")) && trimmer.engine !== "trim1") throw new Error("trim-1 is not available: the -trim arms need the real binary");

async function lines(root: string, file: string, start: number, end: number): Promise<string> {
  const text = readFileSync(`${root}/${file}`, "utf8").replace(/\r\n/g, "\n").split("\n");
  return text.slice(Math.max(0, start - 1), end).join("\n");
}
const block = (file: string, start: number, end: number, symbol: string | null, body: string): string => `### ${file}:${String(start)}-${String(end)}${symbol !== null ? ` (${symbol})` : ""}\n${body}\n`;

async function ask(question: string, context: string): Promise<{ reply: string; billed: number; output: number }> {
  const prompt = `Question about a code repository: ${question}\n\nAnswer in at most three sentences, naming the file path(s) and the function or section that answers it. Use ONLY the context below. If the context does not contain the answer, reply exactly: NOT FOUND\n\nContext:\n${context}`;
  const cwd = mkdtempSync(`${tmpdir()}/osa-answer-`);
  writeFileSync(`${cwd}/empty-mcp.json`, '{"mcpServers":{}}');
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await runProcess({ command: "claude", args: ["-p", "--model", model, "--disallowedTools", "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit", "--output-format", "json", "--no-session-persistence", "--system-prompt", "Answer only from the provided context.", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", "empty-mcp.json"], cwd, stdin: prompt, timeoutMs: 180_000 });
      if (r.exitCode !== 0) throw new Error(`claude exited ${String(r.exitCode)}: ${r.stderr.slice(0, 300)}`);
      const stdout = r.stdout;
      const j = JSON.parse(stdout) as { result: string; is_error: boolean; usage: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number } };
      if (j.is_error) throw new Error(j.result);
      return { reply: j.result, billed: j.usage.input_tokens + j.usage.cache_creation_input_tokens + j.usage.cache_read_input_tokens, output: j.usage.output_tokens };
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
  }
}

function grade(label: Label, reply: string): Answer["verdict"] {
  if (/NOT FOUND/i.test(reply)) return "not-found";
  const norm = reply.replace(/\\/g, "/").toLowerCase();
  return label.expect.some((e) => norm.includes(e.path.toLowerCase())) ? "correct" : "wrong";
}

const rows: Answer[] = [];
const todo: (() => Promise<void>)[] = [];
for (const repo of [...new Set(labels.map((l) => l.repo))]) {
  const root = `${snapshots}/${repo}`;
  const lexical = new LexicalEngine(root);
  const grep = new GrepEngine(root);
  const cbm = ARMS.some((a) => a.startsWith("cbm") || a.startsWith("ranked")) ? await CbmEngine.open({ repoDir: root, paths: { binaryPath: "C:/osa-cbm/bin/codebase-memory-mcp.exe", workDir: "C:/osa-cbm" }, lexical, tuning: TUNED_TUNING, perChannel: TUNED_PER_CHANNEL }) : null;
  for (const label of labels.filter((l) => l.repo === repo)) {
    // Build every arm's context sequentially (the CBM session is single-threaded); the provider calls then run in parallel.
    const contexts = new Map<string, { text: string; engine: string }>();
    for (const arm of ARMS) {
      if (cache[`${arm}|${label.id}`] !== undefined) continue;
      if (arm === "grep-read") {
        const a = await grep.search(label.query, { k: 3 });
        const files = [...new Set(a.hits.map((h) => h.path))].slice(0, 3);
        const parts: string[] = [];
        for (const f of files) parts.push(block(f, 1, 250, null, await lines(root, f, 1, 250)));
        contexts.set(arm, { text: parts.join("\n"), engine: "grep" });
        continue;
      }
      let a;
      if (arm === "lexical") {
        a = await lexical.search(label.query, { k: 5 });
      } else if (arm.startsWith("ranked")) {
        // the shipped CBM setting: ranked list (no abstaining), RANKED_TUNING, plus the query rewrite
        (cbm as CbmEngine).configure({ tuning: RANKED_TUNING, perChannel: RANKED_PER_CHANNEL, guard: false, channels: {}, rewrite: tableRewriter(rewriteTable) });
        a = await (cbm as CbmEngine).search(label.query, { k: 5 });
      } else {
        (cbm as CbmEngine).configure({ tuning: TUNED_TUNING, perChannel: TUNED_PER_CHANNEL, guard: true, channels: {}, rewrite: undefined });
        a = await (cbm as CbmEngine).search(label.query, { k: 5 });
      }
      const wide = arm.startsWith("cbm-wide") || arm === "ranked-wide";
      const parts: string[] = [];
      for (const h of a.hits) parts.push(block(h.path, h.startLine, wide ? Math.min(h.endLine, h.startLine + 59) : h.endLine, h.symbol, wide ? await lines(root, h.path, h.startLine, Math.min(h.endLine, h.startLine + 59)) : h.snippet));
      let text = parts.join("\n");
      const header = a.abstained || a.confidence === "low" ? `Note: low confidence (${a.reason})\n\n` : "";
      if (arm.endsWith("-trim")) {
        const r = await trimmer.trim(text, { budgetTokens: wide ? 1500 : 400, keep: [], query: label.query });
        text = r.output;
      }
      contexts.set(arm, { text: header + text, engine: a.engine });
    }
    for (const [arm, c] of contexts) {
      todo.push(async () => {
        const t0 = Date.now();
        const r = await ask(label.query, c.text);
        const row: Answer = { arm, id: label.id, kind: label.kind, contextTokens: estimateTokens(c.text), billedTokens: r.billed, outputTokens: r.output, reply: r.reply.slice(0, 600), verdict: grade(label, r.reply), engine: c.engine, ms: Date.now() - t0 };
        cache[`${arm}|${label.id}`] = row;
        mkdirSync(out, { recursive: true });
        writeFileSync(cachePath, JSON.stringify(cache, null, 1));
      });
    }
  }
  await cbm?.close();
}
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => { while (next < todo.length) { const i = next++; await (todo[i] as () => Promise<void>)(); } }));

for (const arm of ARMS) for (const l of labels) { const a = cache[`${arm}|${l.id}`]; if (a !== undefined) rows.push(a); }
const pct = (n: number, d: number): string => (d === 0 ? "-" : `${(100 * n / d).toFixed(1)}%`);
const table = ["| arm | n | correct | not found | confident wrong | context tokens/query | billed tokens/query | context tokens per correct answer |", "|---|---:|---:|---:|---:|---:|---:|---:|"];
for (const arm of ARMS) {
  const r = rows.filter((x) => x.arm === arm);
  const c = r.filter((x) => x.verdict === "correct").length;
  const ctx = r.reduce((s, x) => s + x.contextTokens, 0);
  table.push(`| ${arm} | ${String(r.length)} | ${pct(c, r.length)} | ${pct(r.filter((x) => x.verdict === "not-found").length, r.length)} | ${pct(r.filter((x) => x.verdict === "wrong").length, r.length)} | ${String(Math.round(ctx / Math.max(1, r.length)))} | ${String(Math.round(r.reduce((s, x) => s + x.billedTokens, 0) / Math.max(1, r.length)))} | ${c === 0 ? "-" : String(Math.round(ctx / c))} |`);
}
const md = `## Answer eval (${model}, ${String(labels.length)} questions)\n\n${table.join("\n")}\n`;
writeFileSync(`${out}/${tag}.md`, md);
writeFileSync(`${out}/${tag}.json`, JSON.stringify({ tag, model, at: new Date().toISOString(), rows }, null, 1));
process.stdout.write(md);
