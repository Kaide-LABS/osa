import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ExitCode, PrdLockViolationError } from "../domain/errors.ts";
import { renderBabyPrd } from "./baby-prd.ts";
import { MemoryEventSink } from "./events.ts";
import { assertPrdUnchanged, exitCodeForLockOutcome, lockBabyPrd, prdLockRecordPath, runGate, exitCodeForGateOutcome } from "./lock.ts";
import type { LockChoice, LockIO, GateIO } from "./lock.ts";
import { samplePrd, tempGitRepo } from "./fixtures.test.ts";
import { sha256String } from "../util/hash.ts";

async function setup(risky: boolean) {
  const repoDir = await tempGitRepo();
  const runId = randomUUID();
  const prdPath = `runs/${runId}/baby-prd.md`;
  await mkdir(`${repoDir}/runs/${runId}`, { recursive: true });
  const md = renderBabyPrd(samplePrd({ risky }));
  await writeFile(`${repoDir}/${prdPath}`, md, "utf8");
  return { repoDir, runId, prdPath, md, events: new MemoryEventSink(runId) };
}

function fakeIO(choices: LockChoice[], onEdit?: (abs: string) => Promise<void>): { io: LockIO; shown: string[]; edits: string[] } {
  const shown: string[] = [];
  const edits: string[] = [];
  const queue = [...choices];
  const io: LockIO = {
    show: (t) => void shown.push(t),
    choose: () => Promise.resolve(queue.shift() ?? "cancel"),
    edit: async (abs) => {
      edits.push(abs);
      await onEdit?.(abs);
    },
  };
  return { io, shown, edits };
}

