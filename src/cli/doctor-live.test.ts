// `doctor --live`: a provider's login is checked with ONE real, tiny call instead of being inferred from a saved file. Found because
// `doctor` reported Antigravity as "authenticated" (a refresh_token was on disk) while a real call answered "Authentication required".
// Every test injects a fake preflight and a fake probe: no real provider is ever called.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ExitCode, UsageError } from "../domain/errors.ts";
import type { PreflightReport } from "../ports/provider-adapter.ts";
import type { PreflightSummary } from "../verify/preflight.ts";
import { runDoctor } from "./doctor.ts";
import { doctorOptionsOf, parseArgs } from "./main.ts";

const report = (provider: PreflightReport["provider"], over: Partial<PreflightReport> = {}): PreflightReport => ({
  provider,
  cliFound: true,
  version: "1.0.0",
  versionInRange: true,
  authenticated: true,
  authState: "authenticated",
  problems: [],
  ...over,
});

const NOT_INSTALLED = (provider: PreflightReport["provider"]): PreflightReport =>
  report(provider, { cliFound: false, version: null, authenticated: false, authState: "unauthenticated", problems: [`${provider} is not installed.`] });

function summary(providers: PreflightReport[]): PreflightSummary {
  return { node: { found: true, version: "24.0.0", inRange: true }, git: { found: true, version: "2.54.0", inRange: true }, providers, ok: true, problems: [], warnings: [] };
}

const AUTH_FAIL = "Authentication required. Please visit the URL to log in; authentication failed or timed out";

test("without --live no real call is made, and a login judged from a saved file says so", async () => {
  let probed = 0;
  const { report: r } = await runDoctor("/x", { json: true, only: "providers" }, { preflightFn: () => Promise.resolve(summary([report("claude-code"), report("antigravity-cli")])), liveProbe: () => (probed += 1, Promise.resolve(null)) });
  assert.equal(probed, 0);
  assert.equal(r.providers.find((p) => p.provider === "antigravity-cli")?.authState, "authenticated", "the static answer is unchanged");
  assert.ok((r.warnings ?? []).some((w) => /antigravity/i.test(w) && /saved|file/i.test(w) && /--live/.test(w)), `no warning about the unverified login: ${JSON.stringify(r.warnings)}`);
  assert.ok(!(r.warnings ?? []).some((w) => /claude/i.test(w) && /--live/.test(w)), "providers whose CLI answers a real status query are not flagged");
});

test("--live: a login that fails a real call becomes unauthenticated, with how to fix it; another healthy provider keeps the run OK", async () => {
  const probe = (p: string): Promise<string | null> => Promise.resolve(p === "antigravity-cli" ? AUTH_FAIL : null);
  const { report: r, exitCode } = await runDoctor("/x", { json: true, only: "providers", live: true }, { preflightFn: () => Promise.resolve(summary([report("claude-code"), report("antigravity-cli")])), liveProbe: probe });
  const agy = r.providers.find((p) => p.provider === "antigravity-cli");
  assert.equal(agy?.authenticated, false);
  assert.equal(agy?.authState, "unauthenticated");
  assert.ok(agy?.problems.some((x) => /agy/.test(x) && /sign/i.test(x)), `no sign-in instruction: ${JSON.stringify(agy?.problems)}`);
  assert.equal(r.providers.find((p) => p.provider === "claude-code")?.authState, "authenticated");
  assert.equal(r.ok, true, "one healthy provider is enough, so a broken one is a warning");
  assert.equal(exitCode, ExitCode.OK);
  assert.ok((r.warnings ?? []).some((w) => /antigravity/i.test(w) && /agy/.test(w)));
});

test("--live: when the failing provider was the only one, it is a problem and the exit code says preflight failed", async () => {
  const { report: r, exitCode } = await runDoctor("/x", { json: true, only: "providers", live: true }, { preflightFn: () => Promise.resolve(summary([NOT_INSTALLED("claude-code"), report("antigravity-cli")])), liveProbe: () => Promise.resolve(AUTH_FAIL) });
  assert.equal(r.ok, false);
  assert.equal(exitCode, ExitCode.PREFLIGHT_FAILED);
  assert.ok(r.problems.some((x) => /antigravity/i.test(x) && /agy/.test(x)));
});

test("--live: a probe that throws is a failed provider, not a crash", async () => {
  const { report: r } = await runDoctor("/x", { json: true, only: "providers", live: true }, { preflightFn: () => Promise.resolve(summary([report("claude-code"), report("codex-cli")])), liveProbe: (p) => (p === "codex-cli" ? Promise.reject(new Error("spawn failed")) : Promise.resolve(null)) });
  assert.equal(r.providers.find((p) => p.provider === "codex-cli")?.authState, "indeterminate", "a crash of the probe says nothing about the login");
  assert.ok(r.providers.find((p) => p.provider === "codex-cli")?.problems.some((x) => /spawn failed/.test(x)));
});

