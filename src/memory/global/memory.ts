// The write/read/forget surface over OSA's global memory database (docs/osa/memory-phase1/PRD.md, SPEC.md §behaviour).
// `saveFact` is the only write path in step 1; `searchMemory` ranks non-deleted facts with FTS5 bm25; `forgetMemory`
// physically purges a project or everything; `listProjects` summarises what is stored. This module (and the
// `node:sqlite`-backed `db.ts` it imports) is loaded LAZILY by the MCP tools and the CLI, so with memory unused it stays
// out of every entry point's static import graph.
//
// Safety invariants carried here: a fact is rejected if empty or over 2,000 characters; instruction-like text is
// rejected (`detectInjection`); secret-shaped spans are redacted before anything reaches disk, a husk (> half redacted)
// is refused rather than stored, and -- as the authoritative gate -- text on which `findSecret` still fires after
// redaction is refused, so nothing secret-shaped reaches the table or the FTS index. User query text is escaped so it
// cannot inject FTS5 syntax. Errors never include stored fact text.

import { randomUUID } from "node:crypto";
import { UsageError } from "../../domain/errors.ts";
import { detectInjection } from "../../osa/untrusted.ts";
import { openMemoryDb } from "./db.ts";
import { redactSecrets, stillHasSecret } from "./redact.ts";

/** The kinds a fact may carry. */
export const FACT_KINDS = ["fact", "decision", "note"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const MAX_FACT_CHARS = 2000;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

export interface SaveFactInput {
  readonly text: string;
  readonly project: string;
  readonly kind?: FactKind;
  /** Free-text provenance ("osa run 84ef52b0", "manual", a path). Optional. */
  readonly source?: string;
}

export interface SaveFactResult {
  readonly id: string;
  /** One reason per redacted span (empty when nothing was redacted). */
  readonly redactions: string[];
  /** True when an existing identical fact was refreshed rather than a new row inserted. */
  readonly deduped: boolean;
}

export interface SearchResult {
  readonly id: string;
  readonly project: string;
  readonly kind: string;
  readonly source: string | null;
  readonly created_at: string;
  readonly snippet: string;
  readonly rank: number;
}

export interface ForgetResult {
  readonly facts: number;
}

export interface ProjectInfo {
  readonly project: string;
  readonly count: number;
  readonly updated_at: string;
}

/** Normalised key for de-duplication within a project. Pure. */
export function factKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
}

/**
 * Escapes free user text into a safe FTS5 MATCH expression: each whitespace-separated token becomes a quoted phrase
 * (internal double-quotes doubled), so FTS operators a user might type (`"`, `*`, `OR`, `NEAR(`, a lone quote) are
 * treated as literal text and cannot inject query syntax (FM-A). Returns `null` when the query has no usable token.
 * Pure.
 */
export function toFtsMatch(query: string): string | null {
  const tokens = query.split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return null;
  const phrases = tokens.map((t) => `"${t.replace(/"/g, '""')}"`);
  return phrases.join(" ");
}

function requireKind(kind: FactKind | undefined): FactKind {
  return kind ?? "fact";
}

/**
 * Validates, redacts and stores one fact. Rejections (empty, over-length, instruction-like, or an unredactable secret)
 * throw a {@link UsageError} whose message never echoes a secret. De-duplicates by normalised text within the project:
 * an existing identical fact has its `updated_at` refreshed instead of a second row being inserted. Returns the stored
 * (or refreshed) id and the redaction reasons.
 */
