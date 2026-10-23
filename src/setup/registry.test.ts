// Implements PHASE_9_SPEC.md §1.5
// Covers buildMcpAddArgs/buildMcpGetArgs (pure argv, FM-I3/FM-I5), interpretMcpGetResult/
// interpretMcpAddResult, and decideServerOutcome's totality table (AC-D1). The optional-research-server
// probe/note tests were removed with the servers (OSA WS3, docs/osa/CONFLICTS.md C-09).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { RawInvocationResult } from "../domain/run.ts";
import type { OptionalServerState, SetupServerId } from "../domain/setup.ts";
import { SETUP_SERVER_IDS, SETUP_OUTCOMES } from "../domain/setup.ts";
import { SETUP_SERVERS, resolveServerLaunch } from "./servers.ts";
import type { LauncherProbeFacts } from "./servers.ts";
import {
  MCP_ADD_ALREADY_EXISTS_MARKER,
  buildMcpAddArgs,
  buildMcpGetArgs,
  decideServerOutcome,
  interpretMcpAddResult,
  interpretMcpGetResult,
} from "./registry.ts";

function fakeResult(overrides: Partial<RawInvocationResult> = {}): RawInvocationResult {
  return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...overrides };
}

// ---------------------------------------------------------------------------------------------
// buildMcpAddArgs / buildMcpGetArgs
// ---------------------------------------------------------------------------------------------

test("buildMcpAddArgs emits the exact fixed argv shape, --scope user unconditionally", () => {
  const args = buildMcpAddArgs("osa", { kind: "node", command: "node", args: ["/x/main.js", "mcp"] });
  assert.deepStrictEqual(args, ["mcp", "add", "--scope", "user", "--transport", "stdio", "osa", "--", "node", "/x/main.js", "mcp"]);
});

test("buildMcpGetArgs emits exactly ['mcp', 'get', name]", () => {
  assert.deepStrictEqual(buildMcpGetArgs("osa"), ["mcp", "get", "osa"]);
});

const FORBIDDEN_TOKENS = ["http", "sse", "--transport http", "--transport sse", "--header", "--client-id", "--client-secret", "--callback-port", "-e", "--env", "login", "logout", "://"];

test("FM-I5: every (server, LaunchResolution) argv the catalog can produce contains none of the forbidden tokens", () => {
  const facts: LauncherProbeFacts = { platform: "linux", nodeOnPath: true, nodeExecPath: "/usr/bin/node" };
  const factsVariants: LauncherProbeFacts[] = [facts, { ...facts, nodeOnPath: false }];
  for (const f of factsVariants) {
    for (const def of SETUP_SERVERS) {
      const resolution = resolveServerLaunch(def, f, "/home/op/osa/dist/cli/main.js");
      if (resolution.kind !== "resolved") continue;
      const addArgs = buildMcpAddArgs(def.id, resolution.launch).join(" ");
      const getArgs = buildMcpGetArgs(def.id).join(" ");
      for (const token of FORBIDDEN_TOKENS) {
        assert.ok(!addArgs.includes(token), `add argv "${addArgs}" must not contain "${token}"`);
        assert.ok(!getArgs.includes(token), `get argv "${getArgs}" must not contain "${token}"`);
      }
      assert.deepStrictEqual(addArgs.split(" ").slice(0, 6), ["mcp", "add", "--scope", "user", "--transport", "stdio"]);
    }
  }
});

test("FM-I3: buildMcpAddArgs takes no scope parameter and never emits local/project", () => {
  for (const id of SETUP_SERVER_IDS) {
    const args = buildMcpAddArgs(id, { kind: "node", command: "node", args: [] });
    assert.ok(!args.includes("local"));
    assert.ok(!args.includes("project"));
  }
});

// ---------------------------------------------------------------------------------------------
// interpretMcpGetResult / interpretMcpAddResult
// ---------------------------------------------------------------------------------------------

