// Suite 1 -- trim-1 LIVE integration. Runs against the real `trim` binary (TRIM1_BIN, else the standard Go install path) and REAL
// payloads captured from a completed live OSA run (evals/trim/payloads/*): the research report, a phase handoff, an executor
// context, relay handoff records, application-check output, and the locked PRD / spec / context that must never be touched.
// Skipped, with the reason, only when no trim binary exists on this machine.
//
//   TRIM1_BIN=C:/Users/hp/go/bin/trim.exe node --test src/trim/trim-live.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { InternalError } from "../domain/errors.ts";
import { defaultOsaConfig } from "../domain/osa-config.ts";
import { MemoryEventSink } from "../osa/events.ts";
import { runProcess } from "../util/exec.ts";
import { trimHandoff } from "./handoff.ts";
import { isProtectedLine } from "./protected.ts";
import { NoopTrimmer, estimateTokens } from "./trimmer.ts";
import { Trim1Trimmer, resolveTrimmer, restoreProtectedLines } from "./trim1.ts";

const DEFAULT_BIN = "C:/Users/hp/go/bin/trim.exe";
const BIN = process.env["TRIM1_BIN"] ?? DEFAULT_BIN;
const SKIP = existsSync(BIN) ? false : `no trim-1 binary at ${BIN} (go install github.com/caveman-ai/trim-1/cmd/trim@latest, or set TRIM1_BIN)`;
const PAYLOADS = new URL("../../evals/trim/payloads/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const payload = (name: string): string => readFileSync(`${PAYLOADS}${name}`, "utf8").replace(/\r\n/g, "\n");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

const Q_SPEC = "choose the stack libraries and APIs for a node command line word counter and note any documented pitfalls";
const Q_NEXT = "what did the earlier phase change, which tests pass and what remains";

const TYPES: { name: string; file: string; query: string }[] = [
  { name: "research report", file: "research-report.md", query: Q_SPEC },
  { name: "phase handoff (step 14)", file: "phase-handoff.md", query: Q_NEXT },
  { name: "executor context (step 14)", file: "executor-context.md", query: Q_NEXT },
  { name: "relay handoff (executor, Claude)", file: "relay-executor-claude.json", query: Q_NEXT },
  { name: "relay handoff (executor, Codex)", file: "relay-executor-codex.json", query: Q_NEXT },
  { name: "relay handoff (reviewer)", file: "relay-reviewer-claude.json", query: Q_NEXT },
  { name: "application-check report", file: "application-report.md", query: Q_NEXT },
  { name: "application-check evidence", file: "application-evidence.json", query: Q_NEXT },
];

async function rawTrim(input: string, query: string, point: string, bin = BIN) {
  const r = await runProcess({ command: bin, args: ["--query", query, "--point", point], cwd: process.cwd(), stdin: input, timeoutMs: 60_000, noShellFallback: true });
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr.trim() };
}

const MARKER = /^… (\d+) lines …$/;
/** Replays trim-1's output against its input: every kept line byte-identical and in order, every marker counting exactly the lines it replaced. */
function replay(input: string, output: string): { ok: boolean; removed: number; kept: number; why: string } {
  const inLines = input.replace(/\n$/, "").split("\n");
  const outLines = output.replace(/\n$/, "").split("\n");
  let i = 0;
  let removed = 0;
  let kept = 0;
  for (const line of outLines) {
    const m = MARKER.exec(line);
    if (m !== null && inLines[i] !== line) {
      const n = Number(m[1]);
      i += n;
      removed += n;
    } else {
      if (inLines[i] !== line) return { ok: false, removed, kept, why: `output line ${JSON.stringify(line.slice(0, 60))} is not input line ${String(i + 1)} (${JSON.stringify((inLines[i] ?? "<end>").slice(0, 60))})` };
      i += 1;
      kept += 1;
    }
  }
  return i === inLines.length ? { ok: true, removed, kept, why: "" } : { ok: false, removed, kept, why: `consumed ${String(i)} of ${String(inLines.length)} input lines` };
}