export function saveFact(input: SaveFactInput, opts: { readonly dbPath?: string } = {}): SaveFactResult {
  const text = input.text.trim();
  if (text === "") throw new UsageError("memory save: the text is empty.");
  if (text.length > MAX_FACT_CHARS) throw new UsageError(`memory save: the text is ${String(text.length)} characters; the limit is ${String(MAX_FACT_CHARS)}.`);
  const injected = detectInjection(text)[0];
  if (injected !== undefined) throw new UsageError(`memory save: the text looks like an instruction aimed at an AI (${injected.rule}); memory stores facts, not instructions.`);

  const redacted = redactSecrets(text);
  if (redacted.fraction > 0.5) throw new UsageError("memory save: more than half of the text was secret-shaped; refusing to store a redacted husk.");
  if (stillHasSecret(redacted.text)) throw new UsageError("memory save: the text contains a secret that could not be fully redacted; nothing was stored.");

  const project = input.project.trim() === "" ? "default" : input.project.trim();
  const kind = requireKind(input.kind);
  const source = input.source ?? null;
  const now = new Date().toISOString();

  const mem = openMemoryDb(opts.dbPath);
  try {
    const key = factKey(redacted.text);
    const rows = mem.db.prepare("SELECT id, text FROM facts WHERE project = ? AND deleted_at IS NULL").all(project) as { id: string; text: string }[];
    const dup = rows.find((r) => factKey(r.text) === key);
    if (dup !== undefined) {
      mem.db.prepare("UPDATE facts SET updated_at = ? WHERE id = ?").run(now, dup.id);
      return { id: dup.id, redactions: redacted.redactions, deduped: true };
    }
    const id = randomUUID();
    mem.db.prepare("INSERT INTO facts(id, project, kind, source, text, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(id, project, kind, source, redacted.text, now, now);
    return { id, redactions: redacted.redactions, deduped: false };
  } finally {
    mem.close();
  }
}

/**
 * Ranks non-deleted facts with FTS5 bm25 over the (escaped) query. Optional project filter. Deterministic ordering:
 * rank, then `created_at`, then `id`. A query with no usable token returns no results. Snippets and stored text are
 * returned verbatim -- the MCP tool wraps them as untrusted; the CLI prints them plainly.
 */
export function searchMemory(input: { readonly query: string; readonly project?: string; readonly limit?: number }, opts: { readonly dbPath?: string } = {}): SearchResult[] {
  const match = toFtsMatch(input.query);
  if (match === null) return [];
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT);
  const mem = openMemoryDb(opts.dbPath);
  try {
    const where = input.project !== undefined && input.project.trim() !== "" ? "AND f.project = ?" : "";
    const sql =
      `SELECT f.id AS id, f.project AS project, f.kind AS kind, f.source AS source, f.created_at AS created_at, ` +
      `snippet(facts_fts, 1, '', '', '…', 12) AS snippet, bm25(facts_fts) AS rank ` +
      `FROM facts_fts JOIN facts f ON f.id = facts_fts.id ` +
      `WHERE facts_fts MATCH ? AND f.deleted_at IS NULL ${where} ` +
      `ORDER BY rank ASC, f.created_at ASC, f.id ASC LIMIT ?`;
    const params = where === "" ? [match, limit] : [match, (input.project as string).trim(), limit];
    const rows = mem.db.prepare(sql).all(...params) as unknown as SearchResult[];
    return rows.map((r) => ({ id: r.id, project: r.project, kind: r.kind, source: r.source ?? null, created_at: r.created_at, snippet: r.snippet, rank: r.rank }));
  } finally {
    mem.close();
  }
}

/**
 * Physically purges facts (the triggers drop their FTS entries) and runs `VACUUM`, returning the count removed. A
 * project match is EXACT, so `forget --project x` never touches project `xy` (FM-G). The soft-delete column is for
 * later sync; `forget` does not merely mark.
 */
export function forgetMemory(input: { readonly project: string } | { readonly all: true }, opts: { readonly dbPath?: string } = {}): ForgetResult {
  const mem = openMemoryDb(opts.dbPath);
  try {
    const result = "all" in input ? mem.db.prepare("DELETE FROM facts").run() : mem.db.prepare("DELETE FROM facts WHERE project = ?").run(input.project);
    mem.db.exec("VACUUM");
    return { facts: Number(result.changes) };
  } finally {
    mem.close();
  }
}

/** Every project with at least one non-deleted fact, with its fact count and most recent update, ordered by name. */
export function listProjects(opts: { readonly dbPath?: string } = {}): ProjectInfo[] {
  const mem = openMemoryDb(opts.dbPath);
  try {
    const rows = mem.db.prepare("SELECT project, COUNT(*) AS count, MAX(updated_at) AS updated_at FROM facts WHERE deleted_at IS NULL GROUP BY project ORDER BY project ASC").all() as { project: string; count: number; updated_at: string }[];
    return rows.map((r) => ({ project: r.project, count: Number(r.count), updated_at: r.updated_at }));
  } finally {
    mem.close();
  }
}
