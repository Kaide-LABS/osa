import { test } from "node:test";
import assert from "node:assert/strict";
import { InternalError } from "../domain/errors.ts";
import { OsaConfig } from "../domain/osa-config.ts";
import type { RawInvocationResult } from "../domain/run.ts";
import type { RunProcessOptions } from "../util/exec.ts";
import { MemoryEventSink } from "../osa/events.ts";
import { NEVER_TRIM_LABELS, trimHandoff, trimText } from "./handoff.ts";
import { isProtectedLine } from "./protected.ts";
import { Trim1Trimmer, parseTrimStderr, resolveTrimmer, restoreProtectedLines } from "./trim1.ts";
import { NoopTrimmer, estimateTokens } from "./trimmer.ts";
import type { ContextTrimmer, TrimOptions, TrimResult } from "./trimmer.ts";

const raw = (over: Partial<RawInvocationResult> = {}): RawInvocationResult => ({ exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...over });

/** A big varied document of `n` filler lines plus the given extra lines inserted at the given indexes. */
function doc(n: number, extras: Record<number, string> = {}): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`Filler sentence number ${String(i)} about nothing in particular that matters here.`);
  for (const [idx, text] of Object.entries(extras).sort((a, b) => Number(b[0]) - Number(a[0]))) lines.splice(Number(idx), 0, text);
  return lines.join("\n") + "\n";
}

test("estimateTokens is about chars/4, rounded up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("NoopTrimmer returns the input unchanged and says why (ratio 1, applied false)", async () => {
  const r = await new NoopTrimmer("because").trim("hello world", { budgetTokens: 1, keep: [] });
  assert.equal(r.output, "hello world");
  assert.equal(r.applied, false);
  assert.equal(r.ratio, 1);
  assert.equal(r.engine, "noop");
  assert.equal(r.reason, "because");
  assert.equal(r.metBudget, false);
});

test("isProtectedLine: paths, hashes, errors, test names, URLs, headings, uncertainty markers and caller keep-strings", () => {
  const yes = [
    "see src/osa/lock.ts for details",
    "C:\\Users\\hp\\repo\\package.json was read",
    "sha256: 3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",
    "commit 0123456789abcdef0123456789abcdef01234567",
    "ERROR: cannot import name x",
    "the build failed with a panic",
    "✔ lockBabyPrd hashes the PRD (3ms)",
    "✖ lock rejects a changed PRD",
    "not ok 4 - something",
    "test('adds numbers', () => {",
    "- Docs: https://nodejs.org/api/fs.html",
    "## Findings",
    "- value is 5.2 [uncertain]",
    "- [unsupported] Node 99 exists",
  ];
  for (const l of yes) assert.equal(isProtectedLine(l), true, l);
  const no = ["Filler sentence number 4 about nothing in particular.", "The team met on Tuesday and agreed to continue.", ""];
  for (const l of no) assert.equal(isProtectedLine(l), false, l);
  assert.equal(isProtectedLine("keep this exact phrase please", ["exact phrase"]), true);
  assert.equal(isProtectedLine("nothing", [""]), false, "an empty keep string protects nothing");
});

test("parseTrimStderr reads trim-1's two summary shapes", () => {
  assert.deepEqual(parseTrimStderr("trim: kept 21 lines, removed 137, 11915 -> 1751 bytes\n"), { kind: "cut" });
  assert.deepEqual(parseTrimStderr("trim: unchanged (cut below the minimum)\n"), { kind: "unchanged", reason: "cut below the minimum" });
  assert.deepEqual(parseTrimStderr("garbage"), { kind: "unknown" });
});

test("restoreProtectedLines re-inserts dropped protected lines in order and collapses dropped runs into one marker", () => {
  const input = ["a1", "a2", "see src/x/y.ts here", "a3", "a4", "keepme", "a5"].join("\n");
  // The engine kept only a1 and a5, dropping the path line and 'keepme'.
  const engine = ["a1", "… 5 lines …", "a5"].join("\n");
  const r = restoreProtectedLines(input, engine, ["keepme"]);
  assert.equal(r.output, ["a1", "… 1 lines …", "see src/x/y.ts here", "… 2 lines …", "keepme", "a5"].join("\n"));
  assert.equal(r.removedLines, 3);
});

