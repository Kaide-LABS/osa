// Suite 6 -- provider failure injection. Every way a provider call can fail must produce (a) a clear plain-language halt reason and
// (b) a correct machine label in the log. Before this, every non-timeout failure was just "<provider> exited N", so a signed-out CLI, a
// missing CLI and a real rate limit were indistinguishable -- and a naive classifier would have called anything containing the word
// "limit" a rate limit. These tests are the "no mislabelled rate limits" proof.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { RawInvocationResult } from "../domain/run.ts";
import { InternalError, TurnTimeoutError } from "../domain/errors.ts";
import { ADAPTER_REGISTRY } from "../adapters/registry.ts";
import { MemoryEventSink } from "../osa/events.ts";
import { isTextCapable } from "../ports/text-provider.ts";
import { classifyFailure, labelFailure } from "./failure-kind.ts";
import { makeTextCall } from "./text-call.ts";

const raw = (over: Partial<RawInvocationResult> = {}): RawInvocationResult => ({ exitCode: 1, signal: null, stdout: "", stderr: "", durationMs: 5, timedOut: false, ...over });

test("TIMEOUT: a timed-out process is a timeout whatever else it printed", () => {
  const c = classifyFailure(raw({ timedOut: true, exitCode: null, stderr: "401 unauthorized rate limit" }));
  assert.equal(c.kind, "timeout");
  assert.match(c.plain, /took too long/i);
});