const deps = (trimmer: Trim1Trimmer | NoopTrimmer, engineNote: string | null = null) => ({ trimmer, events: new MemoryEventSink(), defaultBudgetTokens: 1, engineNote });

// ---- 1. the real binary on real payloads ----

test("LIVE trim-1: where it cuts a real payload, kept lines are byte-identical and in order, and removal markers account for every dropped line", { skip: SKIP }, async () => {
  let cutSomething = 0;
  for (const t of TYPES) {
    const input = payload(t.file);
    for (const point of ["conservative", "balanced", "aggressive"]) {
      const r = await rawTrim(input, t.query, point);
      assert.equal(r.exitCode, 0, `${t.file}/${point}: ${r.stderr}`);
      if (/^trim: unchanged/.test(r.stderr)) {
        assert.ok(r.stdout.replace(/\n$/, "") === input.replace(/\n$/, ""), `${t.file}/${point}: an unchanged result must return the input verbatim`);
        continue;
      }
      cutSomething += 1;
      const rep = replay(input, r.stdout);
      assert.ok(rep.ok, `${t.file}/${point}: ${rep.why}`);
      assert.ok(rep.removed > 0 && /^… \d+ lines …$/m.test(r.stdout), `${t.file}/${point}: removal markers are present`);
      assert.ok(r.stdout.length < input.length);
      assert.match(r.stderr, new RegExp(`removed ${String(rep.removed)},`), "the binary's own count matches the replay");
    }
  }
  assert.ok(cutSomething >= 3, `expected real payloads to be cut at least at the aggressive point, saw ${String(cutSomething)} cuts`);
});

// ---- 2. every fail-closed case: trim-1 returns the input unchanged, OSA logs trim_skipped with the reason and passes the input through ----

async function assertFailClosed(label: string, input: string, query: string, expectReason: RegExp, point: "conservative" | "balanced" | "aggressive" = "balanced") {
  const raw = await rawTrim(input, query, point);
  assert.ok(raw.exitCode === 0 || query === "", `${label}: exit ${String(raw.exitCode)} ${raw.stderr}`);
  const d = deps(new Trim1Trimmer({ command: BIN, point }));
  const out = await trimHandoff([{ label: "probe", text: input, trimmable: true, query }], d);
  assert.ok(out.parts[0]?.text === input, `${label}: the input passes through byte-identical`);
  assert.equal(out.parts[0]?.trimmed, false);
  const skipped = d.events.events.find((e) => e.event === "trim_skipped");
  assert.ok(skipped !== undefined, `${label}: trim_skipped was logged`);
  assert.match(String(skipped.data["reason"]), expectReason, `${label}: reason`);
  assert.equal(skipped.data["engine"], "trim1");
  assert.equal(d.events.events.some((e) => e.event === "trim_applied"), false);
  return raw;
}

test("LIVE fail-closed: a blank query -- OSA does not even spawn the binary, logs trim_skipped, and the raw binary refuses a blank query too", { skip: SKIP }, async () => {
  await assertFailClosed("blank query", payload("research-report.md"), "   ", /query-conditioned and no query was supplied/);
  const raw = await rawTrim(payload("research-report.md"), "", "balanced");
  assert.notEqual(raw.exitCode, 0, "the raw binary rejects a blank query (usage, non-zero)");
});

test("LIVE fail-closed: input under 2 KB", { skip: SKIP }, async () => {
  const small = payload("research-report.md").slice(0, 1500);
  const raw = await assertFailClosed("under 2 KB", small, Q_SPEC, /context below the minimum size/);
  assert.match(raw.stderr, /context below the minimum size/);
});

test("LIVE fail-closed: input that already contains a removal marker (already trimmed)", { skip: SKIP }, async () => {
  const input = payload("research-report.md");
  const once = await rawTrim(input, Q_SPEC, "aggressive");
  assert.match(once.stderr, /^trim: kept/);
  const trimmedText = once.stdout.replace(/\n$/, "");
  const raw = await assertFailClosed("already trimmed", trimmedText, Q_SPEC, /trim-1: (?!kept).+/, "aggressive");
  assert.match(raw.stderr, /^trim: unchanged/);
  assert.match(raw.stderr, /already|trimmed|marker/i, `the binary names the reason: ${raw.stderr}`);
});

