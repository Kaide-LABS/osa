import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { UsageError } from "../domain/errors.ts";
import { OsaConfig } from "../domain/osa-config.ts";
import { parseArgs } from "../cli/main.ts";
import { runMemoryCommand } from "../cli/memory-cmd.ts";
import { buildMcpServer } from "../mcp/server.ts";
import { MemoryAppendOutput, MemoryReadOutput } from "../mcp/tools/memory.ts";
import { MinIntervalLimiter } from "../research/net/http.ts";
import { NoopTrimmer } from "../trim/trimmer.ts";
import { MemoryEventSink } from "../osa/events.ts";
import { fakeModel, researchFetch, samplePrd, tempGitRepo } from "../osa/fixtures.test.ts";
import { runOsaCommand } from "../osa/pipeline.ts";
import type { LockIO } from "../osa/lock.ts";
import { deriveFacts, writeRunMemory } from "./derive.ts";
import type { RunRecord } from "./derive.ts";
import { entropy, findSecret } from "./secrets.ts";
import { MEMORY_CATEGORIES, appendFacts, factKey, formatFactLine, formatMemoryForPrompt, memoryFile, parseFacts, readFacts, readMemoryForPrompt, rejectReason } from "./store.ts";

// ---------------------------------------------------------------- never stores secrets

test("the secret filter rejects credential-shaped text and accepts ordinary facts", () => {
  const secrets = [
    "-----BEGIN RSA PRIVATE KEY----- MIIE",
    "use sk-abcdefghijklmnopqrstuvwx for the API",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    "slack xoxb-1234567890-abcdefghij",
    "aws AKIAIOSFODNN7EXAMPLE",
    "google AIzaSyA-1234567890abcdefghijklmnopqrstuv",
    "jwt eyJhbGciOiJIUzI1NiIsInR5.eyJzdWIiOiIxMjM0NTY3ODkwIiwi.SflKxwRJSMeKKF2QT4fwpMeJf36POk6",
    "send header Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    "the password: hunter2hunter2",
    "set API_KEY=abc123def456ghi",
    "connect to postgres://admin:s3cr3tpw@db.internal:5432/app",
    "random 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a",
  ];
  for (const s of secrets) assert.notEqual(findSecret(s), null, s);
  const fine = [
    "Uses Node.js and the built-in test runner.",
    "Config lives in osa.config.json; see runs/abababab/spec/context.md for the layout.",
    "The password check lives in src/auth/login.ts.",
    "Tokens are rotated hourly (policy, no value stored).",
    "Prefer small functions; avoid global state.",
  ];
  for (const s of fine) assert.equal(findSecret(s), null, s);
  assert.ok(entropy("aaaaaaaa") < 1 && entropy("a1b2c3d4e5f6g7h8") > 3.5);
});

test("rejection reasons: empty, multi-line, too long, secret-shaped", () => {
  assert.equal(rejectReason("  "), "empty");
  assert.match(rejectReason("a\nb") ?? "", /single line/);
  assert.match(rejectReason("x".repeat(301)) ?? "", /longer than 300/);
  assert.match(rejectReason("key sk-abcdefghijklmnopqrstuvwx") ?? "", /never stores secrets/);
  assert.equal(rejectReason("A normal fact."), null);
});

// ---------------------------------------------------------------- the store

