// OSA's ONE global memory database (docs/osa/memory-phase1/PRD.md): `~/.osa/memory.db`, a single SQLite file that
// survives across projects and runs. Storage is Node's built-in `node:sqlite` (`DatabaseSync`) with FTS5 + bm25 -- no
// new dependency, no embeddings. This module owns the connection: open-or-create, the schema, the migration runner, the
// FTS5 availability check, and close. It is loaded LAZILY (a dynamic import from `memory.ts`) so that with the memory
// feature unused no `node:sqlite` module is reachable from any entry point's static import graph.
//
// Tables (PRD step 1): `sources`, `chunks`, `snapshots` (index history), `sessions` (chat sessions), `facts`. Only
// `facts` has a write path now; the others carry schema only. Every table has `id TEXT PRIMARY KEY`, `updated_at`
// (ISO) and `deleted_at` (nullable); `facts` and `chunks` also carry `project`, `source`, `created_at`. The
// soft-delete column exists for later export/import/sync; `forget` physically purges.

import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Current schema version. One migration today; the runner and the `schema_version` table exist so later ones drop in. */
export const SCHEMA_VERSION = 1;

/**
 * The resolved path of the global memory database: the explicit `path`, else `OSA_MEMORY_DB`, else `~/.osa/memory.db`.
 * Tests MUST pass an explicit temp path (or set `OSA_MEMORY_DB`) so the real home directory is never written. Pure given
 * its inputs.
 */
export function resolveMemoryDbPath(path?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path !== undefined && path.trim() !== "") return path;
  const fromEnv = env["OSA_MEMORY_DB"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  return join(homedir(), ".osa", "memory.db");
}

/** An open global-memory database. A thin wrapper so callers never touch `node:sqlite` directly. */
export interface MemoryDb {
  readonly db: DatabaseSync;
  readonly path: string;
  close(): void;
}

/** Raised when the database cannot be opened or is unusable. Never carries any stored fact text. */
export class MemoryDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryDbError";
  }
}

/** Confirms FTS5 is compiled into this `node:sqlite` build; throws a clear {@link MemoryDbError} if it is not. */
function assertFts5(db: DatabaseSync): void {
  try {
    db.exec("CREATE VIRTUAL TABLE temp._osa_fts5_probe USING fts5(x)");
    db.exec("DROP TABLE temp._osa_fts5_probe");
  } catch {
    throw new MemoryDbError("this Node.js build has no SQLite FTS5 support, which OSA memory requires (expected in Node 22+)");
  }
}

const MIGRATION_1 = `
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT,
  locator TEXT,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  source TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  project TEXT,
  created_at TEXT,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project TEXT,
  created_at TEXT,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX facts_project_idx ON facts(project);

CREATE VIRTUAL TABLE facts_fts USING fts5(id UNINDEXED, text);
CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(id, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
  DELETE FROM facts_fts WHERE id = old.id;
END;
CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
  DELETE FROM facts_fts WHERE id = old.id;
  INSERT INTO facts_fts(id, text) VALUES (new.id, new.text);
END;

CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED, text);
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(id, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE id = old.id;
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE id = old.id;
  INSERT INTO chunks_fts(id, text) VALUES (new.id, new.text);
END;
`;

/** Runs every migration past the recorded version inside one transaction. Idempotent: a current database is untouched. */
function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  const current = row.v ?? 0;
  if (current >= SCHEMA_VERSION) return;
  db.exec("BEGIN");
  try {
    if (current < 1) db.exec(MIGRATION_1);
    db.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, new Date().toISOString());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Opens (creating if absent) the global memory database, verifies FTS5, applies migrations, and returns a handle.
 * WAL mode and a busy timeout make concurrent saves from two processes safe (FM-E). On POSIX the file is restricted to
 * the owner; on Windows OSA relies on the per-user profile folder (documented in docs/osa/MEMORY.md). Errors are clean
 * and never include any stored fact text (a corrupt or unreadable file surfaces as a {@link MemoryDbError}, FM-F).
 */
export function openMemoryDb(path?: string, env: NodeJS.ProcessEnv = process.env): MemoryDb {
  const resolved = resolveMemoryDbPath(path, env);
  try {
    mkdirSync(dirname(resolved), { recursive: true });
  } catch {
    // directory may already exist; a real failure surfaces below when the file cannot be opened
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(resolved);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    assertFts5(db);
    migrate(db);
  } catch (e) {
    if (e instanceof MemoryDbError) throw e;
    throw new MemoryDbError(`the memory database at ${resolved} could not be opened (it may be corrupt or unreadable)`);
  }
  try {
    if (process.platform !== "win32") chmodSync(resolved, 0o600);
  } catch {
    // best-effort; some filesystems reject chmod
  }
  return {
    db,
    path: resolved,
    close(): void {
      db.close();
    },
  };
}