test("LIVE fail-closed: a cut under 10% (what conservative/balanced do to every real OSA payload)", { skip: SKIP }, async () => {
  // the raw binary at conservative/balanced: unchanged, input verbatim
  for (const point of ["conservative", "balanced"]) {
    const raw = await rawTrim(payload("research-report.md"), Q_SPEC, point);
    assert.match(raw.stderr, /^trim: unchanged \(cut below the minimum\)/, point);
    assert.ok(raw.stdout.replace(/\n$/, "") === payload("research-report.md").replace(/\n$/, ""));
  }
  // OSA's wrapper deliberately STEPS UP to the next operating point when one fails closed (and says which it used)...
  const stepped = await new Trim1Trimmer({ command: BIN, point: "conservative" }).trim(payload("research-report.md"), { budgetTokens: 1, keep: [], query: Q_SPEC });
  assert.equal(stepped.applied, true);
  assert.equal(stepped.point, "aggressive");
  // ...so the pass-through + trim_skipped path is exercised by payloads for which EVERY point fails closed
  for (const file of ["phase-handoff.md", "executor-context.md", "application-report.md", "application-evidence.json"]) {
    await assertFailClosed(`under 10% (${file})`, payload(file), Q_NEXT, /trim-1: cut below the minimum/, "conservative");
  }
});

test("LIVE fail-closed: input over 8 MiB, and input over 200k lines", { skip: SKIP, timeout: 120_000 }, async () => {
  const filler = payload("research-report.md");
  const big = filler.repeat(Math.ceil((9 * 1024 * 1024) / filler.length));
  assert.ok(Buffer.byteLength(big) > 8 * 1024 * 1024);
  const rawBig = await assertFailClosed("over 8 MiB", big, Q_SPEC, /trim-1: /, "aggressive");
  assert.match(rawBig.stderr, /^trim: unchanged/);
  const manyLines = "x\n".repeat(210_000) + payload("research-report.md");
  const rawLines = await assertFailClosed("over 200k lines", manyLines, Q_SPEC, /trim-1: /, "aggressive");
  assert.match(rawLines.stderr, /^trim: unchanged/);
});

// ---- 3. a missing or failing binary: NoopTrimmer, the run continues, the event is logged ----

test("missing binary: resolveTrimmer falls back to NoopTrimmer with an install hint, and the handoff continues unchanged with trim_skipped logged", async () => {
  const cfg = { ...defaultOsaConfig().trim, enabled: true };
  const resolved = await resolveTrimmer({ ...cfg, binaryPath: "C:\\definitely\\not\\here\\trim.exe" });
  assert.equal(resolved.trimmer.engine, "noop");
  assert.match(resolved.note ?? "", /trim-1 is not available[\s\S]*go install github\.com\/caveman-ai\/trim-1\/cmd\/trim@latest/);
  const d = { trimmer: resolved.trimmer, events: new MemoryEventSink(), defaultBudgetTokens: 1, engineNote: resolved.note };
  const input = payload("research-report.md");
  const out = await trimHandoff([{ label: "research-report", text: input, trimmable: true, query: Q_SPEC }], d);
  assert.equal(out.parts[0]?.text, input);
  const ev = d.events.events.find((e) => e.event === "trim_skipped");
  assert.equal(ev?.data["engine"], "noop");
  assert.match(String(ev?.data["engineNote"]), /trim-1 is not available/);
});

