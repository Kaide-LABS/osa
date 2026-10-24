// Phase 2, pipeline level: a run captures its facts into the global store (on by default), the capture is fail-soft, and
// with the switch off nothing is written and the database file is never created. Every run points OSA_MEMORY_DB at a temp
// path, so the real home directory is never touched (the FM-H guard would refuse it anyway).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrdLockViolationError } from "../domain/errors.ts";
import { OsaConfig } from "../domain/osa-config.ts";
import { MinIntervalLimiter } from "../research/net/http.ts";
import { openMemoryDb } from "../memory/global/db.ts";
import { MemoryEventSink } from "./events.ts";
import type { OsaEvent } from "./events.ts";
import { fakeModel, researchFetch, tempGitRepo } from "./fixtures.test.ts";
import { runOsaCommand } from "./pipeline.ts";
import type { OsaDeps } from "./pipeline.ts";
import type { OsaRunReport } from "./pipeline.ts";

const RUN_ID = "84ef52b0-9999-4999-8999-999999999999";
const io = { show: () => undefined, choose: () => Promise.resolve("lock" as const), edit: () => Promise.resolve() };

function deps(repoDir: string, events: MemoryEventSink, over: Partial<OsaDeps> = {}): OsaDeps {
  return {
    events,
    io,
    interactive: true,
    runId: RUN_ID,
    config: OsaConfig.parse({ agents: { application: false } }),
    textCall: fakeModel().call,
    research: { http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
    drive: { runDispatchFn: (() => Promise.resolve({ ok: true, exitCode: 0, turns: [], halt: null, problems: [], warnings: [] })) as never },
    ...over,
  };
}

const runOpts = (repoDir: string) => ({ prompt: "make me a word counter", files: [], repoDir, yes: true, json: false, build: false });

async function withEnv<T>(path: string | null, fn: () => Promise<T>): Promise<T> {
  const prev = process.env["OSA_MEMORY_DB"];
  if (path === null) delete process.env["OSA_MEMORY_DB"];
  else process.env["OSA_MEMORY_DB"] = path;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env["OSA_MEMORY_DB"];
    else process.env["OSA_MEMORY_DB"] = prev;
  }
}

function globalEvents(events: MemoryEventSink): OsaEvent[] {
  return events.events.filter((e) => e.event === "global_memory_written" || e.event === "global_memory_failed");
}

test("capture on (the default): a run's facts land in the global store and global_memory_written carries counts, no fact text", async () => {
  const repoDir = await tempGitRepo();
  const dbDir = await mkdtemp(join(tmpdir(), "osa-gcap-"));
  const dbPath = join(dbDir, "memory.db");
  const events = new MemoryEventSink(RUN_ID);
  await withEnv(dbPath, async () => {
    const report = await runOsaCommand(runOpts(repoDir), deps(repoDir, events));
    assert.equal(report.ok, true, report.problems.join("; "));
  });
  const written = events.events.find((e) => e.event === "global_memory_written");
  assert.ok(written !== undefined, "global_memory_written was emitted");
  assert.ok(typeof written.data["saved"] === "number" && (written.data["saved"] as number) >= 1, "at least one fact saved");
  assert.deepEqual(Object.keys(written.data).sort(), ["deduped", "reasons", "redacted", "refused", "saved", "truncated"], "counts and reason classes only");
  const payload = JSON.stringify(written.data);
  assert.ok(!/word counter|Goal:/i.test(payload), "the event never carries fact text or the goal");
  const mem = openMemoryDb(dbPath);
  try {
    const n = (mem.db.prepare("SELECT COUNT(*) AS c FROM facts WHERE deleted_at IS NULL").get() as { c: number }).c;
    assert.ok(n >= 1, "facts were stored");
    const note = mem.db.prepare("SELECT text FROM facts WHERE kind='note'").get() as { text: string } | undefined;
    assert.match(note?.text ?? "", /^Run finished \(spec only, nothing built\)\./, "a run that built nothing says so instead of reporting phase counts");
    assert.ok(!/Phases passed|nmet requirements/.test(note?.text ?? ""));
  } finally {
    mem.close();
  }
});

