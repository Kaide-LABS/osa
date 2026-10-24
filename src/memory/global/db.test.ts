// The global memory database (docs/osa/memory-phase1/SPEC.md): open-or-create, the schema and migration runner, the
// FTS5 availability check, path resolution, and the corrupt-file failure mode (FM-F). Every test uses a temp path and
// never touches the real home directory (FM-H).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDbError, SCHEMA_VERSION, openMemoryDb, resolveMemoryDbPath } from "./db.ts";

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "osa-gmem-"));
  return join(dir, "memory.db");
}

test("FM-H: path resolution prefers the explicit path, then OSA_MEMORY_DB, then ~/.osa/memory.db -- no write happens here", () => {
  assert.equal(resolveMemoryDbPath("C:/tmp/x.db", {}), "C:/tmp/x.db");
  assert.equal(resolveMemoryDbPath(undefined, { OSA_MEMORY_DB: "C:/tmp/env.db" }), "C:/tmp/env.db");
  const def = resolveMemoryDbPath(undefined, {});
  assert.match(def, /[\\/]\.osa[\\/]memory\.db$/, "the default lives under the home profile's .osa");
  assert.equal(resolveMemoryDbPath("  ", { OSA_MEMORY_DB: "C:/tmp/env.db" }), "C:/tmp/env.db", "a blank explicit path falls through to the env");
});

test("FM-H guard: under the test runner, the real-home default is refused unless OSA_MEMORY_DB or an explicit path is given", () => {
  // The guard keys on NODE_TEST_CONTEXT in the PASSED env, so a pure resolution test with its own env map is unaffected.
  assert.throws(() => resolveMemoryDbPath(undefined, { NODE_TEST_CONTEXT: "child-v8" }), (e: unknown) => e instanceof MemoryDbError && /test runner/.test((e as Error).message));
  assert.equal(resolveMemoryDbPath(undefined, { NODE_TEST_CONTEXT: "child-v8", OSA_MEMORY_DB: "C:/tmp/env.db" }), "C:/tmp/env.db", "an explicit OSA_MEMORY_DB is allowed under the test runner");
  assert.equal(resolveMemoryDbPath("C:/tmp/x.db", { NODE_TEST_CONTEXT: "child-v8" }), "C:/tmp/x.db", "an explicit path is allowed under the test runner");
  assert.match(resolveMemoryDbPath(undefined, {}), /[\\/]\.osa[\\/]memory\.db$/, "outside the test runner the default resolves normally");
});

test("open creates the database with all five tables, the FTS mirror, and the recorded schema version", () => {
  return (async () => {
    const path = await tempDbPath();
    const mem = openMemoryDb(path);
    try {
      const tables = (mem.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      for (const t of ["sources", "chunks", "snapshots", "sessions", "facts", "schema_version"]) assert.ok(tables.includes(t), `table ${t} exists`);
      assert.ok(tables.includes("facts_fts") || (mem.db.prepare("SELECT name FROM sqlite_master WHERE name='facts_fts'").get() !== undefined), "the FTS mirror exists");
      const v = mem.db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
      assert.equal(v.v, SCHEMA_VERSION);
    } finally {
      mem.close();
    }
  })();
});

test("migration is idempotent: re-opening an existing database applies nothing new and keeps the data", async () => {
  const path = await tempDbPath();
  const a = openMemoryDb(path);
  a.db.prepare("INSERT INTO facts(id, project, kind, source, text, created_at, updated_at, deleted_at) VALUES ('id1','p','fact',NULL,'hello world','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',NULL)").run();
  a.close();
  const b = openMemoryDb(path);
  try {
    const rows = b.db.prepare("SELECT COUNT(*) AS c FROM schema_version").get() as { c: number };
    assert.equal(rows.c, 1, "the migration row was not applied a second time");
    const fact = b.db.prepare("SELECT text FROM facts WHERE id='id1'").get() as { text: string };
    assert.equal(fact.text, "hello world");
    const fts = b.db.prepare("SELECT COUNT(*) AS c FROM facts_fts WHERE facts_fts MATCH 'hello'").get() as { c: number };
    assert.equal(fts.c, 1, "the insert trigger populated the FTS mirror");
  } finally {
    b.close();
  }
});

test("migration 3 adds research_items and upgrades a version-2 database in place, keeping its facts", async () => {
  const path = await tempDbPath();
  const a = openMemoryDb(path);
  // Simulate a database left at version 2 (before documentation reuse): drop the v3 table and roll the recorded version back.
  a.db.prepare("INSERT INTO facts(id, project, kind, source, text, created_at, updated_at, deleted_at) VALUES ('id1','p','fact',NULL,'kept across upgrade','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',NULL)").run();
  a.db.exec("DROP TABLE research_items");
  a.db.prepare("DELETE FROM schema_version WHERE version >= 3").run();
  a.db.prepare("INSERT INTO schema_version(version, applied_at) VALUES (2, '2026-01-01T00:00:00Z')").run();
  a.close();

  const b = openMemoryDb(path);
  try {
    const v = b.db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    assert.equal(v.v, SCHEMA_VERSION, "the version-2 database was upgraded to the current version in place");
    const cols = (b.db.prepare("PRAGMA table_info(research_items)").all() as { name: string }[]).map((r) => r.name);
    for (const c of ["id", "dkey", "title", "result", "check_level", "project", "created_at", "updated_at", "deleted_at"]) assert.ok(cols.includes(c), `research_items.${c} exists`);
    const fact = b.db.prepare("SELECT text FROM facts WHERE id='id1'").get() as { text: string };
    assert.equal(fact.text, "kept across upgrade", "existing facts survive the upgrade");
  } finally {
    b.close();
  }
});

test("FM-F: a corrupt database file surfaces a clean MemoryDbError, not a raw sqlite crash", async () => {
  const path = await tempDbPath();
  await writeFile(path, "this is not a sqlite database at all, just text\n".repeat(50));
  assert.throws(() => openMemoryDb(path), (e: unknown) => e instanceof MemoryDbError);
});