test("a binary that exits non-zero (process.execPath fed trim's flags): the trimmer reports the failure, the input passes through, trim_skipped is logged", async () => {
  const d = deps(new Trim1Trimmer({ command: process.execPath, point: "aggressive" }));
  const input = payload("research-report.md");
  const out = await trimHandoff([{ label: "research-report", text: input, trimmable: true, query: Q_SPEC }], d);
  assert.equal(out.parts[0]?.text, input);
  const ev = d.events.events.find((e) => e.event === "trim_skipped");
  assert.match(String(ev?.data["reason"]), /trim-1 failed \(exit \d+\)/);
  // and resolveTrimmer refuses to mistake such an executable for trim-1
  const resolved = await resolveTrimmer({ ...defaultOsaConfig().trim, enabled: true, binaryPath: process.execPath });
  assert.equal(resolved.trimmer.engine, "noop");
});

// ---- 4. protected content, proven with hashes and the REAL binary ----

const PROTECTED_DOCS = ["baby-prd.md", "PHASE_1_SPEC.md", "context.md"];

test("LIVE protected content: the locked PRD, spec, context and acceptance criteria pass through byte-identical (sha256) while the research report is genuinely trimmed", { skip: SKIP }, async () => {
  const prd = payload("baby-prd.md");
  const criteria = prd.slice(prd.indexOf("## Acceptance criteria"), prd.indexOf("## ", prd.indexOf("## Acceptance criteria") + 5) === -1 ? undefined : prd.indexOf("## ", prd.indexOf("## Acceptance criteria") + 5));
  const parts = [
    { label: "baby-prd", text: prd, trimmable: false, query: Q_SPEC },
    { label: "spec", text: payload("PHASE_1_SPEC.md"), trimmable: false, query: Q_SPEC },
    { label: "context", text: payload("context.md"), trimmable: false, query: Q_SPEC },
    { label: "acceptance-criteria", text: criteria, trimmable: false, query: Q_SPEC },
    { label: "research-report", text: payload("research-report.md"), trimmable: true, query: Q_SPEC, budgetTokens: 1 },
  ];
  const before = parts.map((p) => sha(p.text));
  const d = deps(new Trim1Trimmer({ command: BIN, point: "balanced" }));
  const out = await trimHandoff(parts, d);
  assert.deepEqual(out.parts.map((p) => p.label), parts.map((p) => p.label), "order preserved");
  parts.slice(0, 4).forEach((p, i) => {
    assert.equal(sha(out.parts[i]?.text ?? ""), before[i], `${p.label} sha256 unchanged`);
    assert.equal(out.parts[i]?.trimmed, false);
  });
  assert.ok(criteria.length > 100 && /AC1|1\./.test(criteria), "the acceptance-criteria slice is real");
  const report = out.parts[4];
  assert.equal(report?.trimmed, true, "the report was genuinely trimmed by the real binary");
  assert.ok((report?.text.length ?? 0) < parts[4]!.text.length);
  const applied = d.events.events.find((e) => e.event === "trim_applied");
  assert.equal(applied?.data["engine"], "trim1");
  // the same four protected parts survive the no-op engine identically
  const noop = await trimHandoff(parts, deps(new NoopTrimmer("noop")));
  parts.slice(0, 4).forEach((p, i) => assert.equal(sha(noop.parts[i]?.text ?? ""), before[i], `${p.label} under noop`));
});

test("marking the PRD, spec, context or acceptance criteria trimmable is refused, whatever the engine", async () => {
  for (const label of ["prd", "baby-prd", "locked-prd", "spec", "phase-spec", "acceptance", "acceptance-criteria", "context"]) {
    await assert.rejects(trimHandoff([{ label, text: "x", trimmable: true, query: "q" }], deps(new NoopTrimmer("noop"))), (e: unknown) => e instanceof InternalError && /never trimmed/.test(e.message), label);
  }
});

function protectedLinesOf(text: string): string[] {
  return text.split("\n").filter((l) => isProtectedLine(l));
}

