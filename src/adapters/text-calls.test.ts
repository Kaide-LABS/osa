// Contract tests for the text-call seam on all three adapters, plus the production TextCall wiring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_REGISTRY } from "./registry.ts";
import { makeTextCall } from "../dispatch/text-call.ts";
import { isTextCapable } from "../ports/text-provider.ts";
import type { TextRequest } from "../ports/text-provider.ts";
import { PROVIDER_IDS } from "../domain/run.ts";
import type { RawInvocationResult } from "../domain/run.ts";

const req = (over: Partial<TextRequest> = {}): TextRequest => ({
  prompt: "PROMPT-TEXT",
  cwd: "/repo",
  timeoutMs: 60_000,
  tier: "research-grade",
  webSearch: false,
  modelOverride: null,
  ...over,
});

const raw = (over: Partial<RawInvocationResult> = {}): RawInvocationResult => ({
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  ...over,
});

test("every provider adapter is text-capable", () => {
  for (const id of PROVIDER_IDS) assert.ok(isTextCapable(ADAPTER_REGISTRY[id]), id);
});

test("no text invocation ever grants a write tool, bypasses approvals via --dangerously-skip-permissions, or uses a write sandbox", () => {
  for (const id of PROVIDER_IDS) {
    const a = ADAPTER_REGISTRY[id];
    if (!isTextCapable(a)) continue;
    for (const webSearch of [false, true]) {
      if (webSearch && !a.textCapabilities.webSearch) continue;
      const inv = a.buildTextInvocation(req({ webSearch }));
      const line = [inv.command, ...inv.args].join(" ");
      assert.ok(!/--dangerously-skip-permissions/.test(line), `${id}: ${line}`);
      assert.ok(!/workspace-write|danger-full-access/.test(line), `${id}: ${line}`);
      assert.ok(!/\b(Bash|Edit|Write)\b/.test(line), `${id}: ${line}`);
      assert.equal(inv.cwd, "/repo");
    }
  }
});

test("claude text call: read-only tools; web tools only when asked; prompt on stdin; JSON result extracted", () => {
  const a = ADAPTER_REGISTRY["claude-code"];
  assert.ok(isTextCapable(a));
  const plain = a.buildTextInvocation(req());
  assert.equal(plain.stdin, "PROMPT-TEXT");
  assert.equal(plain.args[plain.args.indexOf("--tools") + 1], "Read,Glob,Grep");
  const web = a.buildTextInvocation(req({ webSearch: true, modelOverride: "m-x" }));
  // Suite 2 / J-08: a web-enabled call gets ONLY the web tools (it used to also get Read,Glob,Grep, which let planted page text
  // read a local file and send it out through a fetch). Contract tightened, not loosened.
  assert.equal(web.args[web.args.indexOf("--tools") + 1], "WebSearch,WebFetch");
  assert.ok(!/Read|Glob|Grep|Bash|Write|Edit/.test(web.args[web.args.indexOf("--tools") + 1] ?? ""));
  assert.equal(web.args[web.args.indexOf("--model") + 1], "m-x");
  assert.deepEqual(a.interpretTextResult(raw({ stdout: JSON.stringify({ type: "result", result: "hello" }) })), { ok: true, text: "hello", failure: null });
  assert.equal(a.interpretTextResult(raw({ stdout: JSON.stringify({ result: "x", is_error: true }) })).ok, false);
  assert.equal(a.interpretTextResult(raw({ exitCode: 1 })).ok, false);
  assert.equal(a.interpretTextResult(raw({ timedOut: true, exitCode: null })).failure?.code, "TURN_TIMEOUT");
});

test("codex text call: read-only sandbox; web_search only when asked; last agent_message is the answer", () => {
  const a = ADAPTER_REGISTRY["codex-cli"];
  assert.ok(isTextCapable(a));
  const plain = a.buildTextInvocation(req());
  assert.equal(plain.args[plain.args.indexOf("--sandbox") + 1], "read-only");
  // Suite 5 / J-09: a call that did not ask for the web says so EXPLICITLY (Codex otherwise gives it web access by default).
  assert.ok(plain.args.includes('web_search="disabled"') && !plain.args.includes('web_search="live"'));
  assert.ok(a.buildTextInvocation(req({ webSearch: true })).args.includes('web_search="live"'));
  const stdout = [
    JSON.stringify({ type: "thread.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: "ignored" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final answer" } }),
  ].join("\n");
  assert.equal(a.interpretTextResult(raw({ stdout })).text, "final answer");
  assert.equal(a.interpretTextResult(raw({ stdout: JSON.stringify({ type: "turn.started" }) })).ok, false);
});

test("antigravity text call: no web search capability, no permission-skip flag, tolerant answer extraction", () => {
  const a = ADAPTER_REGISTRY["antigravity-cli"];
  assert.ok(isTextCapable(a));
  assert.equal(a.textCapabilities.webSearch, false);
  const inv = a.buildTextInvocation(req());
  assert.ok(inv.args.includes("--print="));
  assert.ok(inv.stdin?.includes("PROMPT-TEXT"));
  const ok = [JSON.stringify({ event: "init" }), JSON.stringify({ event: "result", status: "SUCCESS", result: "agy says hi" })].join("\n");
  assert.equal(a.interpretTextResult(raw({ stdout: ok })).text, "agy says hi");
  const viaMessages = [
    JSON.stringify({ event: "assistant", message: { content: "part one " } }),
    JSON.stringify({ event: "assistant", message: { content: "part two" } }),
    JSON.stringify({ event: "result", status: "SUCCESS" }),
  ].join("\n");
  assert.equal(a.interpretTextResult(raw({ stdout: viaMessages })).text, "part one part two");
  assert.equal(a.interpretTextResult(raw({ stdout: JSON.stringify({ event: "result", status: "SUCCESS" }) })).ok, false);
});

test("makeTextCall: spawns the built invocation with the merged env, interprets, and logs text_call", async () => {
  const calls: { command: string; stdin?: string | null | undefined; timeoutMs: number }[] = [];
  const { MemoryEventSink } = await import("../osa/events.ts");
  const events = new MemoryEventSink();
  const call = makeTextCall({
    events,
    runProcessFn: (o) => {
      calls.push({ command: o.command, stdin: o.stdin, timeoutMs: o.timeoutMs });
      return Promise.resolve(raw({ stdout: JSON.stringify({ result: "pong" }) }));
    },
  });
  const r = await call("claude-code", req({ timeoutMs: 1234 }), "unit-test");
  assert.equal(r.outcome.text, "pong");
  assert.equal(calls[0]?.command, "claude");
  assert.equal(calls[0]?.stdin, "PROMPT-TEXT");
  assert.equal(calls[0]?.timeoutMs, 1234);
  assert.equal(events.events[0]?.event, "text_call");
  assert.equal(events.events[0]?.data["purpose"], "unit-test");
});

test("makeTextCall refuses a web-search request on a provider without web search, without spawning anything", async () => {
  let spawned = false;
  const call = makeTextCall({ runProcessFn: () => { spawned = true; return Promise.resolve(raw()); } });
  const r = await call("antigravity-cli", req({ webSearch: true }), "research");
  assert.equal(r.outcome.ok, false);
  assert.match(r.outcome.failure?.message ?? "", /no built-in web search/);
  assert.equal(spawned, false);
});
