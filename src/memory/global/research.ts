// Remember and reuse documentation research across runs (docs/osa/memory-phase3/SPEC.md). A finished, cross-checked
// documentation item is stored here under a normalised technology key; a later run of any project that names the same
// technology reads it back instead of spending research tokens again. The store is the ONE global memory database
// (`research_items`, migration 3). This module (and the node:sqlite-backed db.ts it imports) is loaded LAZILY by the
// research stage's dynamic import() so that with reuse off no global-memory module is reachable from a static import graph.
//
// Accuracy and freshness come first: this module only moves bytes. The caller validates a reused result against THIS
// item's field schema and screens it as untrusted exactly as a fresh result, and only remembers a result the independent
// cross-check passed. A stored result is third-party text derived from web pages; storing it never makes it trusted.

import { randomUUID } from "node:crypto";
import { findSecret } from "../secrets.ts";
import { maskCommitHashes } from "./redact.ts";
import { openMemoryDb, toMemoryDbError } from "./db.ts";
import type { MemoryDb } from "./db.ts";

/** A result JSON larger than this is refused (counted, not stored): a documentation result is a few KB, not a document. */
export const MAX_RESULT_BYTES = 64 * 1024;
/** At most this many remembered rows are kept; beyond it the oldest are evicted (FM-I). */
export const MAX_RESEARCH_ROWS = 500;

/** Whether the run that remembered a result had a full independent check or only a consistency-only one. */
export type CheckLevel = "full" | "consistency-only";

/**
 * The reuse key for a documentation target: NFKC-folded, lowercased, whitespace collapsed, trailing punctuation trimmed.
 * This is the single source of the key format, shared by remember and reuse, so "React", "react" and "React " key the
 * same, while "react" and "react-native" stay distinct (exact match, never a prefix). Pure.
 */
export function docsKey(target: string): string {
  return target
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    // Only SENTENCE punctuation is trimmed. "#", "+" and the like can be part of a technology's name: trimming them made "C#" and "C" (and "F#" and "F") the same key,
    // so one language's documentation was served for another.
    .replace(/[.,;:!?\s]+$/u, "")
    .trim();
}

/**
 * True when a result created at `createdAt` is no older than `maxAgeDays` relative to `now`. The boundary is inclusive:
 * an entry exactly `maxAgeDays` old is still fresh (FM-A). An unparseable timestamp is never fresh. Pure.
 */
export function isFresh(createdAt: string, maxAgeDays: number, now: Date): boolean {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  const ageMs = now.getTime() - created;
  // A date in the future is a wrong clock or an edited row, and would be "fresh" forever: a day of skew is tolerated, more is not.
  if (ageMs < -86_400_000) return false;
  return ageMs <= maxAgeDays * 86_400_000;
}

/** One documentation result offered for reuse: the parsed JSON, the origin project, and how old it is (whole days, a lower bound 0). */
export interface ReusableResult {
  readonly result: Record<string, unknown>;
  readonly project: string;
  readonly ageDays: number;
}

/** One documentation result to remember. `resultJson` is the validated JSON exactly as written to the item's result file. */
export interface RememberInput {
  readonly target: string;
  readonly title: string;
  readonly resultJson: string;
  readonly checkLevel: CheckLevel;
  readonly project: string;
  readonly createdAt: string;
}

/** Counts from one {@link rememberItems} call. Never carries any stored text. */
export interface RememberResult {
  /** Rows inserted or replaced. */
  readonly stored: number;
  /** Results refused for being over {@link MAX_RESULT_BYTES} or still secret-shaped. */
  readonly refused: number;
}

/** Options shared by the reuse functions. */
export interface ResearchStoreOptions {
  readonly dbPath?: string;
  readonly busyTimeoutMs?: number;
}

function open(opts: ResearchStoreOptions): MemoryDb {
  return openMemoryDb(opts.dbPath, process.env, opts.busyTimeoutMs !== undefined ? { busyTimeoutMs: opts.busyTimeoutMs } : {});
}

/**
 * Looks up remembered documentation results for `targets` in ONE query. A row qualifies only when it is not deleted, its
 * `created_at` is within `maxAgeDays` of `now`, and its stored JSON parses to an object. Returns a map from docs key to the
 * reusable result; a target with no qualifying row is simply absent. The caller keys its items by {@link docsKey} too, so
 * two items with the same target both find it and a technology whose name is a prefix of another never matches it (FM-G).
 */
