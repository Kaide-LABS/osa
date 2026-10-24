// The code index's user-facing surfaces: the `code_search` MCP tool, the `osa index` / `osa search` commands, and the
// pipeline's injection of "where to look first" into the build agents' context.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { UsageError } from "../domain/errors.ts";
import { parseArgs } from "../cli/main.ts";
import { runIndexCommand, runSearchCommand } from "../cli/index-cmd.ts";
import { buildMcpServer } from "../mcp/server.ts";
import { CodeSearchToolInput, CodeSearchToolOutput, runCodeSearch } from "../mcp/tools/code-search.ts";
import { tempGitRepo } from "../osa/fixtures.test.ts";

async function repoWithCode(): Promise<string> {
  const repoDir = await tempGitRepo();
  await mkdir(`${repoDir}/src`, { recursive: true });
  await writeFile(`${repoDir}/src/session.ts`, "export function verifySessionToken(token: string): boolean {\n  return activeSessions.has(token);\n}\n\nexport function revokeSession(token: string): void {\n  activeSessions.delete(token);\n}\n", "utf8");
  await writeFile(`${repoDir}/src/invoice.ts`, "export function invoiceTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n", "utf8");
  return repoDir;
}

const argv = (...a: string[]): string[] => ["node", "osa", ...a];

test("code_search tool: input validation, defaults, and a search that refreshes the index first", async () => {
  assert.equal(CodeSearchToolInput.parse({ repo_dir: "/r", query: "q" }).k, 8);
  assert.equal(CodeSearchToolInput.parse({ repo_dir: "/r", query: "q" }).refresh, true);
  assert.equal(CodeSearchToolInput.safeParse({ repo_dir: "/r", query: "" }).success, false);
  assert.equal(CodeSearchToolInput.safeParse({ repo_dir: "/r", query: "q", k: 51 }).success, false);
  assert.equal(CodeSearchToolInput.safeParse({ repo_dir: "/r", query: "q", extra: 1 }).success, false);

  const repoDir = await repoWithCode();
  const out = await runCodeSearch({ repo_dir: repoDir, query: "where is the session token verified", k: 3, refresh: true });
  assert.equal(out.hits[0]?.path, "src/session.ts");
  assert.equal(out.hits[0]?.symbol, "verifySessionToken");
  assert.ok((out.index?.files ?? 0) >= 3);
  CodeSearchToolOutput.parse(out);

  const noRefresh = await runCodeSearch({ repo_dir: repoDir, query: "invoice total", k: 3, refresh: false });
  assert.equal(noRefresh.index, null);
  assert.equal(noRefresh.hits[0]?.path, "src/invoice.ts");
});

