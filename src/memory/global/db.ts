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

/** Current schema version. The runner and the `schema_version` table let later migrations drop in. */
export const SCHEMA_VERSION = 3;

/** Normalised key used to de-duplicate a fact within a project. Pure. */
export function factKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
}

/**
 * The resolved path of the global memory database: the explicit `path`, else `OSA_MEMORY_DB`, else `~/.osa/memory.db`.
 * Tests MUST pass an explicit temp path (or set `OSA_MEMORY_DB`) so the real home directory is never written. Pure given
 * its inputs.
 */
export function resolveMemoryDbPath(path?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path !== undefined && path.trim() !== "") return path;
  const fromEnv = env["OSA_MEMORY_DB"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  // FM-H guard: a test run that reaches the real home default -- with no explicit path and no OSA_MEMORY_DB -- is refused, so
  // the suite can never create or write the real ~/.osa/memory.db. A test that wants the store must pass a temp path or set
  // OSA_MEMORY_DB. The process-level signals (execArgv, argv[1]) are read only when the caller passed the real environment,
  // so a pure resolution test with its own env map (e.g. {}) is unaffected.
  const real = env === process.env;
  if (underTestRunner(env, real ? process.execArgv : [], real ? process.argv[1] : undefined)) {
    throw new MemoryDbError("refusing to use the real home memory database under the test runner; set OSA_MEMORY_DB or pass an explicit path to a temp file", "other");
  }
  return join(homedir(), ".osa", "memory.db");
}

/**
 * True when this process looks like a test run: the node:test runner sets NODE_TEST_CONTEXT in the processes it spawns, but a
 * test file run directly (`node x.test.ts`) or with `--test-isolation=none` has no such variable, so the `--test*` flags and a
 * `*.test.*` entry file count too. Pure.
 */
export function underTestRunner(env: NodeJS.ProcessEnv, execArgv: readonly string[], argv1: string | undefined): boolean {
  if (env["NODE_TEST_CONTEXT"] !== undefined) return true;
  if (execArgv.some((a) => a === "--test" || a.startsWith("--test-"))) return true;
  return argv1 !== undefined && /\.test\.[cm]?[jt]s$/.test(argv1);
}

/** An open global-memory database. A thin wrapper so callers never touch `node:sqlite` directly. */
export interface MemoryDb {
  readonly db: DatabaseSync;
  readonly path: string;
  close(): void;
}

/** Why the database could not be used. A fixed set, so a caller (the run's capture event) can report a class without parsing message text. */
export type MemoryDbReason = "locked" | "corrupt" | "unwritable" | "fts-unavailable" | "other";

/** Raised when the database cannot be opened or is unusable. Never carries any stored fact text. */
export class MemoryDbError extends Error {
  readonly reason: MemoryDbReason;
  constructor(message: string, reason: MemoryDbReason = "other") {
    super(message);
    this.name = "MemoryDbError";
    this.reason = reason;
  }
}

/** SQLite result codes (primary): BUSY 5, LOCKED 6, READONLY 8, CORRUPT 11, FULL 13, CANTOPEN 14, NOTADB 26. */
function reasonOf(e: unknown): MemoryDbReason {
  const code = (e as { errcode?: unknown } | null)?.errcode;
  const primary = typeof code === "number" ? code & 0xff : null;
  if (primary === 5 || primary === 6) return "locked";
  if (primary === 11 || primary === 26) return "corrupt";
  if (primary === 8 || primary === 13 || primary === 14 || primary === 3) return "unwritable"; // READONLY, FULL, CANTOPEN, PERM
  return "other";
}

/**
 * Turns whatever the SQLite layer threw into a {@link MemoryDbError} with a class. An error that is already one passes through.
 * The message never carries stored text; it names the database file only for the cases where that helps a person.
 */
export function toMemoryDbError(e: unknown, path: string): MemoryDbError {
  if (e instanceof MemoryDbError) return e;
  const reason = reasonOf(e);
  const code = (e as { errcode?: unknown } | null)?.errcode;
  const detail = typeof code === "number" ? `; sqlite code ${String(code)}` : "";
  switch (reason) {
    case "locked":
      return new MemoryDbError(`the memory database at ${path} is locked by another process; try again in a moment`, reason);
    case "corrupt":
      return new MemoryDbError(`the memory database at ${path} is corrupt or not a database${detail}`, reason);
    case "unwritable":
      return new MemoryDbError(`the memory database at ${path} cannot be opened or written${detail}`, reason);
    default:
      return new MemoryDbError(`the memory database at ${path} could not be used${detail}`, reason);
  }
}

