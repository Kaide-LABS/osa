// The query rewrite hook of the CBM engine, against the fake codebase-memory-mcp server: what the engine ASKS CBM, with and without a rewrite.

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempGitRepo } from "../../osa/fixtures.test.ts";
import { startLongLived } from "../../util/exec.ts";
import { LexicalEngine } from "../engine.ts";
import type { Rewriter } from "../rewrite.ts";
import { CbmEngine } from "./engine.ts";
import { CbmSession } from "./session.ts";

const FAKE = fileURLToPath(new URL("../../../scripts/fake-cbm-server.mjs", import.meta.url));
const TABLE = { cols: ["qn", "label", "file", "lines", "rank"], rows: [["proj.a.foo", "Function", "a.ts", "1-3", -1]] };
const SCENARIO = {
  tools: {
    index_repository: { structured: { project: "proj", nodes: 1, edges: 0 } },
    search_graph: { structured: TABLE },
    search_code: { structured: TABLE },
    trace_path: { structured: { callers: { groups: [] } } },
  },
};

interface Call {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

async function openEngine(rewrite: Rewriter | undefined): Promise<{ engine: CbmEngine; calls: () => Promise<Call[]> }> {
  const repoDir = await tempGitRepo();
  await writeFile(`${repoDir}/a.ts`, "export function foo() {\n  return 1;\n}\n", "utf8");
  const workDir = await mkdtemp(`${tmpdir()}/osa-cbmrw-`);
  const log = `${workDir}/requests.jsonl`;
  const paths = { binaryPath: "unused", workDir };
  const session = await CbmSession.open(paths, {
    startFn: (o) => startLongLived({ ...o, command: process.execPath, args: [FAKE], env: { ...(o.env ?? {}), FAKE_CBM_SCENARIO: JSON.stringify(SCENARIO), FAKE_CBM_LOG: log } }),
  });
  const engine = await CbmEngine.open({
    repoDir,
    paths,
    session,
    lexical: new LexicalEngine(repoDir),
    guard: false,
    channels: { bm25: true, code: true, semantic: false, lexical: false, trace: true },
    ...(rewrite !== undefined ? { rewrite } : {}),
  });
  const calls = async (): Promise<Call[]> =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { method: string; params: { name?: string; arguments?: Record<string, unknown> } | null })
      .filter((m) => m.method === "tools/call")
      .map((m) => ({ tool: String(m.params?.name), args: m.params?.arguments ?? {} }));
  return { engine, calls };
}

const QUESTION = "which function stops a command from silently doing nothing when it was launched through a symbolic link?";

test("without a rewrite the engine asks CBM about the question's own words only (unchanged behaviour)", async () => {
  const { engine, calls } = await openEngine(undefined);
  try {
    const answer = await engine.search(QUESTION, { k: 3 });
    assert.equal(answer.hits[0]?.path, "a.ts");
    const all = (await calls()).filter((c) => c.tool === "search_code" || c.tool === "search_graph");
    const patterns = all.filter((c) => c.tool === "search_code").map((c) => String(c.args["pattern"]));
    assert.ok(patterns.length >= 1 && patterns.length <= 4, "at most 4 text-search patterns, as before");
    assert.ok(!patterns.includes("realpathSync"));
    assert.equal(all.find((c) => c.tool === "search_graph")?.args["query"], QUESTION);
  } finally {
    await engine.close();
  }
});

test("with a rewrite the rewrite's identifiers and keywords are searched FIRST and the question is still searched; BM25 gets the question plus the rewrite", async () => {
  const seen: string[] = [];
  const rewrite: Rewriter = (q) => {
    seen.push(q);
    return Promise.resolve({ identifiers: ["realpathSync", "isEntryPoint"], keywords: ["symlink", "argv"] });
  };
  const { engine, calls } = await openEngine(rewrite);
  try {
    const answer = await engine.search(QUESTION, { k: 3 });
    assert.deepEqual(seen, [QUESTION], "the rewriter is asked once, with the question as written");
    assert.equal(answer.hits[0]?.path, "a.ts");
    const all = await calls();
    const patterns = all.filter((c) => c.tool === "search_code").map((c) => String(c.args["pattern"]));
    assert.deepEqual(patterns.slice(0, 4), ["realpathSync", "isEntryPoint", "symlink", "argv"], "rewrite terms lead");
    assert.ok(patterns.length <= 8, "no more than 8 text-search patterns");
    assert.ok(patterns.length > 4, "the question's own words follow the rewrite's");
    const bm25 = String(all.find((c) => c.tool === "search_graph")?.args["query"]);
    assert.ok(bm25.startsWith(QUESTION), "BM25 still gets the question");
    assert.ok(bm25.includes("realpathSync") && bm25.includes("symlink"), "and the rewrite's terms");
  } finally {
    await engine.close();
  }
});

test("a call-path question traces the identifier the person WROTE, not the rewrite's first guess", async () => {
  const { engine, calls } = await openEngine(() => Promise.resolve({ identifiers: ["somethingElseEntirely"], keywords: [] }));
  try {
    await engine.search("what calls planSeats?", { k: 3 });
    const trace = (await calls()).find((c) => c.tool === "trace_path");
    assert.equal(trace?.args["function_name"], "planSeats");
  } finally {
    await engine.close();
  }
});

test("a rewriter that returns nothing or fails leaves the search exactly as it was", async () => {
  for (const rewrite of [(): Promise<null> => Promise.resolve(null), (): Promise<null> => Promise.reject(new Error("model down"))] as Rewriter[]) {
    const { engine, calls } = await openEngine(rewrite);
    try {
      const answer = await engine.search(QUESTION, { k: 3 });
      assert.equal(answer.hits[0]?.path, "a.ts");
      assert.equal((await calls()).find((c) => c.tool === "search_graph")?.args["query"], QUESTION);
    } finally {
      await engine.close();
    }
  }
});
