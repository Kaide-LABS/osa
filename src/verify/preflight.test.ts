// Implements PHASE_1_SPEC.md §1.6 -- preflight.test.ts
// Covers version parsing, range checking, and auth-probe interpretation. The interpretation tests
// use literally-constructed fake RawInvocationResult objects (see preflight.ts's parse* functions)
// rather than spawning real processes or mocking node:child_process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PROVIDER_IDS } from "../domain/run.ts";
import type { RawInvocationResult } from "../domain/run.ts";
import {
  checkGitAvailable,
  checkNodeVersion,
  inRange,
  parseClaudeAuthResult,
  parseCodexAuthResult,
  interpretAntigravityAuthInputs,
  MIN_HEALTHY_PROVIDERS,
  parseProviderCliVersionResult,
  parseSemverish,
  PROVIDER_VERSION_RANGES,
  runPreflight,
  TOOL_VERSION_RANGES,
} from "./preflight.ts";

function fakeResult(overrides: Partial<RawInvocationResult> = {}): RawInvocationResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    ...overrides,
  };
}

test("parseSemverish extracts MAJOR.MINOR.PATCH from real observed version banners", () => {
  assert.deepStrictEqual(parseSemverish("2.1.211 (Claude Code)"), { major: 2, minor: 1, patch: 211 });
  assert.deepStrictEqual(parseSemverish("codex-cli 0.128.0"), { major: 0, minor: 128, patch: 0 });
  assert.deepStrictEqual(parseSemverish("git version 2.54.0.windows.1"), { major: 2, minor: 54, patch: 0 });
});

test("parseSemverish returns null when no triple is present", () => {
  assert.equal(parseSemverish("not a version"), null);
  assert.equal(parseSemverish(""), null);
});

test("inRange is inclusive of min and exclusive of max", () => {
  assert.equal(inRange("2.1.200", "2.1.200", "3.0.0"), true);
  assert.equal(inRange("2.1.211", "2.1.200", "3.0.0"), true);
  assert.equal(inRange("3.0.0", "2.1.200", "3.0.0"), false);
  assert.equal(inRange("2.1.199", "2.1.200", "3.0.0"), false);
});

test("inRange is false when any operand fails to parse", () => {
  assert.equal(inRange("garbage", "2.1.200", "3.0.0"), false);
});

test("PROVIDER_VERSION_RANGES and TOOL_VERSION_RANGES are declared in exactly this module", () => {
  assert.deepStrictEqual(Object.keys(PROVIDER_VERSION_RANGES).sort(), ["antigravity-cli", "claude-code", "codex-cli", "copilot-cli", "opencode-cli"]);
  assert.deepStrictEqual(Object.keys(TOOL_VERSION_RANGES).sort(), ["git", "node"]);
});

test("checkNodeVersion reports the running Node.js version as found and in range", () => {
  const result = checkNodeVersion();
  assert.equal(result.found, true);
  assert.equal(result.version, process.versions.node);
  assert.equal(result.inRange, true);
});