/** Confirms FTS5 is compiled into this `node:sqlite` build; throws a clear {@link MemoryDbError} if it is not. */
function assertFts5(db: DatabaseSync): void {
  try {
    db.exec("CREATE VIRTUAL TABLE temp._osa_fts5_probe USING fts5(x)");
    db.exec("DROP TABLE temp._osa_fts5_probe");
  } catch {
    throw new MemoryDbError("this Node.js build has no SQLite FTS5 support, which OSA memory requires (expected in Node 22+)", "fts-unavailable");
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

/**
 * Migration 2: an indexed de-duplication key. Without it every save scanned all of a project's facts, and two parallel saves of
 * the same text could both insert. A unique index over (project, dedup_key) makes the duplicate impossible and the lookup
 * logarithmic. Existing rows are back-filled; of any duplicates only the first keeps a key.
 */
function migrateDedupKey(db: DatabaseSync): void {
  // Idempotent: a process that lost an upgrade race can reach this with the column already added.
  const hasColumn = (db.prepare("PRAGMA table_info(facts)").all() as { name: string }[]).some((c) => c.name === "dedup_key");
  if (!hasColumn) db.exec("ALTER TABLE facts ADD COLUMN dedup_key TEXT");
  const seen = new Set<string>();
  const set = db.prepare("UPDATE facts SET dedup_key = ? WHERE id = ?");
  for (const r of db.prepare("SELECT id, project, text FROM facts WHERE deleted_at IS NULL ORDER BY created_at, id").all() as { id: string; project: string; text: string }[]) {
    const key = factKey(r.text);
    const full = `${r.project}\u0000${key}`;
    if (seen.has(full)) continue;
    seen.add(full);
    set.run(key, r.id);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS facts_dedup_idx ON facts(project, dedup_key) WHERE deleted_at IS NULL AND dedup_key IS NOT NULL");
}

/**
 * Migration 3: `research_items`, the store behind documentation-research reuse (docs/osa/memory-phase3). One row per
 * documentation key (`dkey`, the normalised target); `result` is the validated result JSON exactly as it was written to
 * disk, `check_level` records whether the independent cross-check was full or consistency-only, and `project` is the
 * origin run's project. The table is NOT FTS-indexed (reuse is an exact-key lookup, not a search), so `forget` needs no
 * `optimize` step for it -- `secure_delete` and `VACUUM` alone clear the text from the file. A partial unique index keeps
 * at most one live row per key; a newer result replaces the older one.
 */
function migrateResearchItems(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS research_items (
  id TEXT PRIMARY KEY,
  dkey TEXT NOT NULL,
  title TEXT NOT NULL,
  result TEXT NOT NULL,
  check_level TEXT NOT NULL,
  project TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS research_items_key_idx ON research_items(dkey) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS research_items_project_idx ON research_items(project);
`);
}

/**
 * Physically deletes remembered research rows -- a project's (exact match, so `forget --project x` never touches `xy`) or
 * all of them -- and returns the count. `secure_delete` (set at open) overwrites the freed pages; the caller runs `VACUUM`
 * and truncates the WAL so the forgotten target text survives in neither the file nor its `-wal`. The table is not
 * FTS-indexed, so no index segments hold the text. Must run inside the caller's transaction.
 */
export function purgeResearch(db: DatabaseSync, project: string | null): number {
  const result = project === null ? db.prepare("DELETE FROM research_items").run() : db.prepare("DELETE FROM research_items WHERE project = ?").run(project);
  return Number(result.changes);
}

/** Runs every migration past the recorded version inside one transaction. Idempotent: a current database is untouched. */
function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  const current = row.v ?? 0;
  if (current >= SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Read the version AGAIN now that this process holds the write lock: another process may have finished the upgrade while this one waited for it.
    const now = (db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null }).v ?? 0;
    if (now >= SCHEMA_VERSION) {
      db.exec("COMMIT");
      return;
    }
    if (now < 1) db.exec(MIGRATION_1);
    if (now < 2) migrateDedupKey(db);
    if (now < 3) migrateResearchItems(db);
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
export function openMemoryDb(path?: string, env: NodeJS.ProcessEnv = process.env, opts: { readonly busyTimeoutMs?: number } = {}): MemoryDb {
  const resolved = resolveMemoryDbPath(path, env);
  const busyTimeoutMs = Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000));
  try {
    mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  } catch {
    // directory may already exist; a real failure surfaces below when the file cannot be opened
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(resolved);
    // The busy timeout comes FIRST: switching to WAL needs a lock, and with the default timeout of zero a second process opening at the same moment fails at once.
    db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
    db.exec("PRAGMA journal_mode = WAL");
    // Deleted content is overwritten with zeros, not left in free pages (forget must not leave the text in the file).
    db.exec("PRAGMA secure_delete = ON");
    db.exec("PRAGMA foreign_keys = ON");
    assertFts5(db);
    migrate(db);
  } catch (e) {
    try {
      db?.close();
    } catch {
      // already closed or never opened
    }
    throw toMemoryDbError(e, resolved);
  }
  const handle = db as DatabaseSync; // set: the try block above either assigned it or threw
  try {
    if (process.platform !== "win32") {
      chmodSync(dirname(resolved), 0o700);
      for (const f of [resolved, `${resolved}-wal`, `${resolved}-shm`]) {
        try {
          chmodSync(f, 0o600);
        } catch {
          // the sidecar files may not exist yet
        }
      }
    }
  } catch {
    // best-effort; some filesystems reject chmod
  }
  return {
    db: handle,
    path: resolved,
    close(): void {
      handle.close();
    },
  };
}
