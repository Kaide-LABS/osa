// Suite 5/2 regression: a Codex call made by OSA must not inherit the OPERATOR's personal tool plugins. Live-verified on this machine:
// with `web_search="disabled"` a Codex call still looked up a GitHub star count, because the `apps` feature exposes a `codex_apps`
// connector with a web-search tool outside that setting, and the operator's own `node_repl` MCP server (a browser/JS runtime that runs
// outside the read-only sandbox) was loaded too. An OSA "no web" call has to be genuinely offline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { codexIsolationArgs, isolateInvocation, parseMcpServerNames, readCodexMcpServerNames } from "./provider-isolation.ts";
import { makeTextCall } from "./text-call.ts";
import type { RawInvocationResult } from "../domain/run.ts";
import type { Invocation } from "../ports/provider-adapter.ts";

const TOML = [
  'model = "gpt-5.5"',
  "[features]",
  "js_repl = false",
  "[mcp_servers.node_repl]",
  "args = []",
  "[mcp_servers.node_repl.env]",
  'CODEX_HOME = "x"',
  "  [mcp_servers.figma]  ",
  'url = "https://example.test/mcp"',
  '[mcp_servers."has space"]',
  "[mcp_servers.a.b]",
  "[projects.'c:\\x']",
].join("\n");

test("parseMcpServerNames: top-level server tables only -- not their sub-tables, quoted or dotted names, or other sections", () => {
  assert.deepEqual(parseMcpServerNames(TOML), ["node_repl", "figma"]);
  assert.deepEqual(parseMcpServerNames(""), []);
  assert.deepEqual(parseMcpServerNames("[mcp_servers.x]\n[mcp_servers.x]\n"), ["x"], "duplicates collapse");
});

test("codexIsolationArgs: disables the apps feature and every named MCP server", () => {
  assert.deepEqual(codexIsolationArgs(["node_repl", "figma"]), ["--disable", "apps", "-c", "mcp_servers.node_repl.enabled=false", "-c", "mcp_servers.figma.enabled=false"]);
  assert.deepEqual(codexIsolationArgs([]), ["--disable", "apps"]);
});

test("readCodexMcpServerNames reads $CODEX_HOME/config.toml; a missing file means no servers", async () => {
  const home = await mkdtemp(`${tmpdir()}/osa-codex-home-`);
  await writeFile(`${home}/config.toml`, TOML, "utf8");
  assert.deepEqual(await readCodexMcpServerNames({ CODEX_HOME: home }), ["node_repl", "figma"]);
  assert.deepEqual(await readCodexMcpServerNames({ CODEX_HOME: `${home}/nope` }), []);
});

test("isolateInvocation inserts the isolation right after `exec` for Codex, leaves every other provider and non-exec invocation alone", async () => {
  const home = await mkdtemp(`${tmpdir()}/osa-codex-home-`);
  await writeFile(`${home}/config.toml`, TOML, "utf8");
  const inv: Invocation = { command: "codex", args: ["exec", "-c", 'approval_policy="never"', "--json", "-"], env: {}, cwd: "/r", stdin: "p" };
  const out = await isolateInvocation("codex-cli", inv, { CODEX_HOME: home });
  assert.deepEqual(out.args.slice(0, 7), ["exec", "--disable", "apps", "-c", "mcp_servers.node_repl.enabled=false", "-c", "mcp_servers.figma.enabled=false"]);
  assert.deepEqual(out.args.slice(7), ["-c", 'approval_policy="never"', "--json", "-"], "the original arguments follow, untouched and in order");
  assert.deepEqual(await isolateInvocation("claude-code", inv, { CODEX_HOME: home }), inv);
  const odd = { ...inv, args: ["login", "status"] };
  assert.deepEqual(await isolateInvocation("codex-cli", odd, { CODEX_HOME: home }), odd);
});

test("makeTextCall applies the isolation to a Codex call (web or not) and not to a Claude call", async () => {
  const home = await mkdtemp(`${tmpdir()}/osa-codex-home-`);
  await writeFile(`${home}/config.toml`, TOML, "utf8");
  const saved = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = home;
  try {
    const seen: string[][] = [];
    const raw = (stdout: string): RawInvocationResult => ({ exitCode: 0, signal: null, stdout, stderr: "", durationMs: 1, timedOut: false });
    const call = makeTextCall({
      runProcessFn: (o) => {
        seen.push([o.command, ...o.args]);
        return Promise.resolve(raw(o.command === "codex" ? JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }) : JSON.stringify({ type: "result", result: "ok" })));
      },
    });
    const base = { prompt: "P", cwd: process.cwd(), timeoutMs: 1000, tier: "research-grade" as const, modelOverride: null };
    await call("codex-cli", { ...base, webSearch: false }, "spec");
    await call("codex-cli", { ...base, webSearch: true }, "research-crosscheck");
    await call("claude-code", { ...base, webSearch: false }, "spec");
    for (const line of seen.filter((l) => l[0] === "codex")) {
      assert.deepEqual(line.slice(1, 4), ["exec", "--disable", "apps"], line.join(" "));
      assert.ok(line.includes("mcp_servers.node_repl.enabled=false") && line.includes("mcp_servers.figma.enabled=false"));
    }
    const offline = seen.filter((l) => l[0] === "codex")[0] as string[];
    const online = seen.filter((l) => l[0] === "codex")[1] as string[];
    assert.ok(offline.includes('web_search="disabled"') && !offline.includes('web_search="live"'));
    assert.ok(online.includes('web_search="live"'));
    assert.ok(!(seen.find((l) => l[0] === "claude") as string[]).includes("--disable"));
  } finally {
    if (saved === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = saved;
  }
});