test("LIVE protected lines of a real report -- paths, hashes, error text, test names, URLs, headings -- are all present, byte-identical, in their original order and exactly as many times as in the source", { skip: SKIP }, async () => {
  const input = payload("research-report.md");
  const d = deps(new Trim1Trimmer({ command: BIN, point: "aggressive" }));
  const out = (await trimHandoff([{ label: "research-report", text: input, trimmable: true, query: Q_SPEC }], d)).parts[0]!;
  assert.equal(out.trimmed, true);
  const want = protectedLinesOf(input);
  assert.ok(want.length > 20, `the report has protected lines (${String(want.length)})`);
  const gotLines = out.text.split("\n");
  let cursor = 0;
  for (const line of want) {
    const at = gotLines.indexOf(line, cursor);
    assert.ok(at >= cursor, `protected line missing or out of order: ${JSON.stringify(line.slice(0, 80))}`);
    cursor = at + 1;
  }
  for (const line of new Set(want)) {
    const inCount = input.split("\n").filter((l) => l === line).length;
    const outCount = gotLines.filter((l) => l === line).length;
    assert.equal(outCount, inCount, `appears exactly as often as in the source: ${JSON.stringify(line.slice(0, 60))}`);
  }
});

test("LIVE restoration with the real binary: lines trim-1 itself DROPS but OSA protects come back in their original position, once", { skip: SKIP }, async () => {
  const input = payload("research-report.md");
  const inLines = input.replace(/\n$/, "").split("\n");
  const rawAgg = await rawTrim(input, Q_SPEC, "aggressive");
  assert.match(rawAgg.stderr, /^trim: kept/, `the binary must actually cut this document: ${rawAgg.stderr}`);
  const engineLines = rawAgg.stdout.replace(/\n$/, "").split("\n");

  // which SOURCE positions did the engine itself keep? (walk the two sequences together, exactly as the markers define)
  const keptIdx = new Set<number>();
  let j = 0;
  for (let i = 0; i < inLines.length; i++) {
    while (j < engineLines.length && MARKER.test(engineLines[j] as string) && engineLines[j] !== inLines[i]) j += 1;
    if (j < engineLines.length && engineLines[j] === inLines[i]) {
      keptIdx.add(i);
      j += 1;
    }
  }
  const droppedProtected = inLines.map((l, i) => ({ l, i })).filter(({ l, i }) => isProtectedLine(l) && !keptIdx.has(i));
  assert.ok(droppedProtected.length >= 3, `trim-1 itself dropped ${String(droppedProtected.length)} protected line(s); the test is only meaningful if it drops some`);
  process.stdout.write(`\n[trim-restoration] trim-1 dropped ${String(droppedProtected.length)} of ${String(inLines.filter((l) => isProtectedLine(l)).length)} protected lines in the real research report; e.g. ${JSON.stringify(droppedProtected[0]?.l.slice(0, 70))}\n`);

  // EXPECTED result, built from source positions: the engine's kept lines plus every protected line, each exactly once, in place,
  // with every run of other lines collapsed into one correctly-counted marker.
  const expected: string[] = [];
  let run = 0;
  inLines.forEach((l, i) => {
    if (keptIdx.has(i) || isProtectedLine(l)) {
      if (run > 0) expected.push(`… ${String(run)} lines …`);
      run = 0;
      expected.push(l);
    } else {
      run += 1;
    }
  });
  if (run > 0) expected.push(`… ${String(run)} lines …`);

  const restored = restoreProtectedLines(input, rawAgg.stdout.replace(/\n$/, ""), []);
  assert.ok(restored.output === expected.join("\n"), "restored output equals the position-exact reconstruction");
  // spelled out for the record: every protected source line appears in order, exactly as often as in the source
  const outLines = restored.output.split("\n");
  let cursor = 0;
  for (const p of inLines.filter((l) => isProtectedLine(l))) {
    const at = outLines.indexOf(p, cursor);
    assert.ok(at >= cursor, `original order kept: ${p.slice(0, 50)}`);
    cursor = at + 1;
  }
  for (const { l } of droppedProtected) {
    assert.equal(outLines.filter((x) => x === l).length, inLines.filter((x) => x === l).length, `appears exactly as often as in the source: ${l.slice(0, 50)}`);
  }
  const rep = replay(input, restored.output);
  assert.ok(rep.ok, rep.why);
  assert.equal(restored.removedLines, rep.removed);
  // end to end through the production trimmer (same guarantee)
  const viaTrimmer = await new Trim1Trimmer({ command: BIN, point: "aggressive" }).trim(input, { budgetTokens: 1, keep: [], query: Q_SPEC });
  assert.equal(viaTrimmer.applied, true);
  assert.ok(viaTrimmer.output.replace(/\n$/, "") === expected.join("\n"));
});

