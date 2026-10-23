import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caveatFor, cbmConfigProblem, createCodeSearcher } from "./searcher.ts";
import type { CodeSearchEngine, EngineAnswer } from "./engine.ts";
import { OsaConfig } from "../domain/osa-config.ts";
import type { EventSink, OsaEventName } from "../osa/events.ts";
import { renderIndexContext } from "./guard.ts";

const index = (patch: Record<string, unknown> = {}) => OsaConfig.parse({ index: patch }).index;

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "osa-searcher-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "lock.ts"), "export function lockPrd(): string {\n  return 'locked';\n}\n", "utf8");
  return dir;
}

function sink(): { events: { event: OsaEventName; data: Record<string, unknown> }[]; sink: EventSink } {
  const events: { event: OsaEventName; data: Record<string, unknown> }[] = [];
  return { events, sink: { emit: (event, data) => (events.push({ event, data: { ...(data ?? {}) } }), Promise.resolve()) } };
}

const fakeAnswer = (patch: Partial<EngineAnswer> = {}): EngineAnswer => ({
  engine: "cbm",
  hits: [{ path: "src/lock.ts", startLine: 1, endLine: 3, symbol: "lockPrd", score: 1, snippet: "export function lockPrd()" }],
  confidence: "high",
  abstained: false,
  reason: "three independent channels agree",
  signals: null,
  stale: [],
  ms: 1,
  ...patch,
});

const fakeEngine = (answer: EngineAnswer, calls: string[] = []): CodeSearchEngine => ({
  name: "cbm",
  search: (q) => (calls.push(`search:${q}`), Promise.resolve(answer)),
  refresh: () => (calls.push("refresh"), Promise.resolve()),
  close: () => (calls.push("close"), Promise.resolve()),
});

test("the CBM engine is OFF by default and its config is validated", () => {
  const d = OsaConfig.parse({}).index;
  assert.equal(d.engine, "lexical");
  assert.deepEqual(d.cbm, { binaryPath: "", workDir: "", indexMode: "full", abstain: false });
  assert.match(cbmConfigProblem(d) ?? "", /binaryPath and index\.cbm\.workDir/);
  assert.equal(cbmConfigProblem(index({ cbm: { binaryPath: "/x/cbm", workDir: "/x/work" } })), null);
  assert.throws(() => OsaConfig.parse({ index: { engine: "elastic" } }));
  assert.throws(() => OsaConfig.parse({ index: { cbm: { binaryPath: "x", shell: true } } }), "strict: no unknown keys");
});

test("lexical (default): answers from OSA's own index, never opens CBM, and logs code_search_engine", async () => {
  const dir = await repo();
  const log = sink();
  let opened = 0;
  const s = createCodeSearcher({ repoDir: dir, index: index(), events: log.sink, openCbm: () => (opened++, Promise.resolve(fakeEngine(fakeAnswer()))) });
  const a = await s.search("where is the PRD locked", { k: 3, purpose: "agent-context" });
  assert.equal(a.engine, "lexical");
  assert.equal(a.hits[0]?.path, "src/lock.ts");
  assert.equal(opened, 0);
  const ev = log.events.find((e) => e.event === "code_search_engine");
  assert.deepEqual({ requested: ev?.data["requested"], engine: ev?.data["engine"], confidence: ev?.data["confidence"], purpose: ev?.data["purpose"] }, { requested: "lexical", engine: "lexical", confidence: "unassessed", purpose: "agent-context" });
  await s.close();
});

test("cbm: opens once, refreshes before each search, passes the engine's confidence through, logs it, and closes", async () => {
  const dir = await repo();
  const log = sink();
  const calls: string[] = [];
  let opened = 0;
  const s = createCodeSearcher({ repoDir: dir, index: index({ engine: "cbm", cbm: { binaryPath: "b", workDir: "w" } }), events: log.sink, openCbm: () => (opened++, Promise.resolve(fakeEngine(fakeAnswer(), calls))) });
  const a = await s.search("lock", { k: 3, purpose: "t" });
  await s.search("lock again", { k: 3, purpose: "t" });
  assert.equal(a.engine, "cbm");
  assert.equal(a.confidence, "high");
  assert.equal(opened, 1);
  assert.deepEqual(calls, ["refresh", "search:lock", "refresh", "search:lock again"]);
  assert.equal(log.events.filter((e) => e.event === "code_search_engine").length, 2);
  await s.close();
  assert.equal(calls.at(-1), "close");
  await s.close();
});

