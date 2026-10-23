// Implements PHASE_1_SPEC.md §1.6 -- relay.test.ts
// Covers §8 acceptance criteria #19, #20, #21.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { IsolationLeakError, RelaySchemaError } from "./errors.ts";
import {
  assertNoTranscriptFields,
  FORBIDDEN_RELAY_KEY_PATTERN,
  parseHandoffRecord,
  readHandoffRecord,
  RELAY_SCHEMA_VERSION,
  serialiseHandoffRecord,
  writeHandoffRecord,
} from "./relay.ts";
import type { HandoffRecord } from "./relay.ts";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

function validRecord(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    phase: 1,
    turn_index: 0,
    role: "executor",
    provider: "claude-code",
    model_tier: "high-volume-low-effort",
    started_at: "2026-08-16T10:00:00Z",
    completed_at: "2026-08-16T10:05:00Z",
    repo: {
      branch: "main",
      head_before: OID_A,
      head_after: OID_B,
      commits: [OID_B],
    },
    spec_ref: { path: "PHASE_1_SPEC.md", sha256: SHA_C },
    artifacts_read: [],
    artifacts_written: [{ path: "src/domain/relay.ts", sha256: SHA_D }],
    status: "completed",
    work_done: "Implemented the relay schema.",
    next_steps: [],
    open_questions: [],
    halt: null,
    ...overrides,
  };
}

test("HandoffRecord accepts a fully-populated valid record", () => {
  const rec = parseHandoffRecord(validRecord());
  assert.equal(rec.schema_version, 1);
  assert.equal(rec.provider, "claude-code");
});

test("rejects a missing required field", () => {
  const raw = validRecord();
  delete raw["work_done"];
  assert.throws(() => parseHandoffRecord(raw), RelaySchemaError);
});

test("rejects schema_version: 2 with a dedicated RelaySchemaError (exit 4), never falling through to zod", () => {
  const raw = validRecord({ schema_version: 2 });
  assert.throws(
    () => parseHandoffRecord(raw),
    (err: unknown) => {
      assert.ok(err instanceof RelaySchemaError);
      assert.equal(err.exitCode, 4);
      assert.equal(err.details["expected"], RELAY_SCHEMA_VERSION);
      assert.equal(err.details["found"], 2);
      return true;
    },
  );
});

test("rejects an unknown extra key (z.strictObject)", () => {
  const raw = validRecord({ unexpected_extra_field: "nope" });
  assert.throws(() => parseHandoffRecord(raw), RelaySchemaError);
});

test("R1: rejects completed_at < started_at", () => {
  const raw = validRecord({ started_at: "2026-08-16T10:05:00Z", completed_at: "2026-08-16T10:00:00Z" });
  assert.throws(() => parseHandoffRecord(raw), RelaySchemaError);
});

test('R2: rejects status "halted" with halt: null', () => {
  const raw = validRecord({ status: "halted", halt: null });
  assert.throws(() => parseHandoffRecord(raw), RelaySchemaError);
});

test('R2: rejects status "completed" with a non-null halt', () => {
  const raw = validRecord({ halt: { code: "SOME_CODE", message: "should not be here" } });
  assert.throws(() => parseHandoffRecord(raw), RelaySchemaError);
});

test('R3: rejects status "completed" with commits: []', () => {
  const raw = validRecord({
    repo: { branch: "main", head_before: OID_A, head_after: OID_B, commits: [] },
  });
  assert.throws(() => parseHandoffRecord(raw), RelaySchemaError);
});

test('R3 is deferred, and ONLY R3, when parsing an agent draft with { draft: true }', () => {
  // A real codex-cli turn under `--sandbox workspace-git-blocked` honestly writes exactly this:
  // it finished the work, could not commit, and reports zero commits. runTurn() step 5.5 has
  // already made the commit on its behalf by the time this parse happens, and step 7's
  // reconciliation is what applies R3 against the repository's real history -- so refusing the
  // draft here would make the fallback unreachable for the one case it exists to serve.
  const zeroCommits = validRecord({
    repo: { branch: "main", head_before: OID_A, head_after: OID_A, commits: [] },
  });
  const parsed = parseHandoffRecord(zeroCommits, { draft: true });
  assert.equal(parsed.status, "completed");
  assert.deepStrictEqual(parsed.repo.commits, []);

  // R1 and R2 constrain genuinely agent-authored fields that survive reconciliation untouched, so
  // they are still enforced in draft mode -- the deferral is scoped to R3 alone.
  assert.throws(
    () => parseHandoffRecord(validRecord({ started_at: "2026-08-16T11:00:00Z", completed_at: "2026-08-16T10:00:00Z" }), { draft: true }),
    RelaySchemaError,
  );
  assert.throws(() => parseHandoffRecord(validRecord({ status: "halted", halt: null }), { draft: true }), RelaySchemaError);
  // As is every ordinary shape rule.
  assert.throws(() => parseHandoffRecord(validRecord({ work_done: "" }), { draft: true }), RelaySchemaError);
});