test("restoreProtectedLines: every protected input line survives byte-identical, even when the engine dropped it", () => {
  const protectedLines = ["ERROR: boom in src/a/b.ts", "sha256: " + "ab".repeat(32), "✖ some test"];
  const input = doc(40, { 5: protectedLines[0] as string, 20: protectedLines[1] as string, 33: protectedLines[2] as string });
  const engineOut = "Filler sentence number 0 about nothing in particular that matters here.\n… 42 lines …"; // drops everything else
  const r = restoreProtectedLines(input.replace(/\n$/, ""), engineOut, []);
  for (const p of protectedLines) assert.ok(r.output.split("\n").includes(p), p);
  assert.ok(r.removedLines > 0);
});

function fakeTrim1(behaviour: (point: string, query: string, stdin: string) => { stdout?: string; stderr: string; exitCode?: number | null; timedOut?: boolean }) {
  const calls: { point: string; query: string }[] = [];
  const runProcessFn = (o: RunProcessOptions): Promise<RawInvocationResult> => {
    const q = o.args[o.args.indexOf("--query") + 1] as string;
    const p = o.args[o.args.indexOf("--point") + 1] as string;
    calls.push({ point: p, query: q });
    const b = behaviour(p, q, o.stdin ?? "");
    return Promise.resolve(raw({ stdout: b.stdout ?? "", stderr: b.stderr, exitCode: b.exitCode ?? 0, timedOut: b.timedOut ?? false }));
  };
  return { runProcessFn, calls };
}

test("Trim1Trimmer steps conservative -> balanced -> aggressive until the budget is met, and re-inserts protected lines", async () => {
  const input = doc(200, { 100: "ERROR: kaboom in src/lock/index.ts" });
  const f = fakeTrim1((point) => {
    if (point === "aggressive") return { stdout: "Filler sentence number 0 about nothing in particular that matters here.\n… 200 lines …\n", stderr: "trim: kept 1 lines, removed 200, 1 -> 1 bytes" };
    return { stderr: "trim: unchanged (cut below the minimum)" };
  });
  const t = new Trim1Trimmer({ command: "trim", point: "conservative", runProcessFn: f.runProcessFn });
  const r = await t.trim(input, { budgetTokens: 500, keep: [], query: "why did the build fail" });
  assert.deepEqual(f.calls.map((c) => c.point), ["conservative", "balanced", "aggressive"]);
  assert.equal(r.applied, true);
  assert.equal(r.point, "aggressive");
  assert.equal(r.metBudget, true);
  assert.ok(r.afterTokens < r.beforeTokens);
  assert.ok(r.ratio < 1);
  assert.ok(r.output.includes("ERROR: kaboom in src/lock/index.ts"), "protected line survived although the engine dropped it");
  assert.ok(r.output.endsWith("\n"), "trailing newline preserved");
  assert.equal(f.calls[0]?.query, "why did the build fail");
});

test("Trim1Trimmer starts at the configured point and does not call the engine when already within budget or without a query", async () => {
  const f = fakeTrim1(() => ({ stderr: "trim: unchanged (cut below the minimum)" }));
  const t = new Trim1Trimmer({ command: "trim", point: "balanced", runProcessFn: f.runProcessFn });
  const small = await t.trim("tiny", { budgetTokens: 100, keep: [], query: "q" });
  assert.equal(small.applied, false);
  assert.match(small.reason ?? "", /within the token budget/);
  const noQuery = await t.trim(doc(300), { budgetTokens: 10, keep: [] });
  assert.match(noQuery.reason ?? "", /no query/);
  assert.equal(f.calls.length, 0);
  await t.trim(doc(300), { budgetTokens: 10, keep: [], query: "q" });
  assert.deepEqual(f.calls.map((c) => c.point), ["balanced", "aggressive"]);
});