test("interactive Lock: hashes the PRD, writes the lock record and logs prd_locked", async () => {
  const s = await setup(false);
  const { io, shown } = fakeIO(["lock"]);
  const out = await lockBabyPrd({ ...s, io, unattended: false, autoLockWhenNoRisky: true });
  assert.equal(out.kind, "locked");
  if (out.kind !== "locked") return;
  assert.equal(out.record.sha256, sha256String(s.md));
  assert.match(shown[0] ?? "", /## TL;DR/);
  const rec = JSON.parse(await readFile(prdLockRecordPath(s.repoDir, s.runId), "utf8")) as { sha256: string };
  assert.equal(rec.sha256, out.record.sha256);
  const ev = s.events.events.find((e) => e.event === "prd_locked");
  assert.equal(ev?.data["sha256"], out.record.sha256);
  assert.equal(exitCodeForLockOutcome(out), ExitCode.OK);
});

test("Cancel returns a cancelled outcome (exit 22) and writes no lock record", async () => {
  const s = await setup(false);
  const out = await lockBabyPrd({ ...s, io: fakeIO(["cancel"]).io, unattended: false, autoLockWhenNoRisky: true });
  assert.equal(out.kind, "cancelled");
  assert.equal(exitCodeForLockOutcome(out), ExitCode.LOCK_CANCELLED);
  await assert.rejects(readFile(prdLockRecordPath(s.repoDir, s.runId), "utf8"));
  assert.deepEqual(s.events.names(), ["prd_lock_cancelled"]);
});

test("Edit re-opens the file, re-shows the edited PRD, then locks the EDITED content", async () => {
  const s = await setup(false);
  const { io, shown, edits } = fakeIO(["edit", "lock"], async (abs) => {
    await writeFile(abs, (await readFile(abs, "utf8")).replace("Print a total", "Print a total and a breakdown"), "utf8");
  });
  const out = await lockBabyPrd({ ...s, io, unattended: false, autoLockWhenNoRisky: true });
  assert.equal(out.kind, "locked");
  assert.equal(edits.length, 1);
  assert.ok(shown.some((t) => t.includes("Print a total and a breakdown")), "the edited PRD is re-shown");
  if (out.kind === "locked") {
    assert.ok(out.prd.inScope.includes("Print a total and a breakdown"));
    assert.equal(out.record.sha256, sha256String(await readFile(`${s.repoDir}/${s.prdPath}`, "utf8")));
  }
});

test("a malformed edit is reported in plain language and the editor re-opens (no crash, no other question)", async () => {
  const s = await setup(false);
  let n = 0;
  const { io, shown, edits } = fakeIO(["edit", "lock"], async (abs) => {
    n += 1;
    await writeFile(abs, n === 1 ? "this is not a PRD" : s.md, "utf8");
  });
  const out = await lockBabyPrd({ ...s, io, unattended: false, autoLockWhenNoRisky: true });
  assert.equal(out.kind, "locked");
  assert.equal(edits.length, 2);
  assert.ok(shown.some((t) => /can't be used/.test(t)));
});

test("--yes with a risky assumption -> stops at the lock, no dispatch, exit 19 (WS2.4 test 2)", async () => {
  const s = await setup(true);
  const out = await lockBabyPrd({ ...s, io: fakeIO([]).io, unattended: true, autoLockWhenNoRisky: true });
  assert.equal(out.kind, "refused");
  if (out.kind === "refused") {
    assert.equal(out.risky.length, 1);
    assert.match(out.message, /1 risky assumption/);
  }
  assert.equal(exitCodeForLockOutcome(out), ExitCode.PRD_LOCK_REFUSED);
  await assert.rejects(readFile(prdLockRecordPath(s.repoDir, s.runId), "utf8"), "nothing was locked");
  assert.deepEqual(s.events.names(), ["prd_lock_refused"]);
});

test("--yes with zero risky assumptions auto-locks; autoLockWhenNoRisky=false never auto-locks", async () => {
  const a = await setup(false);
  assert.equal((await lockBabyPrd({ ...a, io: fakeIO([]).io, unattended: true, autoLockWhenNoRisky: true })).kind, "locked");
  const b = await setup(false);
  assert.equal((await lockBabyPrd({ ...b, io: fakeIO([]).io, unattended: true, autoLockWhenNoRisky: false })).kind, "refused");
});

test("locked PRD hash mismatch later in the run -> hard fail (WS2.4 test 3)", async () => {
  const s = await setup(false);
  await lockBabyPrd({ ...s, io: fakeIO(["lock"]).io, unattended: false, autoLockWhenNoRisky: true });
  const ok = await assertPrdUnchanged(s.repoDir, s.runId, "before phase 1", s.events);
  assert.equal(ok.run_id, s.runId);
  assert.ok(s.events.names().includes("prd_integrity_verified"));

  await writeFile(`${s.repoDir}/${s.prdPath}`, s.md + "\nSneaky extra requirement.\n", "utf8");
  await assert.rejects(assertPrdUnchanged(s.repoDir, s.runId, "after phase 1"), (e: unknown) => {
    assert.ok(e instanceof PrdLockViolationError);
    assert.equal(e.exitCode, ExitCode.PRD_LOCK_VIOLATION);
    assert.match(e.message, /changed after it was locked/);
    return true;
  });
});

test("assertPrdUnchanged hard-fails when the PRD was deleted or no lock record exists", async () => {
  const s = await setup(false);
  await assert.rejects(assertPrdUnchanged(s.repoDir, s.runId, "x"), PrdLockViolationError); // never locked
  await lockBabyPrd({ ...s, io: fakeIO(["lock"]).io, unattended: false, autoLockWhenNoRisky: true });
  await rm(`${s.repoDir}/${s.prdPath}`);
  await assert.rejects(assertPrdUnchanged(s.repoDir, s.runId, "x"), PrdLockViolationError);
});

// ---- runGate tests ----

function fakeGateIO(confirm: boolean): GateIO {
  const shown: string[] = [];
  return {
    show: (text) => void shown.push(text),
    confirm: () => Promise.resolve(confirm),
  };
}

test("runGate in auto-lock mode always locks, even with risky assumptions", async () => {
  const s = await setup(true); // risky=true
  const artifact = `${s.repoDir}/runs/${s.runId}/test-artifact.md`;
  await writeFile(artifact, "Test artifact content", "utf8");

  const outcome = await runGate({
    repoDir: s.repoDir,
    runId: s.runId,
    artifactPath: `runs/${s.runId}/test-artifact.md`,
    risky: [{ text: "Test risky assumption", risk: "risky" }],
    io: fakeGateIO(false),
    events: s.events,
    mode: { kind: "auto-lock" },
  });

  assert.equal(outcome.kind, "locked");
  assert.match(outcome.sha256, /^[0-9a-f]{64}$/);
  assert.ok(s.events.names().includes("prd_locked"));
});

test("runGate in unattended mode with acceptRisky=false refuses when risky assumptions exist", async () => {
  const s = await setup(true); // risky=true
  const artifact = `${s.repoDir}/runs/${s.runId}/test-artifact.md`;
  await writeFile(artifact, "Test artifact content", "utf8");

  const outcome = await runGate({
    repoDir: s.repoDir,
    runId: s.runId,
    artifactPath: `runs/${s.runId}/test-artifact.md`,
    risky: [{ text: "Test risky assumption", risk: "risky" }],
    io: fakeGateIO(false),
    events: s.events,
    mode: { kind: "unattended", acceptRisky: false },
  });

  assert.equal(outcome.kind, "refused");
  assert.equal(exitCodeForGateOutcome(outcome), ExitCode.PRD_LOCK_REFUSED);
  assert.ok(s.events.names().includes("prd_lock_refused"));
});

test("runGate in unattended mode with acceptRisky=true locks even with risky assumptions", async () => {
  const s = await setup(true); // risky=true
  const artifact = `${s.repoDir}/runs/${s.runId}/test-artifact.md`;
  await writeFile(artifact, "Test artifact content", "utf8");

  const outcome = await runGate({
    repoDir: s.repoDir,
    runId: s.runId,
    artifactPath: `runs/${s.runId}/test-artifact.md`,
    risky: [{ text: "Test risky assumption", risk: "risky" }],
    io: fakeGateIO(false),
    events: s.events,
    mode: { kind: "unattended", acceptRisky: true },
  });

  assert.equal(outcome.kind, "locked");
  assert.ok(s.events.names().includes("prd_locked"));
});

test("runGate in unattended mode locks when there are no risky assumptions", async () => {
  const s = await setup(false); // risky=false
  const artifact = `${s.repoDir}/runs/${s.runId}/test-artifact.md`;
  await writeFile(artifact, "Test artifact content", "utf8");

  const outcome = await runGate({
    repoDir: s.repoDir,
    runId: s.runId,
    artifactPath: `runs/${s.runId}/test-artifact.md`,
    risky: [],
    io: fakeGateIO(false),
    events: s.events,
    mode: { kind: "unattended", acceptRisky: false },
  });

  assert.equal(outcome.kind, "locked");
});

test("runGate in interactive mode locks on confirm=true", async () => {
  const s = await setup(false);
  const artifact = `${s.repoDir}/runs/${s.runId}/test-artifact.md`;
  await writeFile(artifact, "Test artifact content", "utf8");

  const outcome = await runGate({
    repoDir: s.repoDir,
    runId: s.runId,
    artifactPath: `runs/${s.runId}/test-artifact.md`,
    risky: [],
    io: fakeGateIO(true),
    events: s.events,
    mode: { kind: "interactive" },
  });

  assert.equal(outcome.kind, "locked");
  assert.equal(exitCodeForGateOutcome(outcome), ExitCode.OK);
});

test("runGate in interactive mode cancels on confirm=false", async () => {
  const s = await setup(false);
  const artifact = `${s.repoDir}/runs/${s.runId}/test-artifact.md`;
  await writeFile(artifact, "Test artifact content", "utf8");

  const outcome = await runGate({
    repoDir: s.repoDir,
    runId: s.runId,
    artifactPath: `runs/${s.runId}/test-artifact.md`,
    risky: [],
    io: fakeGateIO(false),
    events: s.events,
    mode: { kind: "interactive" },
  });

  assert.equal(outcome.kind, "cancelled");
  assert.equal(exitCodeForGateOutcome(outcome), ExitCode.LOCK_CANCELLED);
  assert.ok(s.events.names().includes("prd_lock_cancelled"));
});