test("parseHandoffRecord defaults to the full R3-inclusive schema when no options are passed", () => {
  const raw = validRecord({
    repo: { branch: "main", head_before: OID_A, head_after: OID_B, commits: [] },
  });
  assert.throws(() => parseHandoffRecord(raw, {}), RelaySchemaError);
  assert.throws(() => parseHandoffRecord(raw, { draft: false }), RelaySchemaError);
});

test("rejects an absolute path in artifacts_read", () => {
  const raw = validRecord({ artifacts_read: [{ path: "/etc/passwd", sha256: SHA_D }] });
  assert.throws(() => parseHandoffRecord(raw), RelaySchemaError);
});

test("rejects a Windows drive-absolute path in artifacts_read", () => {
  const raw = validRecord({ artifacts_read: [{ path: "C:/etc/passwd", sha256: SHA_D }] });
  assert.throws(() => parseHandoffRecord(raw), RelaySchemaError);
});

test("rejects a .. traversal in spec_ref.path", () => {
  const raw = validRecord({ spec_ref: { path: "../../etc/passwd", sha256: SHA_C } });
  assert.throws(() => parseHandoffRecord(raw), RelaySchemaError);
});

test("rejects a 41-character GitOid", () => {
  const raw = validRecord({
    repo: { branch: "main", head_before: OID_A, head_after: `${OID_B}f`, commits: [`${OID_B}f`] },
  });
  assert.throws(() => parseHandoffRecord(raw), RelaySchemaError);
});

test("accepts a 64-character GitOid (sha256 object format repos)", () => {
  const oid64 = "f".repeat(64);
  const raw = validRecord({
    repo: { branch: "main", head_before: OID_A, head_after: oid64, commits: [oid64] },
  });
  const rec = parseHandoffRecord(raw);
  assert.equal(rec.repo.head_after, oid64);
});

test("a nested transcript-shaped key throws IsolationLeakError (exit 5) naming PRD §6.4", () => {
  const raw = validRecord({ meta: { transcript: "the whole conversation..." } });
  assert.throws(
    () => parseHandoffRecord(raw),
    (err: unknown) => {
      assert.ok(err instanceof IsolationLeakError);
      assert.equal(err.exitCode, 5);
      assert.match(err.message, /§6\.4/);
      return true;
    },
  );
});

test("a top-level transcript-shaped key also throws IsolationLeakError", () => {
  const raw = validRecord({ reasoning: "chain of thought here" });
  assert.throws(() => parseHandoffRecord(raw), IsolationLeakError);
});

test("isolation check runs before schema validation (a transcript key + an otherwise-invalid record still reports isolation)", () => {
  const raw = validRecord({ schema_version: 2, history: ["a", "b"] });
  assert.throws(() => parseHandoffRecord(raw), IsolationLeakError);
});

test("FORBIDDEN_RELAY_KEY_PATTERN matches the documented denylist terms", () => {
  for (const term of [
    "transcript",
    "conversation",
    "reasoning",
    "chain_of_thought",
    "chain-of-thought",
    "rationale",
    "thinking",
    "scratchpad",
    "messages",
    "history",
    "justification",
  ]) {
    assert.ok(FORBIDDEN_RELAY_KEY_PATTERN.test(term), `expected pattern to match "${term}"`);
  }
});

test("assertNoTranscriptFields does not hang on deeply nested input (depth cap)", () => {
  let nested: unknown = { safe_leaf: true };
  for (let i = 0; i < 50; i++) {
    nested = { child: nested };
  }
  assert.doesNotThrow(() => {
    assertNoTranscriptFields(nested);
  });
});