test("Trim1Trimmer: an engine fault or timeout degrades to 'unchanged' with the reason; it never throws", async () => {
  for (const b of [{ stderr: "boom", exitCode: 1 }, { stderr: "", exitCode: null, timedOut: true }, { stderr: "gibberish" }]) {
    const f = fakeTrim1(() => b);
    const r = await new Trim1Trimmer({ command: "trim", point: "balanced", runProcessFn: f.runProcessFn }).trim(doc(300), { budgetTokens: 10, keep: [], query: "q" });
    assert.equal(r.applied, false);
    assert.ok((r.reason ?? "") !== "");
  }
});

test("Trim1Trimmer: when even aggressive cannot reach the budget without dropping protected lines, the result says so", async () => {
  const lines = Array.from({ length: 80 }, (_, i) => `ERROR number ${String(i)} in src/mod${String(i)}/file.ts something something`);
  const input = lines.join("\n") + "\n";
  const f = fakeTrim1(() => ({ stdout: "… 80 lines …\n", stderr: "trim: kept 0 lines, removed 80, 1 -> 1 bytes" }));
  const r = await new Trim1Trimmer({ command: "trim", point: "aggressive", runProcessFn: f.runProcessFn }).trim(input, { budgetTokens: 5, keep: [], query: "q" });
  assert.equal(r.metBudget, false);
  assert.match(r.reason ?? "", /budget could not be met/);
  for (const l of lines) assert.ok(r.output.includes(l));
});

test("resolveTrimmer: disabled / noop / absent binary / imposter all fall back to the no-op engine WITH a reason; a genuine probe selects trim-1", async () => {
  // trim-1 is OFF by default (WS10); these tests are about what happens when it is switched ON, so they say so (an explicit `enabled: false` still wins).
  const cfg = (t: object) => OsaConfig.parse({ trim: { enabled: true, ...t } }).trim;
  assert.equal((await resolveTrimmer(cfg({ enabled: false }))).trimmer.engine, "noop");
  assert.equal((await resolveTrimmer(cfg({ engine: "noop" }))).trimmer.engine, "noop");
  const absent = await resolveTrimmer(cfg({}), { runProcessFn: () => Promise.resolve(raw({ exitCode: null, stderr: "spawn trim ENOENT" })) });
  assert.equal(absent.trimmer.engine, "noop");
  assert.match(absent.note ?? "", /not available[\s\S]*go install/);
  const imposter = await resolveTrimmer(cfg({}), { runProcessFn: () => Promise.resolve(raw({ exitCode: 0, stderr: "some other tool called trim" })) });
  assert.equal(imposter.trimmer.engine, "noop");
  const genuine = await resolveTrimmer(cfg({ binaryPath: "/opt/trim", point: "aggressive" }), {
    runProcessFn: (o) => Promise.resolve(raw({ exitCode: 0, stderr: `trim: unchanged (context below the minimum size) [${o.command}]`.replace(/ \[.*\]$/, "") })),
  });
  assert.equal(genuine.trimmer.engine, "trim1");
  assert.equal(genuine.note, null);
});

// ---- handoff: what must never be trimmed (WS4.3) ----

function spyTrimmer(): { trimmer: ContextTrimmer; seen: string[] } {
  const seen: string[] = [];
  const trimmer: ContextTrimmer = {
    engine: "spy",
    trim(input: string, opts: TrimOptions): Promise<TrimResult> {
      seen.push(input);
      const out = input.split("\n").slice(0, 3).join("\n");
      return Promise.resolve({ output: out, removedLines: input.split("\n").length - 3, ratio: out.length / input.length, applied: true, engine: "spy", beforeTokens: estimateTokens(input), afterTokens: estimateTokens(out), metBudget: true, reason: null, point: null, ...(opts.query === undefined ? {} : {}) });
    },
  };
  return { trimmer, seen };
}

