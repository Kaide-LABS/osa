import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { startLongLived } from "../../util/exec.ts";
import { CbmSession, CbmSessionError, cbmEnvironment } from "./session.ts";

const FAKE = new URL("../../../scripts/fake-cbm-server.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** A startFn that runs the fake server instead of the real binary, with a scenario and an optional request log. */
function fakeStart(scenario: object, logPath?: string): typeof startLongLived {
  return (o) => startLongLived({ ...o, command: process.execPath, args: [FAKE], env: { ...(o.env ?? {}), FAKE_CBM_SCENARIO: JSON.stringify(scenario), ...(logPath !== undefined ? { FAKE_CBM_LOG: logPath } : {}) } });
}
// The session starts its process in workDir, which must exist: a real temporary directory, not a path that only exists on one machine.
const paths = { binaryPath: "unused-the-fake-server-replaces-it", workDir: await mkdtemp(`${tmpdir()}/osa-cbmwork-`) };

test("cbmEnvironment: private cache, runtime and allowed-root directories under workDir, a quiet log level, and the caller's other variables kept", () => {
  const BS = String.fromCharCode(92);
  const env = cbmEnvironment({ binaryPath: "b", workDir: `C:${BS}osa-cbm${BS}` }, { PATH: "p", KEEP: "1", GONE: undefined });
  assert.equal(env["CBM_CACHE_DIR"], "C:/osa-cbm/cache");
  assert.equal(env["CBM_RUNTIME_DIR"], "C:/osa-cbm/run");
  assert.equal(env["CBM_ALLOWED_ROOT"], "C:/osa-cbm/shadow");
  assert.equal(env["CBM_LOG_LEVEL"], "warn");
  assert.equal(env["KEEP"], "1");
  assert.ok(!("GONE" in env));
});

test("open performs the handshake and reports the server version; call returns text, structured content and the error flag", async () => {
  const log = `${await mkdtemp(`${tmpdir()}/osa-fakecbm-`)}/requests.jsonl`;
  const s = await CbmSession.open(paths, { startFn: fakeStart({ version: "9.9.9", tools: { search_graph: { structured: { rows: [["a", "Function", "x.ts", "1-2"]] } }, boom: { isError: true, text: "project not found" } } }, log) });
  assert.equal(s.serverVersion, "9.9.9");
  const ok = await s.call("search_graph", { project: "p", query: "q" });
  assert.equal(ok.isError, false);
  assert.deepEqual((ok.structured as { rows: unknown[] }).rows[0], ["a", "Function", "x.ts", "1-2"]);
  const err = await s.call("boom", {});
  assert.equal(err.isError, true);
  assert.match(err.text, /project not found/);
  await s.close();
  const sent = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { method: string; params: { name?: string; arguments?: Record<string, unknown> } | null });
  assert.deepEqual(sent.map((m) => m.method), ["initialize", "notifications/initialized", "tools/call", "tools/call"]);
  assert.deepEqual(sent[2]?.params, { name: "search_graph", arguments: { project: "p", query: "q" } });
});

test("a tool the server does not know is a CbmSessionError (protocol error), not a result", async () => {
  const s = await CbmSession.open(paths, { startFn: fakeStart({ tools: {} }) });
  await assert.rejects(s.call("nope", {}), (e: unknown) => e instanceof CbmSessionError && /unknown tool nope/.test(e.message));
  await s.close();
});

test("a request that is never answered times out with a clear message; the session is still closable", async () => {
  const s = await CbmSession.open(paths, { startFn: fakeStart({ tools: { slow: { hang: true } } }) });
  await assert.rejects(s.call("slow", {}, 300), /did not answer tools\/call within/);
  await s.close();
  assert.equal(s.alive, false);
});

test("a server that dies mid-session rejects the pending request with its exit code, and later calls fail fast", async () => {
  const s = await CbmSession.open(paths, { startFn: fakeStart({ dieAfter: 1, tools: { t: { structured: {} } } }) });
  await s.call("t", {});
  await assert.rejects(s.call("t", {}), (e: unknown) => e instanceof CbmSessionError && /exited \(code 3/.test(e.message));
  await assert.rejects(s.call("t", {}), CbmSessionError);
  await s.close();
});

test("a binary that does not exist fails open() with a CbmSessionError, never a throw of another kind and never a shell", async () => {
  await assert.rejects(CbmSession.open({ binaryPath: "osa-no-such-binary", workDir: "." }), (e: unknown) => e instanceof CbmSessionError);
});

test("a handshake that takes too long is a CbmSessionError", async () => {
  await assert.rejects(CbmSession.open(paths, { startFn: fakeStart({ initDelayMs: 2000 }), handshakeMs: 200 }), /did not answer initialize/);
});

test("close() is idempotent and ends the child", async () => {
  const s = await CbmSession.open(paths, { startFn: fakeStart({}) });
  await s.close();
  await s.close();
  assert.equal(s.alive, false);
});