test("interpretMcpGetResult: exit 0 -> present, exit 1 -> absent, timeout/other -> indeterminate", () => {
  assert.equal(interpretMcpGetResult(fakeResult({ exitCode: 0 })), "present");
  assert.equal(interpretMcpGetResult(fakeResult({ exitCode: 1 })), "absent");
  assert.equal(interpretMcpGetResult(fakeResult({ timedOut: true })), "indeterminate");
  assert.equal(interpretMcpGetResult(fakeResult({ exitCode: 2 })), "indeterminate");
  assert.equal(interpretMcpGetResult(fakeResult({ exitCode: null })), "indeterminate");
});

test("interpretMcpAddResult: exit 0 -> ok, timeout -> indeterminate, non-zero with the marker -> already-exists, otherwise -> failed", () => {
  assert.equal(interpretMcpAddResult(fakeResult({ exitCode: 0 })), "ok");
  assert.equal(interpretMcpAddResult(fakeResult({ timedOut: true })), "indeterminate");
  assert.equal(interpretMcpAddResult(fakeResult({ exitCode: 1 })), "failed");
  assert.equal(interpretMcpAddResult(fakeResult({ exitCode: null })), "failed");
  assert.equal(interpretMcpAddResult(fakeResult({ exitCode: 1, stderr: "MCP server OSA already exists in user config" })), "already-exists");
  assert.equal(interpretMcpAddResult(fakeResult({ exitCode: 1, stderr: MCP_ADD_ALREADY_EXISTS_MARKER })), "already-exists");
});

test("regression: a genuine non-duplicate add failure (verified live against the real CLI) is 'failed', not 'already-exists' -- exit code alone is not a safe signal", () => {
  // Verified live: `claude mcp add --scope user "bad name" -- node x.js` and
  // `claude mcp add --scope user emptycmdtest --` both exit 1 with stderr that does NOT contain
  // "already exists in user config".
  assert.equal(interpretMcpAddResult(fakeResult({ exitCode: 1, stderr: "Invalid name bad name. Names can only contain letters, numbers, hyphens, and underscores." })), "failed");
  assert.equal(interpretMcpAddResult(fakeResult({ exitCode: 1, stderr: "error: missing required argument 'commandOrUrl'" })), "failed");
});

// ---------------------------------------------------------------------------------------------
// decideServerOutcome -- AC-D1 totality table
// ---------------------------------------------------------------------------------------------

test("AC-D1: decideServerOutcome's minimum-required table rows all hold", () => {
  assert.equal(decideServerOutcome("already-exists", "not-attempted"), "already-registered");
  assert.equal(decideServerOutcome("ok", "present"), "registered");
  assert.equal(decideServerOutcome("ok", "absent"), "registered-unverified");
  assert.equal(decideServerOutcome("ok", "indeterminate"), "registered-unverified");
  assert.equal(decideServerOutcome("failed", "not-attempted"), "failed");
  assert.equal(decideServerOutcome("indeterminate", "not-attempted"), "indeterminate");
});

test("decideServerOutcome is total over every reachable (add, post) combination and always returns a valid SetupOutcome", () => {
  const addValues: Array<"ok" | "already-exists" | "failed" | "indeterminate"> = ["ok", "already-exists", "failed", "indeterminate"];
  const postValues: Array<OptionalServerState | "not-attempted"> = ["present", "absent", "indeterminate", "not-attempted"];
  for (const add of addValues) {
    for (const post of postValues) {
      const outcome = decideServerOutcome(add, post);
      assert.ok((SETUP_OUTCOMES as readonly string[]).includes(outcome), `unexpected outcome ${outcome} for (${add},${post})`);
    }
  }
});

test("FM-I1: registered and registered-unverified are genuinely distinct outcomes", () => {
  const registered = decideServerOutcome("ok", "present");
  const unverified = decideServerOutcome("ok", "absent");
  assert.equal(registered, "registered");
  assert.equal(unverified, "registered-unverified");
  assert.notEqual(registered, unverified);
});

// ---------------------------------------------------------------------------------------------
// probeOptionalResearchServers / renderOptionalResearchNote
// ---------------------------------------------------------------------------------------------