test("PRD and spec content passes through the handoff byte-identical and is never even shown to the trimmer (WS4.3)", async () => {
  const prd = "# Baby PRD\r\n\r\n## TL;DR\n- exact bytes \u00e9 \t trailing spaces   \n\n\n### Acceptance criteria\n1. It works.\n";
  const spec = "# Phase 1\n" + "line of spec\n".repeat(400) + "https://nodejs.org/docs\n";
  const report = doc(200);
  const { trimmer, seen } = spyTrimmer();
  const events = new MemoryEventSink();
  const r = await trimHandoff(
    [
      { label: "prd", text: prd, trimmable: false },
      { label: "spec", text: spec, trimmable: false },
      { label: "research-report", text: report, trimmable: true, query: "q" },
    ],
    { trimmer, events, defaultBudgetTokens: 50 },
  );
  assert.equal(r.parts[0]?.text, prd, "PRD byte-identical");
  assert.equal(r.parts[1]?.text, spec, "spec byte-identical");
  assert.equal(r.parts[0]?.trimmed, false);
  assert.equal(r.parts[2]?.trimmed, true);
  assert.deepEqual(seen, [report], "the trimmer saw only the research report");
  assert.ok(!seen.some((s) => s.includes("Baby PRD") || s.includes("Phase 1")));
});

test("trying to mark the PRD / spec / acceptance criteria / context as trimmable is an InternalError, not a quiet downgrade", async () => {
  const { trimmer, seen } = spyTrimmer();
  for (const label of NEVER_TRIM_LABELS) {
    await assert.rejects(trimHandoff([{ label: label.toUpperCase(), text: "x", trimmable: true }], { trimmer, events: new MemoryEventSink(), defaultBudgetTokens: 1 }), InternalError, label);
  }
  assert.equal(seen.length, 0);
});

test("trim_applied logs before/after tokens and ratio; trim_skipped logs the reason and the engine note", async () => {
  const events = new MemoryEventSink();
  const spy = spyTrimmer();
  await trimText("research-report", doc(100), "q", { trimmer: spy.trimmer, events, defaultBudgetTokens: 10 });
  const applied = events.events.find((e) => e.event === "trim_applied");
  assert.equal(applied?.data["label"], "research-report");
  assert.ok((applied?.data["beforeTokens"] as number) > (applied?.data["afterTokens"] as number));
  assert.ok((applied?.data["ratio"] as number) < 1);

  const events2 = new MemoryEventSink();
  const out = await trimText("phase-output", "hello there", "q", { trimmer: new NoopTrimmer("trim.engine is noop"), events: events2, defaultBudgetTokens: 10, engineNote: "note" });
  assert.equal(out, "hello there");
  const skipped = events2.events.find((e) => e.event === "trim_skipped");
  assert.equal(skipped?.data["reason"], "trim.engine is noop");
  assert.equal(skipped?.data["engineNote"], "note");
  assert.deepEqual(events2.names(), ["trim_skipped"]);
});

// ---- opt-in live check against a real trim-1 binary: TRIM1_BIN=/path/to/trim.exe node --test ----

test("LIVE (opt-in via TRIM1_BIN): the real trim-1 binary keeps the error line, reinserts protected lines, and shrinks a varied document", { skip: process.env["TRIM1_BIN"] === undefined }, async () => {
  const topics = ["parser", "scheduler", "cache", "logger", "router", "auth", "queue", "metrics", "config", "retry", "pool", "codec"];
  const lines: string[] = ["# Build notes", ""];
  for (let s = 0; s < 14; s++) {
    lines.push(`## Section ${String(s)}: ${topics[s % 12]} subsystem`);
    for (let i = 0; i < 9; i++) lines.push(`The ${topics[(s + i) % 12]} module number ${String(s * 10 + i)} handles buffering and was reviewed by team ${String(s % 5)} during sprint ${String(s + i)}.`);
    lines.push("");
  }
  lines.splice(60, 0, "ERROR: ModuleNotFoundError: cannot import name lock_baby_prd from osa.lock");
  lines.splice(100, 0, "the path runs/abc/baby-prd.md must stay verbatim");
  const input = lines.join("\n") + "\n";
  const r = await new Trim1Trimmer({ command: process.env["TRIM1_BIN"] as string, point: "balanced" }).trim(input, { budgetTokens: 600, keep: [], query: "what is the ModuleNotFoundError about lock_baby_prd" });
  assert.equal(r.applied, true);
  assert.ok(r.afterTokens < r.beforeTokens);
  assert.ok(r.output.includes("ERROR: ModuleNotFoundError: cannot import name lock_baby_prd from osa.lock"));
  assert.ok(r.output.includes("the path runs/abc/baby-prd.md must stay verbatim"));
  assert.match(r.output, /… \d+ lines …/);
});