export function findReusable(targets: readonly string[], opts: ResearchStoreOptions & { readonly maxAgeDays: number; readonly now: Date }): Map<string, ReusableResult> {
  const out = new Map<string, ReusableResult>();
  const keys = [...new Set(targets.map((t) => docsKey(t)).filter((k) => k !== ""))];
  if (keys.length === 0) return out;
  const mem = open(opts);
  try {
    const placeholders = keys.map(() => "?").join(", ");
    const rows = mem.db
      .prepare(`SELECT dkey, result, project, created_at FROM research_items WHERE deleted_at IS NULL AND dkey IN (${placeholders})`)
      .all(...keys) as { dkey: string; result: string; project: string; created_at: string }[];
    for (const row of rows) {
      if (!isFresh(row.created_at, opts.maxAgeDays, opts.now)) continue;
      // The same limits as when remembering, applied again on the way OUT: a row edited after it was stored must not be able to put a secret into a report
      // or a prompt just because it was clean once.
      if (Buffer.byteLength(row.result, "utf8") > MAX_RESULT_BYTES || findSecret(maskCommitHashes(row.result)) !== null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.result);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const ageMs = opts.now.getTime() - Date.parse(row.created_at);
      const ageDays = Math.max(0, Math.floor(ageMs / 86_400_000));
      out.set(row.dkey, { result: parsed as Record<string, unknown>, project: row.project, ageDays });
    }
    return out;
  } catch (e) {
    throw toMemoryDbError(e, mem.path);
  } finally {
    mem.close();
  }
}

/**
 * Remembers documentation results through ONE connection. Each result is refused (counted, not stored) when its JSON text
 * is over {@link MAX_RESULT_BYTES} or when {@link findSecret} still fires on it -- nothing secret-shaped reaches the table.
 * One row per key: a newer result replaces the older one, refreshing `created_at` and `updated_at`. After the writes the
 * table is capped at {@link MAX_RESEARCH_ROWS} live rows, oldest first. Anything other than a refusal (a locked, corrupt or
 * unwritable database) is thrown as a typed MemoryDbError for the caller to report as a reason class.
 */
export function rememberItems(records: readonly RememberInput[], opts: ResearchStoreOptions): RememberResult {
  if (records.length === 0) return { stored: 0, refused: 0 };
  const mem = open(opts);
  try {
    mem.db.exec("BEGIN IMMEDIATE");
  } catch (e) {
    mem.close();
    throw toMemoryDbError(e, mem.path);
  }
  try {
    let stored = 0;
    let refused = 0;
    for (const rec of records) {
      const key = docsKey(rec.target);
      if (key === "") {
        refused += 1;
        continue;
      }
      if (Buffer.byteLength(rec.resultJson, "utf8") > MAX_RESULT_BYTES || findSecret(maskCommitHashes(rec.resultJson)) !== null) {
        refused += 1;
        continue;
      }
      const existing = mem.db.prepare("SELECT id FROM research_items WHERE dkey = ? AND deleted_at IS NULL").get(key) as { id: string } | undefined;
      if (existing !== undefined) {
        mem.db
          .prepare("UPDATE research_items SET title = ?, result = ?, check_level = ?, project = ?, created_at = ?, updated_at = ? WHERE id = ?")
          .run(rec.title, rec.resultJson, rec.checkLevel, rec.project, rec.createdAt, rec.createdAt, existing.id);
      } else {
        mem.db
          .prepare("INSERT INTO research_items(id, dkey, title, result, check_level, project, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)")
          .run(randomUUID(), key, rec.title, rec.resultJson, rec.checkLevel, rec.project, rec.createdAt, rec.createdAt);
      }
      stored += 1;
    }
    // FM-I: keep at most MAX_RESEARCH_ROWS live rows; delete the oldest beyond the cap (created_at, then id for a stable order).
    const live = mem.db.prepare("SELECT COUNT(*) AS n FROM research_items WHERE deleted_at IS NULL").get() as { n: number };
    const over = Number(live.n) - MAX_RESEARCH_ROWS;
    if (over > 0) {
      mem.db.prepare("DELETE FROM research_items WHERE id IN (SELECT id FROM research_items WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT ?)").run(over);
    }
    // `stored` counts what is actually in the table now: an item older than every row is deleted by the cap above in the same transaction.
    let survived = 0;
    for (const rec of records) {
      const key = docsKey(rec.target);
      if (key !== "" && mem.db.prepare("SELECT 1 AS one FROM research_items WHERE dkey = ? AND deleted_at IS NULL").get(key) !== undefined) survived += 1;
    }
    stored = Math.min(stored, survived);
    mem.db.exec("COMMIT");
    return { stored, refused };
  } catch (e) {
    try {
      mem.db.exec("ROLLBACK");
    } catch {
      // no transaction left to roll back
    }
    throw toMemoryDbError(e, mem.path);
  } finally {
    mem.close();
  }
}
