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

test("FM-F: a corrupt database file surfaces a clean MemoryDbError, not a raw sqlite crash", async () => {
  const path = await tempDbPath();
  await writeFile(path, "this is not a sqlite database at all, just text\n".repeat(50));
  assert.throws(() => openMemoryDb(path), (e: unknown) => e instanceof MemoryDbError);
});
