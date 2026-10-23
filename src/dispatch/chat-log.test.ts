// Implements PHASE_10_SPEC.md §1.1 (A4), §7, §8 -- chat-log.test.ts
// Coverage for every pure function against literally-constructed inputs, plus real-filesystem and
// real-git coverage for appendChatLogEntry / ensureChatLogGitignore.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { RawInvocationResult, TurnOutcome, TurnRequest } from "../domain/run.ts";
import { runProcess } from "../util/exec.ts";
import {
  CHAT_LOG_GITIGNORE_CONTENT,
  appendChatLogEntry,
  buildPromptEntry,
  buildResponseEntry,
  credentialWarningFor,
  detectCredentialShapedContent,
  ensureChatLogGitignore,
  serialiseChatLogEntry,
} from "./chat-log.ts";
import { chatLogGitignorePath, chatLogPath } from "../util/paths.ts";

const GIT_TIMEOUT_MS = 120_000;

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const result = await runProcess({ command: "git", args, cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${String(result.exitCode)}): ${result.stderr}`);
  }
  return result.stdout;
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "--quiet", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
}

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/osa-chat-log-test-`);
  await initRepo(dir);
  return dir;
}

function baseReq(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    runId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    phase: 1,
    turnIndex: 0,
    archetype: "executor",
    provider: "claude-code",
    tier: "high-volume-low-effort",
    modelOverride: null,
    repoDir: "unused",
    specRef: { path: "PHASE_1_SPEC.md", sha256: "9".repeat(64) },
    priorRecord: null,
    prompt: "do the work",
    timeoutMs: 30_000,
    babyPrdPath: "baby_prd.md",
    contextPath: "context.md",
    expectedArtifactPath: null,
    chatLogId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    chatLogGitignored: true,
    ...overrides,
  };
}

function fakeRaw(overrides: Partial<RawInvocationResult> = {}): RawInvocationResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "out",
    stderr: "",
    durationMs: 42,
    timedOut: false,
    ...overrides,
  };
}

function fakeOutcome(overrides: Partial<TurnOutcome> = {}): TurnOutcome {
  return { ok: true, record: null, failure: null, ...overrides };
}

test("detectCredentialShapedContent detects sk-, ghp_, xoxb- prefixed tokens", () => {
  assert.equal(detectCredentialShapedContent(["contains sk-AAAABBBBCCCC1234 here"]), true);
  assert.equal(detectCredentialShapedContent(["contains ghp_AAAABBBBCCCC1234 here"]), true);
  assert.equal(detectCredentialShapedContent(["contains xoxb-AAAABBBBCCCC1234 here"]), true);
});

test("detectCredentialShapedContent is false for text with no credential-shaped tokens", () => {
  assert.equal(detectCredentialShapedContent(["nothing interesting here"]), false);
});

test("detectCredentialShapedContent is false for an all-null input array", () => {
  assert.equal(detectCredentialShapedContent([null, null]), false);
});

test("detectCredentialShapedContent returns the same answer across repeated calls (no /g lastIndex hazard)", () => {
  const texts = ["sk-AAAABBBBCCCC1234"];
  assert.equal(detectCredentialShapedContent(texts), true);
  assert.equal(detectCredentialShapedContent(texts), true);
  assert.equal(detectCredentialShapedContent(texts), true);
});

test("buildPromptEntry produces entry_kind 'prompt', outcome null, and transcript.prompt verbatim", () => {
  const req = baseReq({ prompt: "exact prompt text\nwith a newline" });
  const entry = buildPromptEntry({ req });
  assert.equal(entry.entry_kind, "prompt");
  assert.equal(entry.outcome, null);
  assert.equal(entry.transcript.prompt, "exact prompt text\nwith a newline");
  assert.equal(entry.transcript.stdout, null);
  assert.equal(entry.transcript.stderr, null);
  assert.equal(entry.chat_log_id, req.chatLogId);
  assert.equal(entry.role, "executor");
  assert.equal(entry.credential_shaped_content_detected, false);
});

