import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GrepEngine, LexicalEngine, SNIPPET_LINES, parseGrepLines, rangesOverlap, readLiveSnippet, safeRelPath } from "./engine.ts";
import { clearSearchCache } from "./search.ts";

async function tree() {
  const dir = await mkdtemp(`${tmpdir()}/osa-engine-`);
  await mkdir(`${dir}/src`, { recursive: true });
  const body = (n: number): string => Array.from({ length: n }, (_, i) => `// filler line ${String(i)}`).join("\n");
  await writeFile(`${dir}/src/lock.ts`, `${body(5)}\nexport function lockNow(prd: string) {\n  return hashPrd(prd);\n}\n${body(20)}\n`, "utf8");
  await writeFile(`${dir}/src/pipeline.ts`, `import { lockNow } from "./lock.ts";\nexport function run() { lockNow("a"); lockNow("b"); lockNow("c"); }\n`, "utf8");
  await writeFile(`${dir}/src/lock.test.ts`, `import { lockNow } from "./lock.ts";\ntest("lockNow", () => { lockNow("x"); lockNow("y"); lockNow("z"); lockNow("w"); });\n`, "utf8");
  await writeFile(`${dir}/README.md`, "The locking of a PRD is done by lockNow, see notes on lock and hash.\n", "utf8");
  return dir;
}

test("rangesOverlap: inclusive ranges", () => {
  assert.equal(rangesOverlap({ startLine: 1, endLine: 5 }, { startLine: 5, endLine: 9 }), true);
  assert.equal(rangesOverlap({ startLine: 1, endLine: 4 }, { startLine: 5, endLine: 9 }), false);
});

test("safeRelPath: only clean repo-relative POSIX paths survive (no traversal, no absolute paths, no drive letters)", () => {
  assert.equal(safeRelPath("src/a.ts"), "src/a.ts");
  assert.equal(safeRelPath("./src/a.ts"), "src/a.ts");
  assert.equal(safeRelPath(["src", "a.ts"].join(String.fromCharCode(92))), "src/a.ts");
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x/y.ts", "", "C:" + String.fromCharCode(92) + "x"]) assert.equal(safeRelPath(bad), null, bad);
});

test("readLiveSnippet reads the LIVE file, caps the lines, and refuses a missing file, an out-of-range start and a traversal", async () => {
  const dir = await tree();
  const s = await readLiveSnippet(dir, "src/lock.ts", 6, 30);
  assert.ok(s !== null);
  assert.equal(s.snippet.split("\n").length, SNIPPET_LINES);
  assert.match(s.snippet, /^export function lockNow/);
  assert.equal(await readLiveSnippet(dir, "src/nope.ts", 1, 5), null);
  assert.equal(await readLiveSnippet(dir, "src/lock.ts", 9999, 10000), null);
  assert.equal(await readLiveSnippet(dir, "../outside.txt", 1, 2), null);
  await writeFile(`${dir}/src/lock.ts`, "changed\n", "utf8");
  assert.equal((await readLiveSnippet(dir, "src/lock.ts", 1, 1))?.snippet, "changed", "always the current content");
});

test("parseGrepLines reads path:line:text rows", () => {
  assert.deepEqual(parseGrepLines("src/a.ts:12:export function x() {}\nREADME.md:3:text with: colons\nbad row\n"), [{ file: "src/a.ts", line: 12 }, { file: "README.md", line: 3 }]);
});

test("GrepEngine: for a question naming an identifier, the DEFINITION file comes before files that merely use it a lot", async () => {
  const dir = await tree();
  const a = await new GrepEngine(dir).search("where is lockNow defined", { k: 5 });
  assert.equal(a.engine, "grep");
  assert.equal(a.confidence, "unassessed");
  assert.equal(a.hits[0]?.path, "src/lock.ts");
  assert.equal(a.hits[0]?.startLine, 6);
  assert.match(a.hits[0]?.snippet ?? "", /export function lockNow/);
  assert.ok(!a.hits.slice(0, 1).some((h) => h.path.endsWith(".test.ts")), "a test is not the definition");
});

