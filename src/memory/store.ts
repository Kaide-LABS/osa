// Project-scoped memory (OSA_DIRECTIVE.md WS8): `.osa/memory/<category>.md`, human-readable markdown, ONE FACT PER
// LINE, never a secret. Four categories: decisions, conventions, failures (past failures and their fixes), preferences
// (this project's user preferences). Written at run end from the run's record, read at the next intake.
//
// Format of a line:   - <fact> _(run <8 hex>, <YYYY-MM-DD>)_
// The directory is NOT git-ignored by default (project memory is worth sharing), but it may be: the pipeline commits
// it only when it is not ignored, so it can never be swept into an agent's fallback commit as an untracked file.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { detectInjection } from "../osa/untrusted.ts";
import { findSecret } from "./secrets.ts";

export const MEMORY_CATEGORIES = ["decisions", "conventions", "failures", "preferences"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** Repo-relative directory of the memory files. */
export const MEMORY_DIR_REL = ".osa/memory";

export const MAX_FACT_CHARS = 300;
export const DEFAULT_MAX_FACTS_PER_FILE = 200;

const HEADERS: Readonly<Record<MemoryCategory, string>> = {
  decisions: "# Decisions\n\nChoices made on this project and why. One fact per line. Written by OSA from each run's record; safe to edit by hand.\n",
  conventions: "# Conventions\n\nStack, tools and conventions this project uses. One fact per line.\n",
  failures: "# Failures and fixes\n\nWhat went wrong in past runs and what resolved it. One fact per line.\n",
  preferences: "# Preferences\n\nThis project's user preferences, as shown by their choices at the lock. One fact per line.\n",
};

export function memoryDir(repoDir: string): string {
  return `${repoDir}/${MEMORY_DIR_REL}`;
}

export function memoryFile(repoDir: string, category: MemoryCategory): string {
  return `${memoryDir(repoDir)}/${category}.md`;
}

/** One stored fact. */
export interface MemoryFact {
  readonly category: MemoryCategory;
  readonly text: string;
  /** `run <id8>` provenance, when recorded. */
  readonly runId: string | null;
  readonly date: string | null;
}

/** Normalised key used for de-duplication. Pure. */
export function factKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
}

/** Formats one line. Pure. */
export function formatFactLine(text: string, runId: string | null, date: string): string {
  return `- ${text}${runId !== null ? ` _(run ${runId.slice(0, 8)}, ${date})_` : ` _(${date})_`}`;
}

const LINE = /^- (.*?)(?: _\((?:run ([0-9a-f]{8}), )?(\d{4}-\d{2}-\d{2})\)_)?\s*$/;

/** Parses the fact lines of a memory file (other lines are headers/blank and ignored). Pure. */
export function parseFacts(category: MemoryCategory, content: string): MemoryFact[] {
  const out: MemoryFact[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(LINE);
    if (m?.[1] === undefined || m[1].trim() === "") continue;
    out.push({ category, text: m[1].trim(), runId: m[2] ?? null, date: m[3] ?? null });
  }
  return out;
}

/** Reads every fact of the given categories (all by default), oldest first within a file. Missing files are empty. */
export async function readFacts(repoDir: string, categories: readonly MemoryCategory[] = MEMORY_CATEGORIES): Promise<MemoryFact[]> {
  const out: MemoryFact[] = [];
  for (const c of categories) {
    try {
      out.push(...parseFacts(c, await readFile(memoryFile(repoDir, c), "utf8")));
    } catch {
      // no file yet
    }
  }
  return out;
}

/** A fact that was not stored, and why. */
export interface RejectedFact {
  readonly text: string;
  readonly reason: string;
}

/** The outcome of {@link appendFacts}. */
export interface AppendResult {
  readonly appended: readonly string[];
  readonly duplicates: readonly string[];
  readonly rejected: readonly RejectedFact[];
  /** Oldest facts dropped to stay within the per-file cap. */
  readonly compacted: number;
}