test("facts are one per line, human-readable, stamped, de-duplicated; rejections are REPORTED, not swallowed", async () => {
  const repoDir = await tempGitRepo();
  const r = await appendFacts(repoDir, "decisions", ["Uses SQLite for storage.", "Uses SQLite for storage", "Key is sk-abcdefghijklmnopqrstuvwx", "multi\nline"], { runId: "abcdef12-0000-4000-8000-000000000000", date: "2026-10-17" });
  assert.deepEqual(r.appended, ["Uses SQLite for storage."]);
  assert.deepEqual(r.duplicates, ["Uses SQLite for storage"], "case/punctuation-insensitive duplicate");
  assert.equal(r.rejected.length, 2);
  assert.match(r.rejected[0]?.reason ?? "", /secrets/);
  const file = await readFile(memoryFile(repoDir, "decisions"), "utf8");
  assert.match(file, /^# Decisions/);
  assert.match(file, /^- Uses SQLite for storage\. _\(run abcdef12, 2026-10-17\)_$/m);
  assert.ok(!file.includes("sk-abc"), "the secret never touched the disk");
  assert.equal(file.split("\n").filter((l) => l.startsWith("- ")).length, 1);

  const again = await appendFacts(repoDir, "decisions", ["Uses SQLite for storage."]);
  assert.deepEqual([again.appended.length, again.duplicates.length], [0, 1]);
  assert.deepEqual((await readFacts(repoDir, ["decisions"])).map((f) => [f.text, f.runId, f.date]), [["Uses SQLite for storage.", "abcdef12", "2026-10-17"]]);
});

test("line format round-trips; hand-written lines without provenance are read too", () => {
  const line = formatFactLine("Prefers tabs", "12345678-aaaa-4bbb-8ccc-dddddddddddd", "2026-01-02");
  assert.equal(line, "- Prefers tabs _(run 12345678, 2026-01-02)_");
  assert.deepEqual(parseFacts("preferences", `# Preferences\n\nintro text\n${line}\n- A hand-written fact\n`).map((f) => [f.text, f.runId]), [["Prefers tabs", "12345678"], ["A hand-written fact", null]]);
  assert.equal(factKey("  Uses   SQLite. "), factKey("uses sqlite"));
});

test("the per-file cap drops the OLDEST facts and says how many", async () => {
  const repoDir = await tempGitRepo();
  await appendFacts(repoDir, "failures", ["one", "two", "three"], { date: "2026-01-01" });
  const r = await appendFacts(repoDir, "failures", ["four", "five"], { maxFacts: 3, date: "2026-01-02" });
  assert.equal(r.compacted, 2);
  assert.deepEqual((await readFacts(repoDir, ["failures"])).map((f) => f.text), ["three", "four", "five"]);
});

test("the prompt block is newest-first, bounded, stripped of provenance, and null when empty", async () => {
  const repoDir = await tempGitRepo();
  assert.equal(await readMemoryForPrompt(repoDir), null);
  await appendFacts(repoDir, "decisions", ["old decision", "new decision"], { runId: "aaaaaaaa-0000-4000-8000-000000000000" });
  await appendFacts(repoDir, "preferences", ["Likes short functions"]);
  const block = (await readMemoryForPrompt(repoDir)) ?? "";
  assert.match(block, /^Decisions:\n- new decision\n- old decision\n\nPreferences:\n- Likes short functions$/);
  assert.ok(!block.includes("run aaaaaaaa"));
  const tiny = formatMemoryForPrompt(await readFacts(repoDir), 20) ?? "";
  assert.ok(tiny.length < 60 && tiny.includes("new decision") === false || tiny.length <= 60);
  assert.deepEqual([...MEMORY_CATEGORIES], ["decisions", "conventions", "failures", "preferences"]);
});

// ---------------------------------------------------------------- derivation from the run record

const baseRecord = (over: Partial<RunRecord> = {}): RunRecord => {
  const gen = samplePrd({ risky: true });
  return {
    runId: "11111111-2222-4333-8444-555555555555",
    date: "2026-10-17",
    prdGenerated: gen,
    prdLocked: gen,
    outcome: "finished",
    stoppedBecause: null,
    specAssumptions: ["Output uses plain text.", "Words are split on whitespace."],
    architecture: { chosen: "planned", why: "Files are small." },
    flaggedClaims: ["util.parseArgs defaults allowPositionals to true"],
    failedResearchItems: [],
    phases: [{ phase: 1, ok: true, retriedTurns: 1, problems: [] }],
    applicationUnmet: [],
    applicationCouldNotRun: null,
    ...over,
  };
};

test("facts come from the run's record: decisions, conventions, failures", () => {
  const f = deriveFacts(baseRecord());
  assert.ok(f.decisions.includes("Accepted risky assumption: Input files may contain personal data and are never uploaded."));
  assert.ok(f.decisions.some((d) => /^Architecture: kept the planned architecture -- Files are small\./.test(d)));
  assert.ok(f.decisions.includes("Spec decision: Output uses plain text."));
  assert.ok(f.decisions.some((d) => d.startsWith("Out of scope: A graphical interface")));
  assert.ok(f.conventions.some((c) => /Technologies\/libraries this project documents and relies on: Node\.js/.test(c)));
  assert.ok(f.conventions.includes("Constraint: Node.js only"));
  assert.ok(f.failures.includes("Phase 1 needed 1 retry(ies) after a continuity failure, then passed"));
  assert.ok(f.failures.includes("Unconfirmed research claim (do not rely on it): util.parseArgs defaults allowPositionals to true"));
  assert.deepEqual(f.preferences, [], "the person changed nothing at the lock");
});

test("failed runs are remembered: stop reason, failed phases, unmet requirements, a check that could not run", () => {
  const f = deriveFacts(
    baseRecord({
      outcome: "stopped",
      stoppedBecause: "continuity failed twice",
      phases: [{ phase: 2, ok: false, retriedTurns: 1, problems: ["continuity check failed twice"] }],
      applicationUnmet: [{ text: "A missing file prints an error.", reason: "claimed as met but no evidence" }],
      applicationCouldNotRun: "provider down",
      failedResearchItems: [{ slug: "docs-x", problem: "no official source" }],
    }),
  );
  assert.ok(f.failures.includes("Run stopped: continuity failed twice"));
  assert.ok(f.failures.includes("Phase 2 did not complete: continuity check failed twice"));
  assert.ok(f.failures.some((x) => x.startsWith("Final check found a requirement NOT met: A missing file prints an error. (claimed as met")));
  assert.ok(f.failures.includes("The final check could not be carried out: provider down"));
  assert.ok(f.failures.includes("Research item docs-x failed: no official source"));
});

test("preferences are what the person CHANGED at the lock (scope, acceptance criteria, risk tags)", () => {
  const gen = samplePrd({ risky: true });
  const locked = {
    ...gen,
    inScope: [...gen.inScope.filter((x) => x !== "Print a total"), "Show a per-file breakdown"],
    outOfScope: [...gen.outOfScope, "Windows support"],
    acceptanceCriteria: [...gen.acceptanceCriteria, "It handles empty files."],
    assumptions: gen.assumptions.map((a) => (a.risk === "risky" ? { ...a, risk: "safe" as const } : a)),
  };
  const f = deriveFacts(baseRecord({ prdGenerated: gen, prdLocked: locked }));
  assert.ok(f.preferences.includes("Wanted in scope: Show a per-file breakdown"));
  assert.ok(f.preferences.includes("Did not want in scope: Print a total"));
  assert.ok(f.preferences.includes("Wanted out of scope: Windows support"));
  assert.ok(f.preferences.includes("Added acceptance criterion: It handles empty files."));
  assert.ok(f.preferences.includes("Treats as safe: Input files may contain personal data and are never uploaded."));
  assert.ok(!f.decisions.some((d) => d.startsWith("Accepted risky")), "no longer risky once the person re-tagged it");
});

test("writeRunMemory stores the facts, commits .osa/memory, logs memory_written, and REJECTS a secret-shaped fact visibly", async () => {
  const repoDir = await tempGitRepo();
  const events = new MemoryEventSink();
  const rec = baseRecord({ specAssumptions: ["Deploy key is sk-abcdefghijklmnopqrstuvwx"] });
  const r = await writeRunMemory(repoDir, rec, { events });
  assert.ok(r.appended > 3);
  assert.equal(r.rejected, 1);
  assert.equal(r.committed, true);
  const e = events.events.find((x) => x.event === "memory_written");
  assert.equal(e?.data["rejected"], 1);
  assert.match(String((e?.data["rejectedReasons"] as string[])[0]), /secrets/);
  assert.equal(execFileSync("git", ["status", "--porcelain", "--", ".osa/memory"], { cwd: repoDir }).toString().trim(), "");
  assert.ok(!(await readFile(memoryFile(repoDir, "decisions"), "utf8")).includes("sk-abc"));
});

test("memory that the project has git-ignored is written but NOT committed (it is git-ignorable)", async () => {
  const repoDir = await tempGitRepo();
  await writeFile(`${repoDir}/.gitignore`, ".osa/memory/\n", "utf8");
  execFileSync("git", ["add", ".gitignore"], { cwd: repoDir });
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "ignore memory"], { cwd: repoDir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
  const r = await writeRunMemory(repoDir, baseRecord());
  assert.ok(r.appended > 0);
  assert.equal(r.committed, false);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim(), head);
  assert.ok((await readFacts(repoDir)).length > 0);
});