// ---- 5. measurement: token reduction per handoff type ----

test("LIVE measurement: token reduction per handoff type at conservative / balanced / aggressive (printed as a table for TEST_REPORT.md)", { skip: SKIP }, async () => {
  const rows: string[] = ["| handoff type | bytes | tokens | conservative | balanced | aggressive |", "|---|---:|---:|---:|---:|---:|"];
  const results: Record<string, Record<string, number>> = {};
  for (const t of TYPES) {
    const input = payload(t.file);
    const cells: string[] = [];
    results[t.name] = {};
    for (const point of ["conservative", "balanced", "aggressive"] as const) {
      // budget 1 forces the trimmer to try; startPoint pins the operating point (the production wrapper would step up from it)
      const r = await new Trim1Trimmer({ command: BIN, point }).trim(input, { budgetTokens: 1, keep: [], query: t.query });
      const usedPoint = r.point;
      const saved = r.applied ? 1 - r.ratio : 0;
      // the production wrapper steps UP from the start point, so a "conservative" start can end at aggressive; report the point it actually used
      cells.push(r.applied ? `-${(saved * 100).toFixed(1)}% (${usedPoint ?? "?"})` : "0% (fail-closed)");
      results[t.name]![point] = saved;
      assert.ok(r.afterTokens <= r.beforeTokens);
      for (const l of input.split("\n").filter((x) => isProtectedLine(x))) assert.ok(r.output.includes(l), `${t.file}/${point}: protected line survives: ${l.slice(0, 40)}`);
    }
    rows.push(`| ${t.name} | ${String(Buffer.byteLength(input))} | ${String(estimateTokens(input))} | ${cells.join(" | ")} |`);
  }
  const table = rows.join("\n");
  process.stdout.write(`\n[trim-measurement]\n${table}\n`);
  const outDir = process.env["TRIM_MEASURE_OUT"];
  if (outDir !== undefined) writeFileSync(`${outDir}/trim-table.md`, `${table}\n`, "utf8");
  // the finding the report must carry: with the real model, conservative/balanced never cut real OSA payloads
  assert.equal(Object.values(results).every((r) => r["conservative"] === 0 || r["conservative"] === r["aggressive"]), true);
});

// ---- 6. Windows paths ----

test("LIVE Windows paths: a trim binary under a directory with spaces (and non-ASCII), given with backslashes, forward slashes or mixed, resolves and works from a cwd with spaces", { skip: SKIP }, async () => {
  const base = mkdtempSync(`${tmpdir()}/osa trim paths `);
  const dir = `${base}/Program Files (x86)/trím tool`;
  mkdirSync(dir, { recursive: true });
  copyFileSync(BIN, `${dir}/trim.exe`);
  const cwd = `${base}/work dir`;
  mkdirSync(cwd, { recursive: true });
  const fwd = `${dir}/trim.exe`.replace(/\\/g, "/");
  const back = fwd.replace(/\//g, "\\");
  const mixed = `${dir.replace(/\//g, "\\")}/trim.exe`;
  const input = payload("research-report.md");
  for (const binaryPath of [fwd, back, mixed]) {
    const resolved = await resolveTrimmer({ ...defaultOsaConfig().trim, enabled: true, binaryPath }, { cwd });
    assert.equal(resolved.trimmer.engine, "trim1", `resolved: ${binaryPath} (${resolved.note ?? ""})`);
    const r = await new Trim1Trimmer({ command: binaryPath, point: "aggressive", cwd }).trim(input, { budgetTokens: 1, keep: [], query: Q_SPEC });
    assert.equal(r.applied, true, `trims through ${binaryPath}`);
    assert.ok(r.output.length < input.length);
  }
});