/** Why `text` cannot be stored as a single memory fact, else `null`. Pure. */
export function rejectReason(text: string): string | null {
  const t = text.trim();
  if (t === "") return "empty";
  if (/[\r\n]/.test(t)) return "a fact must be a single line";
  if (t.length > MAX_FACT_CHARS) return `longer than ${String(MAX_FACT_CHARS)} characters`;
  const secret = findSecret(t);
  if (secret !== null) return `looks like it contains ${secret}; memory never stores secrets`;
  // Memory is read into the NEXT run's intake prompt, so it is a persistent injection channel: facts only, never instructions to an AI.
  const injected = detectInjection(t)[0];
  return injected === undefined ? null : `looks like an instruction aimed at an AI (${injected.rule}); memory stores facts, not instructions`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

/**
 * Appends facts to one category: validated (single line, bounded, no secrets), de-duplicated against what is already
 * there, stamped with the run id and date. Rejections are RETURNED, never swallowed. If the file would exceed
 * `maxFacts`, the oldest facts are dropped (counted in `compacted`).
 */
export async function appendFacts(
  repoDir: string,
  category: MemoryCategory,
  facts: readonly string[],
  opts: { readonly runId?: string | null; readonly date?: string; readonly maxFacts?: number } = {},
): Promise<AppendResult> {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const maxFacts = opts.maxFacts ?? DEFAULT_MAX_FACTS_PER_FILE;
  const existing = await readFacts(repoDir, [category]);
  const seen = new Set(existing.map((f) => factKey(f.text)));
  const appended: string[] = [];
  const duplicates: string[] = [];
  const rejected: RejectedFact[] = [];
  const lines: string[] = existing.map((f) => formatFactLine(f.text, f.runId, f.date ?? date));
  for (const raw of facts) {
    const reason = rejectReason(raw);
    if (reason !== null) {
      rejected.push({ text: raw.length > 80 ? `${raw.slice(0, 80)}...` : raw, reason });
      continue;
    }
    const text = raw.trim();
    if (seen.has(factKey(text))) {
      duplicates.push(text);
      continue;
    }
    seen.add(factKey(text));
    appended.push(text);
    lines.push(formatFactLine(text, opts.runId ?? null, date));
  }
  let compacted = 0;
  if (lines.length > maxFacts) {
    compacted = lines.length - maxFacts;
    lines.splice(0, compacted);
  }
  if (appended.length > 0 || compacted > 0) {
    await mkdir(memoryDir(repoDir), { recursive: true });
    await atomicWrite(memoryFile(repoDir, category), `${HEADERS[category]}\n${lines.join("\n")}\n`);
  }
  return { appended, duplicates, rejected, compacted };
}

/**
 * The memory block handed to intake / the spec author: newest facts first within each category, bounded to `maxChars`,
 * or `null` when there is nothing. Provenance stamps are stripped (they are noise to a model). Pure given `facts`.
 */
export function formatMemoryForPrompt(facts: readonly MemoryFact[], maxChars = 3000): string | null {
  if (facts.length === 0) return null;
  const parts: string[] = [];
  let used = 0;
  for (const c of MEMORY_CATEGORIES) {
    const mine = facts.filter((f) => f.category === c).reverse();
    if (mine.length === 0) continue;
    const head = `${c.charAt(0).toUpperCase()}${c.slice(1)}:`;
    const lines: string[] = [];
    for (const f of mine) {
      const line = `- ${f.text}`;
      if (used + line.length + 1 > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length > 0) parts.push([head, ...lines].join("\n"));
  }
  return parts.length === 0 ? null : parts.join("\n\n");
}

/** Reads memory and formats it for a prompt. */
export async function readMemoryForPrompt(repoDir: string, maxChars = 3000): Promise<string | null> {
  return formatMemoryForPrompt(await readFacts(repoDir), maxChars);
}