test("--live: only providers that already passed the static checks are probed", async () => {
  const seen: string[] = [];
  await runDoctor("/x", { json: true, only: "providers", live: true }, {
    preflightFn: () => Promise.resolve(summary([report("claude-code"), NOT_INSTALLED("codex-cli"), report("antigravity-cli", { authenticated: false, authState: "unauthenticated", problems: ["not signed in"] })])),
    liveProbe: (p) => (seen.push(p), Promise.resolve(null)),
  });
  assert.deepEqual(seen, ["claude-code"]);
});

test("--live: a failure that is not about signing in does not tell the person to sign in", async () => {
  const { report: r } = await runDoctor("/x", { json: true, only: "providers", live: true }, { preflightFn: () => Promise.resolve(summary([report("claude-code"), report("antigravity-cli")])), liveProbe: (p) => Promise.resolve(p === "antigravity-cli" ? "the model returned an empty answer" : null) });
  const agy = r.providers.find((p) => p.provider === "antigravity-cli");
  assert.equal(agy?.authState, "indeterminate", "not a sign-in failure, so not called one");
  assert.equal(agy?.authenticated, false);
  assert.ok(!agy?.problems.some((x) => /sign in again/i.test(x)), JSON.stringify(agy?.problems));
  assert.ok(agy?.problems.some((x) => /empty answer/.test(x)));
});

test("the parsed --live flag reaches runDoctor (it was parsed and then dropped by the dispatch)", () => {
  const cmd = parseArgs(["node", "osa", "doctor", "--providers", "--live"]);
  assert.ok(cmd.kind === "doctor");
  assert.equal(doctorOptionsOf(cmd).live, true);
  const plain = parseArgs(["node", "osa", "doctor", "--json"]);
  assert.ok(plain.kind === "doctor");
  assert.equal("live" in doctorOptionsOf(plain), false);
});

test("argument parsing: --live is accepted for doctor and for --providers, and refused with --boundary", () => {
  const a = parseArgs(["node", "osa", "doctor", "--live"]);
  assert.ok(a.kind === "doctor" && a.live === true && a.only === "all");
  const b = parseArgs(["node", "osa", "doctor", "--providers", "--live", "--json"]);
  assert.ok(b.kind === "doctor" && b.live === true && b.only === "providers" && b.json === true);
  assert.ok(parseArgs(["node", "osa", "doctor"]).kind === "doctor");
  assert.throws(() => parseArgs(["node", "osa", "doctor", "--boundary", "--live"]), UsageError);
});

// A slow CLI start is not a missing CLI. `agy --version` takes 1.4 to 10 s on its own, and `doctor` starts every provider's probe at once, so
// under load it passed the 15 s limit and the timeout was reported as "not found on PATH" (and the same in the MCP server's preflight).
import { checkProviderCli } from "../verify/preflight.ts";
import type { RawInvocationResult } from "../domain/run.ts";

const raw = (over: Partial<RawInvocationResult>): RawInvocationResult => ({ exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...over });

test("a --version probe that times out is retried once with a longer limit before the CLI is called missing", async () => {
  const limits: number[] = [];
  const run = (o: { timeoutMs: number }): Promise<RawInvocationResult> => {
    limits.push(o.timeoutMs);
    return Promise.resolve(limits.length === 1 ? raw({ exitCode: null, timedOut: true }) : raw({ stdout: "1.4.7\n" }));
  };
  const cli = await checkProviderCli("antigravity-cli", run as never);
  assert.deepEqual(cli, { found: true, version: "1.4.7" });
  assert.equal(limits.length, 2);
  assert.ok((limits[1] as number) > (limits[0] as number), "the retry waits longer");
});

test("a CLI that is really absent is not retried (it fails at once, so there is nothing to wait for)", async () => {
  let calls = 0;
  const run = (): Promise<RawInvocationResult> => (calls += 1, Promise.resolve(raw({ exitCode: -2, stderr: "ENOENT" })));
  const cli = await checkProviderCli("antigravity-cli", run as never);
  assert.equal(cli.found, false);
  assert.equal(calls, 1);
});

test("a CLI that times out on both tries is reported as not found, as before", async () => {
  let calls = 0;
  const run = (): Promise<RawInvocationResult> => (calls += 1, Promise.resolve(raw({ exitCode: null, timedOut: true })));
  assert.equal((await checkProviderCli("antigravity-cli", run as never)).found, false);
  assert.equal(calls, 2);
});