// ---------------------------------------------------------------- MCP tools and CLI

test("memory_read and memory_append over a real MCP round trip: validation, de-duplication, rejection reporting", async () => {
  const repoDir = await tempGitRepo();
  const server = buildMcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  try {
    const app = await client.callTool({ name: "memory_append", arguments: { repo_dir: repoDir, category: "conventions", facts: ["We use pnpm.", "We use pnpm.", "token=abcdef123456"] } });
    const out = MemoryAppendOutput.parse(app.structuredContent);
    assert.deepEqual(out.appended, ["We use pnpm."]);
    assert.equal(out.duplicates.length, 1);
    assert.equal(out.rejected.length, 1);
    const read = await client.callTool({ name: "memory_read", arguments: { repo_dir: repoDir, as_prompt: true } });
    const rd = MemoryReadOutput.parse(read.structuredContent);
    assert.deepEqual(rd.facts.map((f) => f.text), ["We use pnpm."]);
    assert.equal(rd.prompt, "Conventions:\n- We use pnpm.");
    const only = MemoryReadOutput.parse((await client.callTool({ name: "memory_read", arguments: { repo_dir: repoDir, categories: ["failures"] } })).structuredContent);
    assert.deepEqual(only.facts, []);
    const bad = await client.callTool({ name: "memory_append", arguments: { repo_dir: repoDir, category: "nonsense", facts: ["x"] } });
    assert.equal(bad.isError, true, "an unknown category is refused by the schema");
  } finally {
    await client.close();
    await server.close();
  }
});

