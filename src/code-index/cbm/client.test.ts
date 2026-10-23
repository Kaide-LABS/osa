// The client is pinned to payloads captured from the REAL binary (codebase-memory-mcp 0.12.1, 2026-10-17) -- see TEST_REPORT.md Suite 7b.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startLongLived } from "../../util/exec.ts";
import { CbmClient, CbmProtocolError, parseLines, rowsOf } from "./client.ts";
import { CbmSession } from "./session.ts";

const FAKE = new URL("../../../scripts/fake-cbm-server.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const P = "C-Users-hp-OSA";

const BM25 = { cols: ["qn", "label", "file", "lines", "rank"], rows: [[`${P}.src.util.hash.sha256String`, "Function", "src/util/hash.ts", "10-12", -17.62], [`${P}.src.osa.lock.prdLockRecordPath`, "Function", "src/osa/lock.ts", "39-41", -15.54]], total: 926, search_mode: "bm25" };
const SEMANTIC = { groups: [], semantic: { cols: ["qn", "label", "file", "score"], rows: [[`${P}.src.osa.lock.lockNow`, "Function", "src/osa/lock.ts", 0.9666], [`${P}.src.osa.pipeline.counts`, "Function", "src/osa/pipeline.ts", 0.9667]] }, total: 2 };
const CODE = { cols: ["qn", "label", "file", "lines", "matches", "matches_omitted", "in", "out"], rows: [[`${P}.src.osa.lock.assertPrdUnchanged`, "Function", "src/osa/lock.ts", "157-196", [157], 0, 5, 4]], total_results: 9 };
const SNIPPET = { name: "lockNow", qualified_name: `${P}.src.osa.lock.lockNow`, file_path: "C:/Users/hp/OSA/src/osa/lock.ts", start_line: 75, end_line: 87, source: "async function lockNow() {}\n", callers: 1, callees: 3 };
const TRACE = { function: "assertPrdUnchanged", direction: "inbound", callers_total: 3, callers: { cols: ["name", "hop"], groups: [{ qn_prefix: `${P}.src.osa.pipeline`, rows: [["runOsaCommand", 1], ["afterPhase", 1]] }] } };
const OUTLINE = { file_path: "src/osa/lock.ts", cols: ["name", "label", "lines", "qn"], rows: [["lockNow", "Function", "75-87", `${P}.src.osa.lock.lockNow`], ["LockIO", "Interface", "20-25", `${P}.src.osa.lock.LockIO`]] };

async function client(tools: Record<string, unknown>) {
  const s = await CbmSession.open({ binaryPath: "x", workDir: "." }, { startFn: (o) => startLongLived({ ...o, command: process.execPath, args: [FAKE], env: { ...(o.env ?? {}), FAKE_CBM_SCENARIO: JSON.stringify({ tools }) } }) });
  return { c: new CbmClient(s), s };
}

test("parseLines: ranges, single lines and junk", () => {
  assert.deepEqual(parseLines("10-12"), { start: 10, end: 12 });
  assert.deepEqual(parseLines("7"), { start: 7, end: 7 });
  assert.equal(parseLines("x-y"), null);
  assert.equal(parseLines(undefined), null);
});

test("rowsOf: BM25, semantic and code-search tables become rows with the right channel, range, score and degrees", () => {
  const [b] = rowsOf(BM25, "bm25");
  assert.deepEqual([b?.file, b?.startLine, b?.endLine, b?.score, b?.channel], ["src/util/hash.ts", 10, 12, -17.62, "bm25"]);
  const [s] = rowsOf(SEMANTIC.semantic, "semantic");
  assert.deepEqual([s?.file, s?.startLine, s?.score], ["src/osa/lock.ts", null, 0.9666]);
  const [c] = rowsOf(CODE, "code");
  assert.deepEqual([c?.startLine, c?.endLine, c?.matchLines, c?.degreeIn, c?.degreeOut], [157, 196, [157], 5, 4]);
  assert.throws(() => rowsOf({ cols: ["a"], rows: [] }, "bm25"), CbmProtocolError);
});

test("every wrapper sends the right tool and arguments (always format json) and parses the real payload shapes", async () => {
  const { c, s } = await client({
    index_repository: { text: JSON.stringify({ project: P, nodes: 3065, edges: 11208, excluded: { dirs: [".git"] } }) },
    index_status: { structured: { project: P, status: "ready", nodes: 3065, edges: 11208, root_path: "C:/osa-cbm/shadow/x" } },
    search_graph: [{ structured: BM25 }, { structured: SEMANTIC }],
    search_code: { structured: CODE },
    get_code_snippet: { structured: SNIPPET },
    trace_path: { structured: TRACE },
    get_file_outline: { structured: OUTLINE },
    get_architecture: { structured: { total_nodes: 5 } },
    detect_changes: { structured: { changed_total: 2 } },
  });
  assert.deepEqual(await c.index("C:/osa-cbm/shadow/x"), { project: P, nodes: 3065, edges: 11208 });
  assert.deepEqual(await c.status(P), { status: "ready", nodes: 3065, edges: 11208, rootPath: "C:/osa-cbm/shadow/x" });
  assert.equal((await c.bm25(P, "where do we hash the prd")).length, 2);
  assert.equal((await c.semantic(P, ["hash", "prd"]))[0]?.channel, "semantic");
  assert.equal((await c.code(P, "assertPrdUnchanged"))[0]?.startLine, 157);
  assert.deepEqual(await c.snippet(P, `${P}.src.osa.lock.lockNow`), { qn: `${P}.src.osa.lock.lockNow`, file: "C:/Users/hp/OSA/src/osa/lock.ts", startLine: 75, endLine: 87, source: "async function lockNow() {}\n", callers: 1, callees: 3 });
  assert.deepEqual(await c.trace(P, "assertPrdUnchanged"), [{ qn: `${P}.src.osa.pipeline.runOsaCommand`, hop: 1 }, { qn: `${P}.src.osa.pipeline.afterPhase`, hop: 1 }]);
  assert.deepEqual((await c.outline(P, "src/osa/lock.ts")).map((o) => [o.name, o.startLine, o.endLine]), [["lockNow", 75, 87], ["LockIO", 20, 25]]);
  assert.equal((await c.architecture(P))["total_nodes"], 5);
  assert.equal((await c.detectChanges(P, "files"))["changed_total"], 2);
  await s.close();
});

test("tool-level errors: a missing project is 'missing' for status, [] / null for lookups, a CbmProtocolError for searches (never a silent empty answer)", async () => {
  const err = { isError: true, text: JSON.stringify({ error: "project not found or not indexed" }) };
  const { c, s } = await client({ index_status: err, search_graph: err, search_code: err, get_code_snippet: err, trace_path: err, get_file_outline: err, index_repository: err });
  assert.equal((await c.status("nope")).status, "missing");
  await assert.rejects(c.bm25("nope", "q"), CbmProtocolError);
  await assert.rejects(c.semantic("nope", ["q"]), CbmProtocolError);
  await assert.rejects(c.code("nope", "q"), CbmProtocolError);
  await assert.rejects(c.index("C:/outside"), CbmProtocolError);
  assert.equal(await c.snippet("nope", "x"), null);
  assert.deepEqual(await c.trace("nope", "f"), []);
  assert.deepEqual(await c.outline("nope", "f"), []);
  await s.close();
});

test("an unexpected payload shape (e.g. after a CBM upgrade) is a CbmProtocolError, not an empty result", async () => {
  const { c, s } = await client({ search_graph: { structured: { cols: ["something", "else"], rows: [["a", "b"]] } }, index_repository: { text: "not json" } });
  await assert.rejects(c.bm25(P, "q"), CbmProtocolError);
  await assert.rejects(c.index("C:/x"), CbmProtocolError);
  await s.close();
});
