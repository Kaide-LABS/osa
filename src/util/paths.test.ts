// Implements PHASE_1_SPEC.md §1.6 -- paths.test.ts
// Covers path normalisation and traversal rejection.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatLogDir,
  chatLogGitignorePath,
  chatLogPath,
  handoffPath,
  isSafeRepoRelPath,
  osaDir,
  runLockPath,
  toRepoRelPosix,
} from "./paths.ts";

test("toRepoRelPosix converts backslashes to forward slashes", () => {
  const rel = toRepoRelPosix("C:\\repo", "C:\\repo\\src\\domain\\relay.ts");
  assert.equal(rel, "src/domain/relay.ts");
});

test("toRepoRelPosix handles POSIX-style inputs identically", () => {
  const rel = toRepoRelPosix("/repo", "/repo/src/domain/relay.ts");
  assert.equal(rel, "src/domain/relay.ts");
});

test("isSafeRepoRelPath accepts a normal relative path", () => {
  assert.equal(isSafeRepoRelPath("src/domain/relay.ts"), true);
  assert.equal(isSafeRepoRelPath("PHASE_1_SPEC.md"), true);
});

test("isSafeRepoRelPath rejects a POSIX-absolute path", () => {
  assert.equal(isSafeRepoRelPath("/etc/passwd"), false);
});

test("isSafeRepoRelPath rejects a Windows drive-absolute path", () => {
  assert.equal(isSafeRepoRelPath("C:/Users/hp/secret.txt"), false);
  assert.equal(isSafeRepoRelPath("c:/Users/hp/secret.txt"), false);
});

test("isSafeRepoRelPath rejects a path containing a backslash", () => {
  assert.equal(isSafeRepoRelPath("src\\domain\\relay.ts"), false);
});

test("isSafeRepoRelPath rejects a .. traversal segment anywhere in the path", () => {
  assert.equal(isSafeRepoRelPath("../secret.txt"), false);
  assert.equal(isSafeRepoRelPath("src/../../secret.txt"), false);
  assert.equal(isSafeRepoRelPath("a/b/.."), false);
});

test("isSafeRepoRelPath does not reject a filename that merely contains dots", () => {
  assert.equal(isSafeRepoRelPath("src/domain/relay.test.ts"), true);
  assert.equal(isSafeRepoRelPath("...weird-but-not-traversal.txt"), true);
});

test("osaDir and runLockPath compose the expected layout", () => {
  assert.equal(osaDir("/repo"), "/repo/.osa");
  assert.equal(runLockPath("/repo"), "/repo/.osa/run.lock");
});

test("handoffPath zero-pads turnIndex to 3 digits so lexical order equals numeric order", () => {
  const p0 = handoffPath("/repo", "run-1", 1, 0, "executor", "claude-code");
  const p1 = handoffPath("/repo", "run-1", 1, 1, "executor", "claude-code");
  const p9 = handoffPath("/repo", "run-1", 1, 9, "executor", "claude-code");
  const p10 = handoffPath("/repo", "run-1", 1, 10, "executor", "claude-code");
  assert.equal(p0, "/repo/.osa/runs/run-1/handoff/1/000-executor-claude-code.json");
  assert.equal(p1, "/repo/.osa/runs/run-1/handoff/1/001-executor-claude-code.json");
  assert.equal(p9, "/repo/.osa/runs/run-1/handoff/1/009-executor-claude-code.json");
  assert.equal(p10, "/repo/.osa/runs/run-1/handoff/1/010-executor-claude-code.json");
  assert.ok([p0, p1, p9, p10].every((p, i, arr) => i === 0 || arr[i - 1]! < p));
});

// Implements PHASE_10_SPEC.md §4.5, §8 AC-U5 -- the same treatment paths.test.ts already gives
// handoffPath/driverLogPath, including on a Windows-shaped repoDir input.

test("chatLogDir composes the expected path", () => {
  assert.equal(chatLogDir("/repo"), "/repo/.osa/chat-log");
});

test("chatLogPath composes the expected path", () => {
  assert.equal(chatLogPath("/repo", "run-1"), "/repo/.osa/chat-log/run-1.jsonl");
});

test("chatLogGitignorePath composes the expected path", () => {
  assert.equal(chatLogGitignorePath("/repo"), "/repo/.osa/chat-log/.gitignore");
});

test("chatLogDir/chatLogPath/chatLogGitignorePath behave identically on a Windows-shaped repoDir input", () => {
  assert.equal(chatLogDir("C:/Users/hp/repo"), "C:/Users/hp/repo/.osa/chat-log");
  assert.equal(chatLogPath("C:/Users/hp/repo", "run-1"), "C:/Users/hp/repo/.osa/chat-log/run-1.jsonl");
  assert.equal(chatLogGitignorePath("C:/Users/hp/repo"), "C:/Users/hp/repo/.osa/chat-log/.gitignore");
});