test("osa memory: parsing and output", async () => {
  const argv = (...a: string[]): string[] => ["node", "osa", ...a];
  assert.equal(parseArgs(argv("memory")).kind, "memory");
  assert.throws(() => parseArgs(argv("memory", "--bogus")), UsageError);
  const repoDir = await tempGitRepo();
  assert.match((await runMemoryCommand({ sub: "show", repoDir, json: false })).text, /No project memory yet/);
  await appendFacts(repoDir, "decisions", ["Chose SQLite."]);
  assert.match((await runMemoryCommand({ sub: "show", repoDir, json: false })).text, /^decisions \(1\):\n {2}- Chose SQLite\./);
  assert.equal((JSON.parse((await runMemoryCommand({ sub: "show", repoDir, json: true })).text) as { facts: unknown[] }).facts.length, 1);
});

// ---------------------------------------------------------------- the round trip the directive names

const io: LockIO = { show: () => undefined, choose: () => Promise.resolve("lock"), edit: () => Promise.resolve() };

function pipelineDeps(repoDir: string, runId: string, model: ReturnType<typeof fakeModel>, over: Record<string, unknown> = {}) {
  return {
    events: new MemoryEventSink(runId),
    io,
    interactive: true,
    runId,
    config: OsaConfig.parse({ agents: { application: false } }),
    textCall: model.call,
    research: { http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
    trimmer: { trimmer: new NoopTrimmer("noop"), note: null },
    drive: {
      runDispatchFn: (async (rc: { spec_path: string; phase: number; is_final_phase: boolean }) => {
        const dir = rc.spec_path.slice(0, rc.spec_path.lastIndexOf("/") + 1);
        await mkdir(`${repoDir}/${dir}`, { recursive: true });
        await writeFile(rc.is_final_phase ? `${repoDir}/BUILD_COMPLETE.md` : `${repoDir}/${dir}PHASE_${String(rc.phase + 1)}_SPEC.md`, "x\n", "utf8");
        return { ok: true, exitCode: 0, turns: [{ turnIndex: 0, archetype: "executor", provider: "claude-code", status: "completed", continuityVerdict: null, retried: true }], halt: null, problems: [], warnings: [] };
      }) as never,
    },
    ...over,
  };
}

test("WS8 round trip: memory is WRITTEN at the end of a run and READ at the next run's intake", async () => {
  const repoDir = await tempGitRepo();
  const run1 = "aaaaaaaa-1111-4111-8111-111111111111";
  const m1 = fakeModel({ prd: samplePrd({ risky: true }) });
  const first = await runOsaCommand({ prompt: "make a word counter", files: [], repoDir, yes: false, json: false }, pipelineDeps(repoDir, run1, m1) as never);
  assert.equal(first.ok, true, first.problems.join("; "));
  // nothing remembered yet, so the first intake saw no memory block
  assert.ok(!(m1.log.find((l) => l.purpose === "intake")?.req.prompt ?? "").includes("PROJECT MEMORY"));

  const decisions = await readFile(memoryFile(repoDir, "decisions"), "utf8");
  assert.match(decisions, /Accepted risky assumption: Input files may contain personal data/);
  assert.match(decisions, /Architecture: kept the planned architecture/);
  assert.match(await readFile(memoryFile(repoDir, "failures"), "utf8"), /Phase \d needed 1 retry\(ies\)/);
  assert.equal(execFileSync("git", ["status", "--porcelain", "--", ".osa/memory"], { cwd: repoDir }).toString().trim(), "", "committed");
  assert.ok(first.warnings.every((w) => !/memory/i.test(w)));

  // the NEXT run reads it at intake...
  const run2 = "bbbbbbbb-2222-4222-8222-222222222222";
  const m2 = fakeModel();
  const events2 = new MemoryEventSink(run2);
  await runOsaCommand({ prompt: "add a feature", files: [], repoDir, yes: true, json: false, build: false }, pipelineDeps(repoDir, run2, m2, { events: events2 }) as never);
  const intake = m2.log.find((l) => l.purpose === "intake")?.req.prompt ?? "";
  assert.match(intake, /=== PROJECT MEMORY[\s\S]*Decisions:[\s\S]*Accepted risky assumption: Input files may contain personal data/);
  // ...and the spec author sees it too
  assert.match(m2.log.find((l) => l.purpose === "spec")?.req.prompt ?? "", /=== PROJECT MEMORY \(EARLIER RUNS ON THIS PROJECT\) ===[\s\S]*Decisions:/);
  // a second run writes only NEW facts (de-duplicated)
  assert.ok(events2.names().includes("memory_written"));
});

test("memory.enabled=false: nothing is read at intake and nothing is written", async () => {
  const repoDir = await tempGitRepo();
  await appendFacts(repoDir, "decisions", ["An earlier decision."]);
  const model = fakeModel();
  await runOsaCommand({ prompt: "x y", files: [], repoDir, yes: true, json: false, build: false }, pipelineDeps(repoDir, "cccccccc-3333-4333-8333-333333333333", model, { config: OsaConfig.parse({ memory: { enabled: false } }) }) as never);
  assert.ok(!(model.log.find((l) => l.purpose === "intake")?.req.prompt ?? "").includes("PROJECT MEMORY"));
  assert.equal((await readFacts(repoDir)).length, 1, "only the pre-existing fact");
  void parseFacts;
});

// ---- found by the first live end-to-end run ----

test("REGRESSION: UUIDs are identifiers, not secrets -- a failure note carrying a run id is stored (it used to be rejected as a 'long random-looking token')", () => {
  assert.equal(findSecret("Failed in run 84ef52b0-1811-47d3-80d2-4a1deb763106 at phase 1"), null);
  assert.notEqual(findSecret("api key 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a"), null, "hex secrets are still caught");
  assert.notEqual(findSecret("token=84ef52b0-1811-47d3-80d2-4a1deb763106"), null, "a credential assignment is a secret even when the value is UUID-shaped");
});

test("derived failure facts are scrubbed of run ids, absolute paths and BOMs so memory stays useful", () => {
  const bs = String.fromCharCode(92);
  const winPath = ["C:", "Users", "hp", "AppData", "Local", "Temp", "osa-full-x", ".osa", "runs", "84ef52b0-1811-47d3-80d2-4a1deb763106", "handoff", "1", "001-executor-codex-cli.json"].join(bs);
  const nasty = `Failed to parse ${winPath} as JSON: Unexpected token '${String.fromCharCode(0xfeff)}'`;
  const f = deriveFacts({ ...baseRecord(), phases: [{ phase: 1, ok: false, retriedTurns: 0, problems: [nasty, "see /tmp/osa-x/y.log"] }], flaggedClaims: [], specAssumptions: [] });
  const line = f.failures.find((x) => x.startsWith("Phase 1 did not complete")) ?? "";
  assert.equal(line, "Phase 1 did not complete: Failed to parse <path> as JSON: Unexpected token ''");
  assert.equal(findSecret(line), null);
});