test("rejects non-object input", () => {
  assert.throws(() => parseHandoffRecord("not an object"), RelaySchemaError);
  assert.throws(() => parseHandoffRecord(null), RelaySchemaError);
  assert.throws(() => parseHandoffRecord([1, 2, 3]), RelaySchemaError);
});

test("serialiseHandoffRecord -> parseHandoffRecord round-trips deep-equal", () => {
  const rec = parseHandoffRecord(validRecord());
  const serialised = serialiseHandoffRecord(rec);
  const roundTripped = parseHandoffRecord(JSON.parse(serialised));
  assert.deepStrictEqual(roundTripped, rec);
});

test("serialiseHandoffRecord ends with a trailing newline and stable key order", () => {
  const rec = parseHandoffRecord(validRecord());
  const serialised = serialiseHandoffRecord(rec);
  assert.ok(serialised.endsWith("\n"));
  const parsed: unknown = JSON.parse(serialised);
  assert.deepStrictEqual(Object.keys(parsed as Record<string, unknown>), [
    "schema_version",
    "run_id",
    "phase",
    "turn_index",
    "role",
    "provider",
    "model_tier",
    "started_at",
    "completed_at",
    "repo",
    "spec_ref",
    "artifacts_read",
    "artifacts_written",
    "status",
    "work_done",
    "next_steps",
    "open_questions",
    "halt",
  ]);
});

test("writeHandoffRecord -> readHandoffRecord round-trips through the filesystem", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-relay-test-`);
  try {
    const rec: HandoffRecord = parseHandoffRecord(validRecord());
    const filePath = `${dir}/handoff.json`;
    await writeHandoffRecord(filePath, rec);
    const readBack = await readHandoffRecord(filePath);
    assert.deepStrictEqual(readBack, rec);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("REGRESSION: readHandoffRecord accepts a UTF-8 BOM (Codex CLI on Windows writes one) -- it used to fail 'Unexpected token' at char 0", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-relay-test-`);
  try {
    const rec: HandoffRecord = parseHandoffRecord(validRecord());
    const filePath = `${dir}/bom.json`;
    const { writeFile } = await import("node:fs/promises");
    const { serialiseHandoffRecord } = await import("./relay.ts");
    await writeFile(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(serialiseHandoffRecord(rec), "utf8")]));
    assert.deepStrictEqual(await readHandoffRecord(filePath), rec);
    // a BOM is only forgiven at the very start: garbage after it is still a schema error
    await writeFile(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{ nope", "utf8")]));
    await assert.rejects(() => readHandoffRecord(filePath), RelaySchemaError);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("readHandoffRecord surfaces a JSON parse failure as RelaySchemaError, not InternalError", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-relay-test-`);
  try {
    const filePath = `${dir}/bad.json`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, "{ not valid json", "utf8");
    await assert.rejects(() => readHandoffRecord(filePath), RelaySchemaError);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a DRAFT with a malformed self-reported artifact hash still parses (the harness replaces the claim with ground truth); a PERSISTED record with one is still refused; the path is still checked (found by the live e2e run: a 62-character sha256 stopped a finished build)", () => {
  const bad = { path: "pyproject.toml", sha256: "8f7b7bd83ecf6cb71bb74481f356a3f6e686dd74310e125b5a9f5feb835b0" };
  const rec = validRecord({ artifacts_read: [bad, { path: "ok.py", sha256: "a".repeat(64) }], artifacts_written: [{ path: "x.py", sha256: "<sha256 of x.py>" }] });
  const draft = parseHandoffRecord(rec, { draft: true });
  assert.equal(draft.artifacts_read[0]?.sha256, "0".repeat(64), "the unusable claim became a placeholder");
  assert.equal(draft.artifacts_read[1]?.sha256, "a".repeat(64), "a well-formed claim is left alone");
  assert.equal(draft.artifacts_written[0]?.sha256, "0".repeat(64));
  assert.throws(() => parseHandoffRecord(rec), RelaySchemaError, "a persisted record is never repaired");
  assert.throws(() => parseHandoffRecord(validRecord({ artifacts_read: [{ path: "", sha256: "bad" }] }), { draft: true }), RelaySchemaError, "an empty path is still a schema error");
});