test("cbm that cannot start (or is not configured) falls back to the local index, LOW confidence, and says why -- never an error", async () => {
  const dir = await repo();
  for (const [name, idx, opener] of [
    ["not configured", index({ engine: "cbm" }), undefined],
    ["fails to start", index({ engine: "cbm", cbm: { binaryPath: "b", workDir: "w" } }), () => Promise.reject(new Error("binary missing"))],
  ] as const) {
    const log = sink();
    const s = createCodeSearcher({ repoDir: dir, index: idx, events: log.sink, ...(opener !== undefined ? { openCbm: opener } : {}) });
    const a = await s.search("lockPrd", { k: 3, purpose: "t" });
    assert.equal(a.engine, "lexical-fallback", name);
    assert.equal(a.confidence, "low", name);
    assert.ok(a.hits.length > 0, `${name}: the fallback still answers`);
    assert.match(a.reason, /not available/);
    const cse = log.events.find((e) => e.event === "code_search_engine");
    assert.equal(cse?.data["engine"], "lexical-fallback", name);
    assert.equal(cse?.data["requested"], "cbm", name);
    await s.close();
  }
});

test("cbm that dies mid-search falls back for that search", async () => {
  const dir = await repo();
  const engine: CodeSearchEngine = { name: "cbm", search: () => Promise.reject(new Error("pipe closed")), refresh: () => Promise.resolve(), close: () => Promise.resolve() };
  const s = createCodeSearcher({ repoDir: dir, index: index({ engine: "cbm", cbm: { binaryPath: "b", workDir: "w" } }), openCbm: () => Promise.resolve(engine) });
  const a = await s.search("lockPrd", { k: 3, purpose: "t" });
  assert.equal(a.engine, "lexical-fallback");
  assert.match(a.reason, /pipe closed/);
});

test("auto-inserted agent context carries the confidence: nothing is said when high, a plain warning when medium, low, abstained or fallen back", () => {
  const p = (x: Partial<Parameters<typeof caveatFor>[0]>) => ({ engine: "cbm", confidence: "high" as const, abstained: false, reason: "r", ...x });
  assert.equal(caveatFor(p({})), "");
  assert.equal(caveatFor(p({ confidence: "unassessed", engine: "lexical" })), "");
  assert.match(caveatFor(p({ confidence: "medium" })), /^Confidence: medium/);
  assert.match(caveatFor(p({ confidence: "low" })), /^Confidence: LOW.*confirm with grep/);
  assert.match(caveatFor(p({ abstained: true, confidence: "high" })), /^Confidence: LOW/);
  assert.match(caveatFor(p({ engine: "lexical-fallback", confidence: "low" })), /main index was not used/);
  const hits = fakeAnswer().hits;
  const ctx = renderIndexContext(hits, 4, caveatFor(p({ confidence: "low" })));
  assert.match(ctx, /Confidence: LOW/);
  assert.doesNotMatch(renderIndexContext(hits, 4, ""), /Confidence:/);
});

test("structure views (architecture, changes): unavailable without the cbm engine, passed through from it when configured, and a failure is an answer, not an error", async () => {
  const dir = await repo();
  const lexicalOnly = createCodeSearcher({ repoDir: dir, index: index() });
  const none = await lexicalOnly.structure("architecture");
  assert.equal(none.available, false);
  assert.match(none.note ?? "", /index\.engine "cbm"/);

  const graph = { ...fakeEngine(fakeAnswer()), architecture: () => Promise.resolve({ total_nodes: 15 }), changes: (scope: string) => Promise.resolve({ since: "abc", result: { changed_files: ["src/a.ts"], scope }, note: null }) };
  const cfg = index({ engine: "cbm", cbm: { binaryPath: "b", workDir: "w" } });
  const s = createCodeSearcher({ repoDir: dir, index: cfg, openCbm: () => Promise.resolve(graph as unknown as CodeSearchEngine) });
  const arch = await s.structure("architecture");
  assert.deepEqual([arch.available, arch.engine, (arch.data as { total_nodes: number }).total_nodes], [true, "cbm", 15]);
  const ch = await s.structure("changes", "files");
  assert.deepEqual(ch.data, { since: "abc", scope: "files", changed_files: ["src/a.ts"] });

  const broken = createCodeSearcher({ repoDir: dir, index: cfg, openCbm: () => Promise.resolve({ ...graph, architecture: () => Promise.reject(new Error("pipe closed")) } as unknown as CodeSearchEngine) });
  const failed = await broken.structure("architecture");
  assert.equal(failed.available, false);
  assert.match(failed.note ?? "", /pipe closed/);

  const down = createCodeSearcher({ repoDir: dir, index: cfg, openCbm: () => Promise.reject(new Error("binary missing")) });
  const unavailable = await down.structure("changes");
  assert.equal(unavailable.available, false);
  assert.match(unavailable.note ?? "", /not available.*binary missing/);
});