test("checkGitAvailable reports the real, locally installed git as found and in range", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-preflight-test-`);
  try {
    const result = await checkGitAvailable(dir);
    assert.equal(result.found, true);
    assert.equal(result.inRange, true);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("parseProviderCliVersionResult: exit 0 -> found with trimmed stdout", () => {
  const parsed = parseProviderCliVersionResult(fakeResult({ exitCode: 0, stdout: "2.1.211 (Claude Code)\n" }));
  assert.deepStrictEqual(parsed, { found: true, version: "2.1.211 (Claude Code)" });
});

test("parseProviderCliVersionResult: non-zero exit -> not found", () => {
  const parsed = parseProviderCliVersionResult(fakeResult({ exitCode: null, stderr: "ENOENT" }));
  assert.deepStrictEqual(parsed, { found: false, version: null });
});

test("parseClaudeAuthResult: exit 0 with loggedIn: true -> authenticated", () => {
  const parsed = parseClaudeAuthResult(
    fakeResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) }),
  );
  assert.equal(parsed.authenticated, true);
  assert.equal(parsed.authState, "authenticated");
});

test("parseClaudeAuthResult: exit 0 with loggedIn: false -> not authenticated", () => {
  const parsed = parseClaudeAuthResult(fakeResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: false }) }));
  assert.equal(parsed.authenticated, false);
  // The CLI ran fine and its own output answered the question: a real claim, not a probe failure.
  assert.equal(parsed.authState, "unauthenticated");
});

test("parseClaudeAuthResult: non-JSON stdout -> unauthenticated, not a crash", () => {
  const parsed = parseClaudeAuthResult(fakeResult({ exitCode: 0, stdout: "not json at all" }));
  assert.equal(parsed.authenticated, false);
  assert.match(parsed.detail, /unrecognised/);
});

test("parseClaudeAuthResult: malformed (non-JSON) stdout is INDETERMINATE, not a sign-in failure", () => {
  const parsed = parseClaudeAuthResult(fakeResult({ exitCode: 0, stdout: "not json at all" }));
  assert.equal(parsed.authState, "indeterminate");
  // Previously indistinguishable from the genuine loggedIn: false case above; now it is not.
  const genuine = parseClaudeAuthResult(fakeResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: false }) }));
  assert.notEqual(parsed.authState, genuine.authState);
  assert.equal(parsed.authenticated, genuine.authenticated, "both still report authenticated: false");
});

test("parseClaudeAuthResult: valid JSON with no loggedIn boolean is INDETERMINATE", () => {
  const parsed = parseClaudeAuthResult(fakeResult({ exitCode: 0, stdout: JSON.stringify({ authMethod: "claude.ai" }) }));
  assert.equal(parsed.authState, "indeterminate");
  assert.equal(parsed.authenticated, false);
});

test("parseClaudeAuthResult: JSON that is not an object (a bare string) is INDETERMINATE", () => {
  const parsed = parseClaudeAuthResult(fakeResult({ exitCode: 0, stdout: JSON.stringify("ok") }));
  assert.equal(parsed.authState, "indeterminate");
  assert.equal(parsed.authenticated, false);
});

test("parseClaudeAuthResult: non-zero exit -> not authenticated", () => {
  const parsed = parseClaudeAuthResult(fakeResult({ exitCode: 1, stdout: "" }));
  assert.equal(parsed.authenticated, false);
});

test("parseClaudeAuthResult: an unexpected exit code is INDETERMINATE (the CLI's verified shape is exit 0 either way)", () => {
  for (const exitCode of [1, 2, 127]) {
    const parsed = parseClaudeAuthResult(fakeResult({ exitCode, stdout: "" }));
    assert.equal(parsed.authState, "indeterminate", `exit ${String(exitCode)} should be indeterminate`);
    assert.equal(parsed.authenticated, false);
  }
});

test("parseClaudeAuthResult: a timed-out probe is INDETERMINATE", () => {
  const parsed = parseClaudeAuthResult(fakeResult({ exitCode: null, signal: "SIGTERM", timedOut: true }));
  assert.equal(parsed.authState, "indeterminate");
  assert.equal(parsed.authenticated, false);
  assert.match(parsed.detail, /timed out/);
});

test("parseClaudeAuthResult: CLI absent (ENOENT-shaped result) -> not authenticated, no crash", () => {
  const parsed = parseClaudeAuthResult(fakeResult({ exitCode: null, stdout: "", stderr: "spawn claude ENOENT" }));
  assert.equal(parsed.authenticated, false);
  // A failed spawn says nothing whatsoever about credentials.
  assert.equal(parsed.authState, "indeterminate");
});

test("parseCodexAuthResult: exit 0 -> authenticated regardless of stdout shape", () => {
  const parsed = parseCodexAuthResult(fakeResult({ exitCode: 0, stdout: "" }), {});
  assert.equal(parsed.authenticated, true);
  assert.equal(parsed.authState, "authenticated");
});

test("parseCodexAuthResult: non-zero exit, no API key env var -> not authenticated", () => {
  const parsed = parseCodexAuthResult(fakeResult({ exitCode: 1, stdout: "Not logged in" }), {});
  assert.equal(parsed.authenticated, false);
  // Exit 1 is this CLI's documented, locally-verified not-signed-in result: a real claim.
  assert.equal(parsed.authState, "unauthenticated");
});

test("parseCodexAuthResult: an exit code matching neither documented outcome is INDETERMINATE", () => {
  // This is the exact class of result the Windows cmd.exe relaunch fallback could surface from the
  // launcher shim rather than from the CLI itself -- the failure mode that made a broken probe read
  // identically to a genuinely signed-out provider.
  const genuine = parseCodexAuthResult(fakeResult({ exitCode: 1, stdout: "Not logged in" }), {});
  for (const exitCode of [2, 9009, 127]) {
    const parsed = parseCodexAuthResult(fakeResult({ exitCode, stderr: "'codex' is not recognized" }), {});
    assert.equal(parsed.authState, "indeterminate", `exit ${String(exitCode)} should be indeterminate`);
    assert.notEqual(parsed.authState, genuine.authState);
    assert.equal(parsed.authenticated, false, "the shipped boolean contract is unchanged");
    assert.match(parsed.detail, /neither/);
  }
});

test("parseCodexAuthResult: a timed-out probe is INDETERMINATE, not signed out", () => {
  const parsed = parseCodexAuthResult(fakeResult({ exitCode: null, signal: "SIGTERM", timedOut: true }), {});
  assert.equal(parsed.authState, "indeterminate");
  assert.equal(parsed.authenticated, false);
  assert.match(parsed.detail, /timed out/);
});

test("parseCodexAuthResult: non-zero exit, CODEX_API_KEY set -> authenticated via env var", () => {
  const parsed = parseCodexAuthResult(fakeResult({ exitCode: 1 }), { CODEX_API_KEY: "sk-fake-for-test" });
  assert.equal(parsed.authenticated, true);
  assert.equal(parsed.authState, "authenticated");
  assert.match(parsed.detail, /API key/);
});

test("parseCodexAuthResult: a BYOA env var wins even over an otherwise-indeterminate exit code", () => {
  const parsed = parseCodexAuthResult(fakeResult({ exitCode: 9009 }), { OPENAI_API_KEY: "sk-fake-for-test" });
  assert.equal(parsed.authState, "authenticated");
});

test("parseCodexAuthResult: non-zero exit, OPENAI_API_KEY set -> authenticated via env var", () => {
  const parsed = parseCodexAuthResult(fakeResult({ exitCode: 1 }), { OPENAI_API_KEY: "sk-fake-for-test" });
  assert.equal(parsed.authenticated, true);
});

test("parseCodexAuthResult: CLI absent (ENOENT-shaped result), no env var -> not authenticated, no crash", () => {
  const parsed = parseCodexAuthResult(fakeResult({ exitCode: null, stderr: "spawn codex ENOENT" }), {});
  assert.equal(parsed.authenticated, false);
  assert.equal(parsed.authState, "indeterminate");
});

test("both parsers keep the shipped invariant: authenticated === true iff authState === \"authenticated\"", () => {
  const cases = [
    parseClaudeAuthResult(fakeResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true }) })),
    parseClaudeAuthResult(fakeResult({ exitCode: 0, stdout: JSON.stringify({ loggedIn: false }) })),
    parseClaudeAuthResult(fakeResult({ exitCode: 0, stdout: "garbage" })),
    parseClaudeAuthResult(fakeResult({ exitCode: 3 })),
    parseCodexAuthResult(fakeResult({ exitCode: 0 }), {}),
    parseCodexAuthResult(fakeResult({ exitCode: 1 }), {}),
    parseCodexAuthResult(fakeResult({ exitCode: 42 }), {}),
    parseCodexAuthResult(fakeResult({ exitCode: 1 }), { CODEX_API_KEY: "sk-fake-for-test" }),
  ];
  for (const c of cases) {
    assert.equal(c.authenticated, c.authState === "authenticated", `drift for authState "${c.authState}"`);
    assert.notEqual(c.detail, "");
  }
});

test("runPreflight probes every provider identity and needs only ONE healthy provider; the rest are warnings, never failures (machine-independent)", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-preflight-test-`);
  try {
    const summary = await runPreflight(dir);
    assert.deepStrictEqual(summary.providers.map((p) => p.provider).sort(), [...PROVIDER_IDS].sort());
    const healthy = summary.providers.filter((p) => p.problems.length === 0);
    assert.equal(summary.ok, summary.node.inRange && summary.git.inRange && healthy.length >= MIN_HEALTHY_PROVIDERS);
    assert.equal(MIN_HEALTHY_PROVIDERS, 1);
    for (const p of summary.providers) assert.equal(p.authenticated, p.authState === "authenticated");
    if (healthy.length >= MIN_HEALTHY_PROVIDERS) {
      // enough providers: a missing CLI is silence, an installed-but-broken one is a warning, and neither is a problem
      for (const p of summary.providers) if (p.problems.length > 0) assert.ok(!summary.problems.some((x) => p.problems.includes(x)), `${p.provider}'s remediation must not be a problem`);
      for (const p of summary.providers) if (p.cliFound && p.problems.length > 0) assert.ok(p.problems.every((x) => (summary.warnings ?? []).includes(x)));
      for (const p of summary.providers) if (!p.cliFound) assert.ok(!(summary.warnings ?? []).some((x) => p.problems.includes(x)), "a provider that is not installed is not mentioned");
    } else {
      assert.ok(summary.problems.length > 0, "nothing healthy to run on is a problem");
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("interpretAntigravityAuthInputs observes settings and key presence without exposing key material", () => {
  assert.equal(interpretAntigravityAuthInputs(null, { GEMINI_API_KEY: "test-key" }, null).authState, "indeterminate");
  assert.equal(interpretAntigravityAuthInputs("not-json", { GEMINI_API_KEY: "test-key" }, null).authState, "indeterminate");
  assert.equal(interpretAntigravityAuthInputs(JSON.stringify({}), { GEMINI_API_KEY: "test-key" }, null).authState, "indeterminate");
  assert.equal(interpretAntigravityAuthInputs(JSON.stringify({ modelProvider: "gemini" }), {}, null).authState, "unauthenticated");
  assert.equal(interpretAntigravityAuthInputs(JSON.stringify({ modelProvider: "gemini" }), { GEMINI_API_KEY: "test-key" }, null).authState, "authenticated");
  assert.equal(interpretAntigravityAuthInputs(JSON.stringify({ modelProvider: "other" }), { GEMINI_API_KEY: "test-key" }, null).authState, "unauthenticated");
});

test("interpretAntigravityAuthInputs recognizes a cached Google account (subscription) OAuth session via refresh_token presence", () => {
  const withRefreshToken = JSON.stringify({ access_token: "at-fake-for-test", refresh_token: "rt-fake-for-test" });
  assert.equal(interpretAntigravityAuthInputs(null, {}, withRefreshToken).authState, "authenticated");
  // No settings file at all (this operator's real machine state) is not a blocker: subscription auth stands alone.
  assert.equal(interpretAntigravityAuthInputs(null, {}, withRefreshToken).authenticated, true);
});

test("interpretAntigravityAuthInputs: OAuth creds file absent, unparseable, or missing/empty refresh_token is INDETERMINATE, not a sign-in failure", () => {
  assert.equal(interpretAntigravityAuthInputs(null, {}, null).authState, "indeterminate");
  assert.equal(interpretAntigravityAuthInputs(null, {}, "not-json").authState, "indeterminate");
  assert.equal(interpretAntigravityAuthInputs(null, {}, JSON.stringify({})).authState, "indeterminate");
  assert.equal(interpretAntigravityAuthInputs(null, {}, JSON.stringify({ refresh_token: "" })).authState, "indeterminate");
  assert.equal(interpretAntigravityAuthInputs(null, {}, JSON.stringify(["not", "an", "object"])).authState, "indeterminate");
});

test("interpretAntigravityAuthInputs: subscription auth is sufficient even when settings name a different provider mode", () => {
  // A stale/unrelated modelProvider setting must not mask a genuinely valid subscription session.
  const misconfiguredHeadless = JSON.stringify({ modelProvider: "other" });
  const withRefreshToken = JSON.stringify({ refresh_token: "rt-fake-for-test" });
  assert.equal(interpretAntigravityAuthInputs(misconfiguredHeadless, {}, withRefreshToken).authState, "authenticated");
});

test("interpretAntigravityAuthInputs: headless API key mode is checked first, but either mode alone is sufficient", () => {
  const headlessConfigured = JSON.stringify({ modelProvider: "gemini" });
  const withRefreshToken = JSON.stringify({ refresh_token: "rt-fake-for-test" });
  // Headless authenticated, no OAuth creds at all.
  assert.equal(interpretAntigravityAuthInputs(headlessConfigured, { GEMINI_API_KEY: "test-key" }, null).authState, "authenticated");
  // Headless not configured, OAuth creds authenticated.
  assert.equal(interpretAntigravityAuthInputs(null, {}, withRefreshToken).authState, "authenticated");
  // Both present and valid: still a clean "authenticated", not a conflict.
  assert.equal(interpretAntigravityAuthInputs(headlessConfigured, { GEMINI_API_KEY: "test-key" }, withRefreshToken).authState, "authenticated");
});

test("interpretAntigravityAuthInputs never exposes the refresh_token value in its detail", () => {
  const secret = "rt-super-secret-value-for-test";
  const result = interpretAntigravityAuthInputs(null, {}, JSON.stringify({ refresh_token: secret }));
  assert.doesNotMatch(result.detail, new RegExp(secret));
});

test("parseOpenCodeAuthResult: one stored/env/config login line is authenticated, none is unauthenticated, a failing probe is indeterminate", async () => {
  const { parseOpenCodeAuthResult } = await import("./preflight.ts");
  const r = (stdout: string, exitCode = 0): RawInvocationResult => ({ exitCode, signal: null, stdout, stderr: "", durationMs: 1, timedOut: false });
  assert.equal(parseOpenCodeAuthResult(r("Anthropic  Anthropic                   stored\r\n")).authState, "authenticated");
  assert.equal(parseOpenCodeAuthResult(r("OpenAI  OpenAI  env\n")).authState, "authenticated");
  assert.equal(parseOpenCodeAuthResult(r("")).authState, "unauthenticated");
  assert.equal(parseOpenCodeAuthResult(r("some banner text\n")).authState, "unauthenticated");
  assert.equal(parseOpenCodeAuthResult(r("", 1)).authState, "indeterminate");
});