test("buildPromptEntry flags credential-shaped content without altering it", () => {
  const req = baseReq({ prompt: "here is sk-AAAABBBBCCCC1234, do not lose it" });
  const entry = buildPromptEntry({ req });
  assert.equal(entry.credential_shaped_content_detected, true);
  assert.equal(entry.transcript.prompt, "here is sk-AAAABBBBCCCC1234, do not lose it");
});

test("buildResponseEntry produces entry_kind 'response' and carries real stdout/stderr and outcome fields", () => {
  const req = baseReq({ archetype: "reviewer" });
  const raw = fakeRaw({ stdout: "the real stdout sk-AAAABBBBCCCC1234", stderr: "the real stderr", exitCode: 1 });
  const outcome = fakeOutcome({ ok: false, failure: null });
  const entry = buildResponseEntry({ req, raw, outcome });
  assert.equal(entry.entry_kind, "response");
  assert.equal(entry.role, "reviewer");
  assert.equal(entry.transcript.prompt, null);
  assert.equal(entry.transcript.stdout, "the real stdout sk-AAAABBBBCCCC1234");
  assert.equal(entry.transcript.stderr, "the real stderr");
  assert.equal(entry.credential_shaped_content_detected, true);
  assert.ok(entry.outcome !== null);
  assert.equal(entry.outcome.ok, false);
  assert.equal(entry.outcome.exit_code, 1);
  assert.equal(entry.outcome.timed_out, false);
  assert.equal(entry.outcome.duration_ms, 42);
});

test("buildResponseEntry never truncates a large payload", () => {
  const bigStdout = "x".repeat(1_500_000);
  const req = baseReq();
  const raw = fakeRaw({ stdout: bigStdout });
  const entry = buildResponseEntry({ req, raw, outcome: fakeOutcome() });
  assert.equal(entry.transcript.stdout, bigStdout);
  assert.equal(entry.transcript.stdout?.length, bigStdout.length);
});

test("serialiseChatLogEntry round-trips a >1 MB payload with newlines, quotes, backslashes, and non-ASCII text byte-for-byte", () => {
  const tricky = `line one\nline "two" with \\ backslash and non-ascii: café 日本語` + "x".repeat(1_000_000);
  const req = baseReq();
  const entry = buildResponseEntry({ req, raw: fakeRaw({ stdout: tricky }), outcome: fakeOutcome() });
  const line = serialiseChatLogEntry(entry);
  assert.ok(line.endsWith("\n"));
  assert.equal(line.indexOf("\n"), line.length - 1, "must be exactly one JSON object per line");
  const parsed: unknown = JSON.parse(line);
  assert.deepEqual(parsed, entry);
});

test("credentialWarningFor returns null for an unflagged entry", () => {
  const entry = buildPromptEntry({ req: baseReq({ prompt: "clean" }) });
  assert.equal(credentialWarningFor(entry, true), null);
});

test("credentialWarningFor returns a non-null string for a flagged entry, stronger when gitignore is overridden", () => {
  const entry = buildPromptEntry({ req: baseReq({ prompt: "sk-AAAABBBBCCCC1234" }) });
  const ignoredWarning = credentialWarningFor(entry, true);
  const overriddenWarning = credentialWarningFor(entry, false);
  assert.ok(ignoredWarning !== null);
  assert.ok(overriddenWarning !== null);
  assert.notEqual(ignoredWarning, overriddenWarning);
  assert.ok(overriddenWarning.length > ignoredWarning.length);
});

test("appendChatLogEntry appends real JSONL lines to a real file, creating parent directories", async () => {
  const dir = await mktempDir();
  try {
    const path = chatLogPath(dir, "run-1");
    const entry1 = buildPromptEntry({ req: baseReq({ turnIndex: 0 }) });
    const entry2 = buildResponseEntry({ req: baseReq({ turnIndex: 0 }), raw: fakeRaw(), outcome: fakeOutcome() });
    assert.equal(await appendChatLogEntry(path, entry1), null);
    assert.equal(await appendChatLogEntry(path, entry2), null);
    const content = await readFile(path, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0] as string), entry1);
    assert.deepEqual(JSON.parse(lines[1] as string), entry2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendChatLogEntry never throws: an unwritable path returns a warning string instead", async () => {
  // A path with a null byte is invalid on every platform and cannot be created as a directory.
  const badPath = "\0/invalid/path.jsonl";
  const entry = buildPromptEntry({ req: baseReq() });
  const warning = await appendChatLogEntry(badPath, entry);
  assert.notEqual(warning, null);
  assert.ok(typeof warning === "string" && warning.includes("chat log"));
});