test("code_search over a real MCP client/server round trip returns structured content", async () => {
  const repoDir = await repoWithCode();
  const server = buildMcpServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["code_search", "doctor", "drive", "evidence", "memory_append", "memory_read", "memory_save", "memory_search", "osa_build", "osa_plan", "osa_spec", "osa_status", "run"]);
    const res = await client.callTool({ name: "code_search", arguments: { repo_dir: repoDir, query: "revoke a session", k: 2 } });
    assert.ok(res.isError !== true);
    const structured = CodeSearchToolOutput.parse(res.structuredContent);
    assert.equal(structured.hits[0]?.symbol, "revokeSession");
    const bad = await client.callTool({ name: "code_search", arguments: { repo_dir: `${repoDir}/missing-dir`, query: "x" } });
    assert.ok(bad.isError === true || (bad.structuredContent as { hits?: unknown[] } | undefined)?.hits?.length === 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("osa index / osa search: parsing, output and exit codes", async () => {
  const idx = parseArgs(argv("index", "--repo-dir", ".", "--json"));
  assert.equal(idx.kind, "index");
  const s = parseArgs(argv("search", "where", "is", "the", "token", "-k", "5", "--no-refresh"));
  assert.equal(s.kind, "search");
  if (s.kind === "search") assert.deepEqual([s.query, s.k, s.refresh], ["where is the token", 5, false]);
  assert.throws(() => parseArgs(argv("search")), UsageError);
  assert.throws(() => parseArgs(argv("search", "q", "-k", "0")), UsageError);
  assert.throws(() => parseArgs(argv("search", "q", "--bogus")), UsageError);
  assert.throws(() => parseArgs(argv("index", "--bogus")), UsageError);

  const repoDir = await repoWithCode();
  const built = await runIndexCommand({ repoDir, json: false });
  assert.match(built.text, /^osa index -- \d+ file\(s\), \d+ chunk\(s\) \(full build\)/);
  const again = await runIndexCommand({ repoDir, json: false });
  assert.match(again.text, /0 added, 0 changed, 0 removed, \d+ unchanged/);
  const found = await runSearchCommand({ repoDir, query: "verify the session token", k: 3, json: false, refresh: true });
  assert.match(found.text, /`src\/session\.ts:1-3` \(verifySessionToken\)/);
  const json = await runSearchCommand({ repoDir, query: "verify the session token", k: 1, json: true, refresh: false });
  assert.equal((JSON.parse(json.text) as { hits: { path: string }[] }).hits[0]?.path, "src/session.ts");
  const none = await runSearchCommand({ repoDir, query: "zzzzqqqq", k: 3, json: false, refresh: false });
  assert.match(none.text, /No matches/);
  assert.equal(none.exitCode, 0);
});

test("pipeline: the build agents' context carries the ranked 'where to look first' hits, the index stays out of git, and index_updated is logged", async () => {
  const { OsaConfig } = await import("../domain/osa-config.ts");
  const { MinIntervalLimiter } = await import("../research/net/http.ts");
  const { NoopTrimmer } = await import("../trim/trimmer.ts");
  const { MemoryEventSink } = await import("../osa/events.ts");
  const { fakeModel, researchFetch } = await import("../osa/fixtures.test.ts");
  const { runOsaCommand } = await import("../osa/pipeline.ts");
  const RUN = "efefefef-efef-4fef-8fef-efefefefefef";
  const repoDir = await repoWithCode();
  execFileSync("git", ["add", "-A"], { cwd: repoDir });
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "code"], { cwd: repoDir });
  const events = new MemoryEventSink(RUN);
  const mk = (config: unknown) => ({
    events,
    io: { show: () => undefined, choose: () => Promise.resolve("lock" as const), edit: () => Promise.resolve() },
    interactive: true,
    runId: RUN,
    config: OsaConfig.parse(config),
    textCall: fakeModel().call,
    research: { http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
    trimmer: { trimmer: new NoopTrimmer("noop"), note: null },
    drive: {
      runDispatchFn: (async (rc: { spec_path: string; phase: number; is_final_phase: boolean }) => {
        const dir = rc.spec_path.slice(0, rc.spec_path.lastIndexOf("/") + 1);
        await writeFile(rc.is_final_phase ? `${repoDir}/BUILD_COMPLETE.md` : `${repoDir}/${dir}PHASE_${String(rc.phase + 1)}_SPEC.md`, "x\n", "utf8");
        return { ok: true, exitCode: 0, turns: [], halt: null, problems: [], warnings: [] };
      }) as never,
    },
  });
  const report = await runOsaCommand({ prompt: "a b", files: [], repoDir, yes: true, json: false }, mk({ agents: { application: false } }));
  assert.equal(report.ok, true, report.problems.join("; "));
  const ctx = await readFile(`${repoDir}/runs/${RUN}/step14/executor-context.md`, "utf8");
  assert.match(ctx, /## Where to look first \(code index\)/);
  assert.match(ctx, /Open these before grepping; grep remains the fallback\./);
  assert.ok(events.names().filter((n) => n === "index_updated").length >= 2, "indexed before the build and again after each phase");
  assert.equal(execFileSync("git", ["status", "--porcelain", "--", ".osa/index"], { cwd: repoDir }).toString().trim(), "");

  const repoDir2 = await repoWithCode();
  const off = await runOsaCommand({ prompt: "a b", files: [], repoDir: repoDir2, yes: true, json: false, build: false }, { ...mk({ index: { enabled: false } }), runId: "11111111-2222-4333-8444-555555555555", events: new MemoryEventSink() });
  assert.equal(off.ok, true);
  await assert.rejects(readFile(`${repoDir2}/.osa/index/meta.json`, "utf8"), "index.enabled=false builds no index");
});

test("code_search tool, view=architecture|changes: with the default (lexical) engine it says plainly that the graph views need index.engine \"cbm\" and returns no hits; the output still validates", async () => {
  const repoDir = await tempGitRepo();
  for (const view of ["architecture", "changes"] as const) {
    const out = await runCodeSearch({ repo_dir: repoDir, query: "unused", view });
    CodeSearchToolOutput.parse(out);
    assert.deepEqual(out.hits, []);
    assert.equal(out.structure?.available, false);
    assert.match(out.structure?.note ?? "", /index\.engine "cbm"/);
    assert.equal(out.engine, "lexical");
  }
});