test("FM-E: capture off -- no global_memory event, and the database file is never created", async () => {
  const repoDir = await tempGitRepo();
  const dbDir = await mkdtemp(join(tmpdir(), "osa-gcap-off-"));
  const dbPath = join(dbDir, "memory.db");
  const events = new MemoryEventSink(RUN_ID);
  await withEnv(dbPath, async () => {
    // This test is scoped to capture being off; reuse is a separate feature (on by default) that would otherwise open the store, so it is off here too.
    const report = await runOsaCommand(runOpts(repoDir), deps(repoDir, events, { config: OsaConfig.parse({ agents: { application: false }, memory: { global: { capture: false, reuse: { enabled: false } } } }) }));
    assert.equal(report.ok, true, report.problems.join("; "));
  });
  assert.deepEqual(globalEvents(events), [], "no global memory event at all");
  assert.equal(existsSync(dbPath), false, "the database file was never created");
});

test("FM-A: a corrupt database -- the run still finishes and exactly one global_memory_failed (corrupt) is emitted", async () => {
  const repoDir = await tempGitRepo();
  const dbDir = await mkdtemp(join(tmpdir(), "osa-gcap-bad-"));
  const dbPath = join(dbDir, "memory.db");
  await writeFile(dbPath, "this is not a sqlite database at all\n".repeat(40));
  const events = new MemoryEventSink(RUN_ID);
  let report: OsaRunReport | undefined;
  await withEnv(dbPath, async () => {
    report = await runOsaCommand(runOpts(repoDir), deps(repoDir, events));
  });
  assert.equal(report?.ok, true, "the run is unaffected by the capture failure");
  const failed = events.events.filter((e) => e.event === "global_memory_failed");
  assert.equal(failed.length, 1, "exactly one failed event");
  assert.equal(failed[0]?.data["reason"], "corrupt");
  assert.ok(!events.names().includes("global_memory_written"), "no written event when the store is unreachable");
});

test("a run that stops by an exception after the lock is captured too, as stopped, with fixed words and no error text", async () => {
  const repoDir = await tempGitRepo();
  const dbDir = await mkdtemp(join(tmpdir(), "osa-gcap-stop-"));
  const dbPath = join(dbDir, "memory.db");
  const events = new MemoryEventSink(RUN_ID);
  const base = fakeModel();
  const tamper: typeof base.call = async (provider, req, purpose) => {
    if (purpose === "github-lookup-summary") {
      const p = `${repoDir}/runs/${RUN_ID}/baby-prd.md`;
      await writeFile(p, `${await readFile(p, "utf8")}\nSneaky new requirement.\n`, "utf8");
    }
    return base.call(provider, req, purpose);
  };
  await withEnv(dbPath, async () => {
    await assert.rejects(runOsaCommand(runOpts(repoDir), deps(repoDir, events, { textCall: tamper })), (e: unknown) => e instanceof PrdLockViolationError);
  });
  const written = events.events.find((e) => e.event === "global_memory_written");
  assert.ok(written !== undefined, "the stopped run was captured");
  const mem = openMemoryDb(dbPath);
  try {
    const note = mem.db.prepare("SELECT text FROM facts WHERE kind='note'").get() as { text: string } | undefined;
    assert.match(note?.text ?? "", /^Run stopped \(The run was stopped because the locked PRD was changed after the lock\.\)\./);
    assert.ok(!/Sneaky/.test(JSON.stringify(mem.db.prepare("SELECT text FROM facts").all())), "no text from the error or the tampered file");
  } finally {
    mem.close();
  }
});

test("a stop by exception before the lock is not captured (there is nothing locked to remember)", async () => {
  const repoDir = await tempGitRepo();
  const dbPath = join(await mkdtemp(join(tmpdir(), "osa-gcap-pre-")), "memory.db");
  const events = new MemoryEventSink(RUN_ID);
  await withEnv(dbPath, async () => {
    await assert.rejects(runOsaCommand(runOpts(repoDir), deps(repoDir, events, { textCall: () => Promise.reject(new Error("the provider is down")) })));
  });
  assert.deepEqual(globalEvents(events), []);
  assert.equal(existsSync(dbPath), false);
});