async function mktempDir(): Promise<string> {
  return mkdtemp(`${tmpdir()}/osa-chat-log-io-`);
}

test("ensureChatLogGitignore(dir, true) on a fresh directory writes the managed content, verified by real git check-ignore", async () => {
  const dir = await freshRepo();
  try {
    const warning = await ensureChatLogGitignore(dir, true);
    assert.equal(warning, null);
    const content = await readFile(chatLogGitignorePath(dir), "utf8");
    assert.equal(content, CHAT_LOG_GITIGNORE_CONTENT);

    const logPath = chatLogPath(dir, "run-1");
    await appendChatLogEntry(logPath, buildPromptEntry({ req: baseReq() }));

    const checkIgnore = await runProcess({
      command: "git",
      args: ["check-ignore", "-v", logPath],
      cwd: dir,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    assert.equal(checkIgnore.exitCode, 0);

    const status = await runProcess({
      command: "git",
      args: ["status", "--porcelain", "-uall"],
      cwd: dir,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    assert.equal(status.stdout.includes("chat-log"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureChatLogGitignore(dir, true) is idempotent: a second call on already-matching content is a no-op", async () => {
  const dir = await freshRepo();
  try {
    assert.equal(await ensureChatLogGitignore(dir, true), null);
    assert.equal(await ensureChatLogGitignore(dir, true), null);
    const content = await readFile(chatLogGitignorePath(dir), "utf8");
    assert.equal(content, CHAT_LOG_GITIGNORE_CONTENT);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureChatLogGitignore(dir, false) removes a matching managed ignore file, making the log trackable", async () => {
  const dir = await freshRepo();
  try {
    await ensureChatLogGitignore(dir, true);
    const logPath = chatLogPath(dir, "run-1");
    await appendChatLogEntry(logPath, buildPromptEntry({ req: baseReq() }));

    const warning = await ensureChatLogGitignore(dir, false);
    assert.equal(warning, null);

    const gitignoreExists = await readFile(chatLogGitignorePath(dir), "utf8").then(
      () => true,
      () => false,
    );
    assert.equal(gitignoreExists, false);

    const status = await runProcess({
      command: "git",
      args: ["status", "--porcelain", "-uall"],
      cwd: dir,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    assert.ok(status.stdout.includes("chat-log"));

    const add = await runProcess({ command: "git", args: ["add", logPath], cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
    assert.equal(add.exitCode, 0);
    const lsFiles = await runProcess({ command: "git", args: ["ls-files"], cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
    assert.ok(lsFiles.stdout.includes(".osa/chat-log"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureChatLogGitignore(dir, true) overwrites a pre-existing non-matching file and warns", async () => {
  const dir = await freshRepo();
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(chatLogGitignorePath(dir).replace(/\/[^/]+$/, ""), { recursive: true });
    await writeFile(chatLogGitignorePath(dir), "# not the managed content\n", "utf8");

    const warning = await ensureChatLogGitignore(dir, true);
    assert.notEqual(warning, null);
    const content = await readFile(chatLogGitignorePath(dir), "utf8");
    assert.equal(content, CHAT_LOG_GITIGNORE_CONTENT);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureChatLogGitignore(dir, false) leaves a pre-existing non-matching file untouched and warns", async () => {
  const dir = await freshRepo();
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(chatLogGitignorePath(dir).replace(/\/[^/]+$/, ""), { recursive: true });
    await writeFile(chatLogGitignorePath(dir), "# an operator-authored ignore file\n", "utf8");

    const warning = await ensureChatLogGitignore(dir, false);
    assert.notEqual(warning, null);
    const content = await readFile(chatLogGitignorePath(dir), "utf8");
    assert.equal(content, "# an operator-authored ignore file\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
