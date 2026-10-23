// Implements PHASE_9_SPEC.md §1.5, §7 FM-I13, §8.2 AC1-b (amended by OSA WS3: the catalog is OSA's own server only)

import { test } from "node:test";
import assert from "node:assert/strict";
import { SETUP_SERVERS, probeLauncherFacts, resolveServerLaunch } from "./servers.ts";
import type { LauncherProbeFacts } from "./servers.ts";
import type { RunProcessOptions } from "../util/exec.ts";
import type { RawInvocationResult } from "../domain/run.ts";

const ENTRY_PATH_POSIX = "/abs/path/to/dist/cli/main.js";
const ENTRY_PATH_WIN = "C:\\Users\\hp\\osa\\dist\\cli\\main.js";

function ok(stdout = ""): RawInvocationResult {
  return { exitCode: 0, signal: null, stdout, stderr: "", durationMs: 1, timedOut: false };
}
function fail(): RawInvocationResult {
  return { exitCode: 1, signal: null, stdout: "", stderr: "not found", durationMs: 1, timedOut: false };
}

function factsWith(overrides: Partial<LauncherProbeFacts>): LauncherProbeFacts {
  return { platform: "linux", nodeOnPath: true, nodeExecPath: "/usr/bin/node", ...overrides };
}

test("SETUP_SERVERS is exactly OSA's own server (the optional arxiv/paper-search servers were removed, CONFLICTS C-09)", () => {
  assert.deepStrictEqual(
    SETUP_SERVERS.map((s) => s.id),
    ["osa"],
  );
  assert.equal(SETUP_SERVERS[0]?.required, true);
  assert.ok(!JSON.stringify(SETUP_SERVERS).includes("arxiv"));
  assert.ok(!JSON.stringify(SETUP_SERVERS).includes("paper-search"));
});

test("probeLauncherFacts records platform and node availability via injected runProcess, and probes nothing else", async () => {
  const calls: RunProcessOptions[] = [];
  const facts = await probeLauncherFacts({
    runProcess: async (o: RunProcessOptions) => {
      calls.push(o);
      return ok();
    },
  });
  assert.equal(facts.nodeOnPath, true);
  assert.equal(typeof facts.nodeExecPath, "string");
  assert.equal(facts.platform, process.platform);
  assert.deepStrictEqual(
    calls.map((c) => [c.command, ...c.args]),
    [["node", "--version"]],
    "no uvx / python probing any more",
  );
});

test("probeLauncherFacts reports nodeOnPath false when the probe fails", async () => {
  const facts = await probeLauncherFacts({ runProcess: async () => fail() });
  assert.equal(facts.nodeOnPath, false);
});

test("resolveServerLaunch for osa prefers PATH-resolved node when available", () => {
  const r = resolveServerLaunch(SETUP_SERVERS[0]!, factsWith({ nodeOnPath: true }), ENTRY_PATH_POSIX);
  assert.deepStrictEqual(r, { kind: "resolved", launch: { kind: "node", command: "node", args: [ENTRY_PATH_POSIX, "mcp"] } });
});

test("resolveServerLaunch for osa falls back to process.execPath when node is not on PATH", () => {
  const r = resolveServerLaunch(SETUP_SERVERS[0]!, factsWith({ nodeOnPath: false, nodeExecPath: "/opt/node/bin/node" }), ENTRY_PATH_POSIX);
  assert.deepStrictEqual(r, { kind: "resolved", launch: { kind: "node", command: "/opt/node/bin/node", args: [ENTRY_PATH_POSIX, "mcp"] } });
});

test("resolveServerLaunch rejects a non-absolute, quote-containing, or backslash-terminated entryPath", () => {
  for (const bad of ["relative/main.js", '/abs/with"quote.js', "C:\\dir\\"]) {
    const r = resolveServerLaunch(SETUP_SERVERS[0]!, factsWith({}), bad);
    assert.equal(r.kind, "unavailable", bad);
    if (r.kind === "unavailable") assert.match(r.remediation, /osa setup/);
  }
});

test("resolveServerLaunch accepts a Windows absolute entry path", () => {
  const r = resolveServerLaunch(SETUP_SERVERS[0]!, factsWith({ platform: "win32" }), ENTRY_PATH_WIN);
  assert.equal(r.kind, "resolved");
});

test("resolveServerLaunch is pure: it never consults process.platform (facts.platform is only carried)", () => {
  const a = resolveServerLaunch(SETUP_SERVERS[0]!, factsWith({ platform: "win32" }), ENTRY_PATH_POSIX);
  const b = resolveServerLaunch(SETUP_SERVERS[0]!, factsWith({ platform: "darwin" }), ENTRY_PATH_POSIX);
  assert.deepStrictEqual(a, b);
});
