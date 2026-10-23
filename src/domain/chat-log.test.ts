// Implements PHASE_10_SPEC.md §1.1 (A2), §8 AC-U2 -- chat-log.test.ts
// Schema coverage: strictness, every refinement (CL1/CL2/CL3), round-trip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_LOG_ENTRY_KINDS, CHAT_LOG_SCHEMA_VERSION, ChatLogEntry, ChatLogEntryKindSchema, ChatLogOutcome, ChatLogTranscript } from "./chat-log.ts";
import { IsolationLeakError } from "./errors.ts";
import { FORBIDDEN_RELAY_KEY_PATTERN, assertNoTranscriptFields } from "./relay.ts";

function validPromptEntry(): unknown {
  return {
    schema_version: CHAT_LOG_SCHEMA_VERSION,
    written_at: "2026-09-06T00:00:00.000Z",
    chat_log_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    run_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    phase: 1,
    turn_index: 0,
    entry_kind: "prompt",
    role: "executor",
    provider: "claude-code",
    model_tier: "high-volume-low-effort",
    model_override: null,
    spec_ref: { path: "PHASE_1_SPEC.md", sha256: "9".repeat(64) },
    baby_prd_path: "baby_prd.md",
    context_path: "context.md",
    outcome: null,
    credential_shaped_content_detected: false,
    transcript: { prompt: "do the work", stdout: null, stderr: null },
  };
}

function validResponseEntry(): unknown {
  const base = validPromptEntry() as Record<string, unknown>;
  return {
    ...base,
    entry_kind: "response",
    outcome: {
      ok: true,
      exit_code: 0,
      signal: null,
      timed_out: false,
      duration_ms: 1234,
      failure_message: null,
    },
    transcript: { prompt: null, stdout: "out", stderr: "" },
  };
}

test("CHAT_LOG_ENTRY_KINDS has exactly two members", () => {
  assert.deepEqual(CHAT_LOG_ENTRY_KINDS, ["prompt", "response"]);
});

test("ChatLogEntryKindSchema accepts both kinds and rejects anything else", () => {
  assert.equal(ChatLogEntryKindSchema.safeParse("prompt").success, true);
  assert.equal(ChatLogEntryKindSchema.safeParse("response").success, true);
  assert.equal(ChatLogEntryKindSchema.safeParse("reasoning").success, false);
});

test("ChatLogTranscript (z.strictObject) rejects an unknown extra key", () => {
  const result = ChatLogTranscript.safeParse({ prompt: "p", stdout: null, stderr: null, extra: "x" });
  assert.equal(result.success, false);
});

test("ChatLogTranscript has no length cap on any field (PRD I7)", () => {
  const big = "x".repeat(2_000_000);
  const result = ChatLogTranscript.safeParse({ prompt: big, stdout: null, stderr: null });
  assert.equal(result.success, true);
});

test("ChatLogOutcome (z.strictObject) rejects an unknown extra key", () => {
  const result = ChatLogOutcome.safeParse({
    ok: true,
    exit_code: 0,
    signal: null,
    timed_out: false,
    duration_ms: 0,
    failure_message: null,
    extra: "x",
  });
  assert.equal(result.success, false);
});

test("ChatLogEntry (z.strictObject) rejects an unknown top-level extra key", () => {
  const raw = { ...(validPromptEntry() as Record<string, unknown>), extra: "x" };
  assert.equal(ChatLogEntry.safeParse(raw).success, false);
});

test("ChatLogEntry accepts a valid prompt entry", () => {
  const result = ChatLogEntry.safeParse(validPromptEntry());
  assert.equal(result.success, true);
});

test("ChatLogEntry accepts a valid response entry", () => {
  const result = ChatLogEntry.safeParse(validResponseEntry());
  assert.equal(result.success, true);
});

test("ChatLogEntry rejects schema_version other than 1", () => {
  const raw = { ...(validPromptEntry() as Record<string, unknown>), schema_version: 2 };
  assert.equal(ChatLogEntry.safeParse(raw).success, false);
});

test("CL1: entry_kind === 'prompt' requires transcript.prompt !== null", () => {
  const raw = validPromptEntry() as Record<string, unknown>;
  raw["transcript"] = { prompt: null, stdout: null, stderr: null };
  const result = ChatLogEntry.safeParse(raw);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.message.includes("CL1")));
  }
});

test("CL1: entry_kind === 'response' must not carry transcript.prompt", () => {
  const raw = validResponseEntry() as Record<string, unknown>;
  raw["transcript"] = { prompt: "leaked", stdout: "out", stderr: "" };
  const result = ChatLogEntry.safeParse(raw);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.message.includes("CL1")));
  }
});

test("CL2: entry_kind === 'response' requires both transcript.stdout and transcript.stderr non-null", () => {
  const raw = validResponseEntry() as Record<string, unknown>;
  raw["transcript"] = { prompt: null, stdout: "out", stderr: null };
  const result = ChatLogEntry.safeParse(raw);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.message.includes("CL2")));
  }
});

test("CL3: entry_kind === 'prompt' requires outcome === null", () => {
  const raw = validPromptEntry() as Record<string, unknown>;
  raw["outcome"] = {
    ok: true,
    exit_code: 0,
    signal: null,
    timed_out: false,
    duration_ms: 1,
    failure_message: null,
  };
  const result = ChatLogEntry.safeParse(raw);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.message.includes("CL3")));
  }
});

test("CL3: entry_kind === 'response' requires outcome !== null", () => {
  const raw = validResponseEntry() as Record<string, unknown>;
  raw["outcome"] = null;
  const result = ChatLogEntry.safeParse(raw);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.message.includes("CL3")));
  }
});

// Implements PHASE_10_SPEC.md §7.3 FM16, §3.4 -- the `transcript` key is a live tripwire, not just
// a comment: it matches the relay's own isolation denylist, so a ChatLogEntry accidentally merged
// into a relay payload is rejected before it could ever cross the isolation boundary.

test("the ChatLogEntry payload key 'transcript' matches FORBIDDEN_RELAY_KEY_PATTERN", () => {
  assert.equal(FORBIDDEN_RELAY_KEY_PATTERN.test("transcript"), true);
});

test("passing a constructed ChatLogEntry to assertNoTranscriptFields throws IsolationLeakError", () => {
  const entry = ChatLogEntry.parse(validPromptEntry());
  assert.throws(() => {
    assertNoTranscriptFields(entry);
  }, IsolationLeakError);
});

test("ChatLogEntry round-trips through JSON.stringify/JSON.parse unchanged", () => {
  const parsed = ChatLogEntry.parse(validResponseEntry());
  const roundTripped: unknown = JSON.parse(JSON.stringify(parsed));
  assert.deepEqual(roundTripped, parsed);
});