test("CLI MISSING: ENOENT, 'not recognized', 'command not found' and shell exit codes 127 / 9009 are 'cli_missing' -- never auth, never a rate limit", () => {
  for (const r of [
    raw({ exitCode: null, stderr: "spawn claude ENOENT" }),
    raw({ exitCode: 1, stderr: "'codex' is not recognized as an internal or external command,\r\noperable program or batch file." }),
    raw({ exitCode: 127, stderr: "bash: agy: command not found" }),
    raw({ exitCode: 9009, stderr: "" }),
  ]) {
    const c = classifyFailure(r);
    assert.equal(c.kind, "cli_missing", JSON.stringify(r));
    assert.match(c.plain, /isn't installed|not installed|could not be started/i);
  }
});

test("AUTH: signed-out and bad-credential messages from all three CLIs are 'auth'", () => {
  for (const text of [
    "Invalid API key · Please run /login",
    "Not logged in. Run `claude auth login` first.",
    "ERROR: 401 Unauthorized: Missing bearer or basic authentication in header",
    "Your session has expired. Please sign in again.",
    "authentication required: no credentials found",
    "403 Forbidden: this account does not have access to this model",
  ]) {
    const c = classifyFailure(raw({ stderr: text }));
    assert.equal(c.kind, "auth", text);
    assert.match(c.plain, /sign(ed)? in|signed-in|credentials|access/i);
  }
});

test("RATE LIMIT: real rate-limit / usage-limit / overload messages are 'rate_limit'", () => {
  for (const text of [
    "429 Too Many Requests",
    "API Error: Rate limit reached for requests",
    "You've hit your usage limit. Try again in 4 hours.",
    "Claude AI usage limit reached|1760000000",
    "rate_limit_error: Number of request tokens has exceeded your per-minute rate limit",
    "quota exceeded for this billing period",
    "529 overloaded_error: Overloaded",
  ]) {
    const c = classifyFailure(raw({ stderr: text }));
    assert.equal(c.kind, "rate_limit", text);
    assert.match(c.plain, /limit|busy|overloaded|wait/i);
  }
});

test("NO MISLABELLED RATE LIMITS: other 'limit' / 'too many' / 'exceeded' messages are NOT rate limits", () => {
  const notRate: [string, string][] = [
    ["context_length_exceeded: this model's maximum context length is 200000 tokens", "nonzero_exit"],
    ["Prompt is too long: 250000 tokens > 200000 maximum", "nonzero_exit"],
    ["error: file size limit exceeded (10 MB)", "nonzero_exit"],
    ["Too many open files (EMFILE)", "nonzero_exit"],
    ["max_tokens limit reached; output truncated", "nonzero_exit"],
    ["The command line is too long.", "nonzero_exit"],
    ["fatal: unable to access repository: limit of 5 worktrees exceeded", "nonzero_exit"],
    ["Error: build failed with 429 type errors", "nonzero_exit"],
    ["unexpected token } at position 429", "nonzero_exit"],
  ];
  for (const [text, want] of notRate) assert.equal(classifyFailure(raw({ stderr: text })).kind, want, text);
});

test("MALFORMED OUTPUT: exit 0 with unusable stdout is 'malformed_output'; a plain non-zero exit with no clue is 'nonzero_exit' and says the exit code", () => {
  const m = classifyFailure(raw({ exitCode: 0, stdout: "<<<not json>>>" }), { malformed: true });
  assert.equal(m.kind, "malformed_output");
  assert.match(m.plain, /reply wasn't in the expected form|unexpected|malformed/i);
  const n = classifyFailure(raw({ exitCode: 3, stderr: "something odd" }));
  assert.equal(n.kind, "nonzero_exit");
  assert.match(n.plain, /code 3/);
});

test("labelFailure keeps the original error and adds kind + plain text; a timeout stays a TurnTimeoutError", () => {
  const timeout = labelFailure("claude-code", new TurnTimeoutError("claude-code turn timed out", {}), raw({ timedOut: true, exitCode: null }));
  assert.ok(timeout instanceof TurnTimeoutError);
  assert.equal((timeout.details as Record<string, unknown>)["failureKind"], "timeout");
  const auth = labelFailure("codex-cli", new InternalError("codex-cli exited 1"), raw({ stderr: "401 Unauthorized" }));
  assert.match(auth.message, /^codex-cli: .*sign/i);
  assert.equal((auth.details as Record<string, unknown>)["failureKind"], "auth");
});

// ---- end to end through makeTextCall with injected process results ----

const cases: { name: string; provider: "claude-code" | "codex-cli"; result: RawInvocationResult; kind: string; plain: RegExp }[] = [
  { name: "timeout", provider: "claude-code", result: raw({ timedOut: true, exitCode: null }), kind: "timeout", plain: /took too long/i },
  { name: "auth", provider: "claude-code", result: raw({ stdout: JSON.stringify({ is_error: true, result: "Invalid API key · Please run /login" }), exitCode: 1, stderr: "Invalid API key · Please run /login" }), kind: "auth", plain: /sign/i },
  { name: "CLI missing", provider: "codex-cli", result: raw({ exitCode: null, stderr: "spawn codex ENOENT" }), kind: "cli_missing", plain: /install/i },
  { name: "malformed output", provider: "claude-code", result: raw({ exitCode: 0, stdout: "this is not json" }), kind: "malformed_output", plain: /expected form|unexpected/i },
  { name: "rate limit", provider: "codex-cli", result: raw({ exitCode: 1, stderr: "429 Too Many Requests: usage limit reached" }), kind: "rate_limit", plain: /limit|wait/i },
  { name: "context too long (not a rate limit)", provider: "claude-code", result: raw({ exitCode: 1, stderr: "Prompt is too long" }), kind: "nonzero_exit", plain: /exit/i },
];

for (const c of cases) {
  test(`END TO END text call -- ${c.name}: a clear failure message, the right label on the failure AND in the text_call event`, async () => {
    assert.ok(isTextCapable(ADAPTER_REGISTRY[c.provider]));
    const events = new MemoryEventSink();
    const call = makeTextCall({ events, runProcessFn: () => Promise.resolve(c.result) });
    const r = await call(c.provider, { prompt: "p", cwd: process.cwd(), timeoutMs: 1000, tier: "research-grade", webSearch: false, modelOverride: null }, "spec");
    assert.equal(r.outcome.ok, false);
    assert.match(r.outcome.failure?.message ?? "", c.plain);
    assert.equal((r.outcome.failure?.details as Record<string, unknown> | undefined)?.["failureKind"], c.kind);
    const ev = events.events.find((e) => e.event === "text_call");
    assert.equal(ev?.data["ok"], false);
    assert.equal(ev?.data["failureKind"], c.kind);
    assert.ok(String(ev?.data["failure"]).startsWith(c.provider), "the message names the provider");
  });
}

test("a failed call's text_call event carries what the CLI itself said (short, whitespace-folded), and withholds it if it looks like a credential (found by the live e2e run: 'exited with code 1' twice and nothing to diagnose it with)", async () => {
  const run = async (stderr: string): Promise<Record<string, unknown>> => {
    const events = new MemoryEventSink();
    const call = makeTextCall({ events, runProcessFn: () => Promise.resolve(raw({ exitCode: 1, stderr })) });
    await call("codex-cli", { prompt: "p", cwd: process.cwd(), timeoutMs: 1000, tier: "research-grade", webSearch: false, modelOverride: null }, "spec");
    return events.events.find((e) => e.event === "text_call")?.data ?? {};
  };
  const said = await run("error: unexpected argument\n   --foo   found\n".repeat(60));
  const evidence = String(said["evidence"]);
  assert.ok(evidence.length <= 500, "bounded");
  assert.match(evidence, /unexpected argument --foo found/, "whitespace folded, the end of the output kept");
  const leaky = await run("auth failed for key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh");
  assert.match(String(leaky["evidence"]), /withheld/);
  assert.ok(!String(leaky["evidence"]).includes("sk-ant"));
  const ok = new MemoryEventSink();
  const okCall = makeTextCall({ events: ok, runProcessFn: () => Promise.resolve(raw({ exitCode: 0, stdout: JSON.stringify({ result: "fine", is_error: false }) })) });
  await okCall("claude-code", { prompt: "p", cwd: process.cwd(), timeoutMs: 1000, tier: "research-grade", webSearch: false, modelOverride: null }, "spec");
  assert.ok(!("evidence" in (ok.events.find((e) => e.event === "text_call")?.data ?? {})), "a successful call logs no evidence");
});