test("GrepEngine without an identifier ranks files by how many of the question's words they contain; nothing found is an empty answer, not an error", async () => {
  const dir = await tree();
  const a = await new GrepEngine(dir).search("locking notes hash", { k: 3 });
  assert.equal(a.hits[0]?.path, "README.md");
  const none = await new GrepEngine(dir).search("zzzzqqqq wwwwxxxx", { k: 3 });
  assert.deepEqual(none.hits, []);
  assert.equal(none.abstained, false);
});

test("LexicalEngine wraps OSA's index: finds the definition, reports 'unassessed', refreshes on search and again after an edit", async () => {
  const dir = await tree();
  clearSearchCache();
  const e = new LexicalEngine(dir);
  const a = await e.search("lockNow", { k: 5 });
  assert.equal(a.engine, "lexical");
  assert.equal(a.confidence, "unassessed");
  assert.ok(a.hits.some((h) => h.path === "src/lock.ts"));
  await writeFile(`${dir}/src/extra.ts`, "export function brandNewZqfunction() { return 1; }\n", "utf8");
  assert.ok((await e.search("brandNewZqfunction", { k: 3 })).hits.some((h) => h.path === "src/extra.ts"), "the edit is visible to the very next search");
  await e.close();
});

// ---- REGRESSION: the search cache was keyed by mtime alone -----------------------------------------------------------------------
// Two index updates inside one filesystem timestamp tick (~16 ms on Windows) gave identical mtimes, so a search right after an edit could be
// answered from the in-memory copy of the PREVIOUS index: a stale read. Found while testing "an edit is visible to the very next search".

import { readdir, stat, utimes } from "node:fs/promises";
import { updateIndex } from "./indexer.ts";
import { indexStamp } from "./store.ts";

async function pinMtimes(dir: string, when: Date): Promise<void> {
  for (const f of await readdir(`${dir}/.osa/index`)) await utimes(`${dir}/.osa/index/${f}`, when, when);
}

test("REGRESSION: an index update that lands with the SAME mtime as the previous one (same timestamp tick) is still seen by the next search (size differs)", async () => {
  const dir = await tree();
  clearSearchCache();
  await updateIndex({ repoDir: dir });
  const when = new Date("2026-01-01T00:00:00Z");
  await pinMtimes(dir, when);
  const e = new LexicalEngine(dir, { refreshOnSearch: false });
  assert.ok((await e.search("lockNow", { k: 3 })).hits.length > 0, "loads and caches the current index");
  await writeFile(`${dir}/src/extra.ts`, "export function brandNewZqfunction() { return 1; }\n", "utf8");
  await updateIndex({ repoDir: dir });
  await pinMtimes(dir, when); // simulate: both writes fell in the same tick
  assert.ok((await e.search("brandNewZqfunction", { k: 3 })).hits.some((h) => h.path === "src/extra.ts"), "the new file is searchable");
});

test("REGRESSION: the stamp also changes when an update leaves BOTH mtime and size unchanged (a same-length edit in the same tick)", async () => {
  const dir = await tree();
  await writeFile(`${dir}/src/word.ts`, "export const w = 'AAAA';\n", "utf8");
  await updateIndex({ repoDir: dir });
  const when = new Date("2026-01-01T00:00:00Z");
  await pinMtimes(dir, when);
  const before = await indexStamp(dir);
  await writeFile(`${dir}/src/word.ts`, "export const w = 'BBBB';\n", "utf8");
  await utimes(`${dir}/src/word.ts`, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  await updateIndex({ repoDir: dir });
  await pinMtimes(dir, when);
  const sizes = await Promise.all(["meta.json", "chunks.jsonl"].map(async (f) => (await stat(`${dir}/.osa/index/${f}`)).size));
  assert.ok(sizes.every((n) => n > 0));
  assert.notEqual(await indexStamp(dir), before, "an in-process write always bumps the stamp");
});
