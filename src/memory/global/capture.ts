// Phase 2: capture a finished or stopped run into the ONE global memory store (docs/osa/memory-phase2/PRD.md, SPEC.md).
// This is loaded by a dynamic import() from the pipeline's recordMemory hook, which is itself fail-soft: a database that is
// unwritable, locked or corrupt becomes a single `global_memory_failed` event and nothing else -- the run's outcome, exit
// code and timing are untouched. The store module (and its node:sqlite dependency) is loaded LAZILY here too, so no
// global-memory module is ever reachable from a static import graph (FM-I).
//
// Everything captured comes from the run RECORD (what the person locked, the spec decisions, the architecture decision,
// per-phase outcomes, the application check, research outcomes) via the existing deterministic `deriveFacts` -- never the
// raw chat log, which stays write-only. No fact text, goal, or any user text ever reaches an event or an error message:
// counts and reason classes only.

import { basename } from "node:path";
import { UsageError } from "../../domain/errors.ts";
import { detectInjection, scrubUntrusted } from "../../osa/untrusted.ts";
import { findSecret } from "../secrets.ts";
import { clip, deriveFacts } from "../derive.ts";
import type { RunRecord } from "../derive.ts";
import { maskCommitHashes, redactSecrets } from "./redact.ts";
import type { FactKind } from "./memory.ts";

/** Hard cap on facts saved per run (summary note first, then decisions, failures, preferences, conventions). */
export const MAX_RUN_FACTS = 40;
const MAX_PROJECT_CHARS = 100;

// Control characters other than newline and tab -- the same set memory.ts strips from stored labels.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Counts from one capture. Never carries any fact text. */
export interface CaptureResult {
  /** New rows inserted. */
  readonly saved: number;
  /** Identical facts the store already held (its `updated_at` refreshed, no new row). */
  readonly deduped: number;
  /** Facts the store refused (secret-shaped, instruction-like, hidden, husk, empty, over-length). */
  readonly refused: number;
  /** Total redacted spans across the saved facts. */
  readonly redacted: number;
  /** One reason class per refusal, in order. */
  readonly reasons: string[];
}

/**
 * The project name a run's facts are stored under: the repository folder's basename, cleaned the way `saveFact` cleans a
 * label (hidden content, control characters, NFKC-folding, whitespace collapse). If the result is empty, over-length, or
 * would be refused as secret-shaped or instruction-like, it falls back to `default` rather than letting the save abort
 * (FM-F). Pure.
 */
export function projectNameFor(repoDir: string): string {
  const raw = basename(repoDir.replace(/[\\/]+$/, ""));
  const scrubbed = scrubUntrusted(raw);
  if (scrubbed.hidden.length > 0) return "default";
  const label = scrubbed.text.replace(CONTROL, "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (label === "" || label.length > MAX_PROJECT_CHARS) return "default";
  if (findSecret(maskCommitHashes(label)) !== null || redactSecrets(label).redactions.length > 0) return "default";
  if (detectInjection(label).length > 0) return "default";
  return label;
}

/**
 * The one run-summary note (kind `note`): the outcome and why, the locked goal in one line, the architecture chosen, how
 * many phases passed, and the count of unmet requirements. Run ids and absolute paths are scrubbed and the whole is clipped
 * to 300 characters by the shared `clip`. Pure.
 */
export function summaryNote(r: RunRecord): string {
  const goal = r.prdLocked.tldr.join(" ");
  const outcome = r.outcome === "stopped" ? `stopped${r.stoppedBecause !== null ? ` (${r.stoppedBecause})` : ""}` : "finished";
  const arch = r.architecture === null ? "no architecture decision recorded" : r.architecture.chosen === "planned" ? "kept the planned architecture" : `adopted "${r.architecture.chosen}"`;
  const passed = r.phases.filter((p) => p.ok).length;
  return clip(`Run ${outcome}. Goal: ${goal}. Architecture: ${arch}. Phases passed: ${passed}/${String(r.phases.length)}. Unmet requirements: ${String(r.applicationUnmet.length)}.`, 300);
}

/** Classifies a refusal ({@link UsageError} from the store) into a text-free reason class for the event. Pure. */
function refusalClass(message: string): string {
  if (/hidden text/i.test(message)) return "hidden";
  if (/instruction/i.test(message)) return "instruction";
  if (/secret|husk/i.test(message)) return "secret";
  if (/is empty/i.test(message)) return "empty";
  if (/the limit is/i.test(message)) return "too-long";
  return "other";
}

/**
 * Classifies a fatal (database-level) capture failure into one of the fixed reason classes the `global_memory_failed`
 * event carries -- `locked`, `corrupt`, `fts-unavailable`, `other`. Never includes any message text beyond the class. Pure.
 */
export function classifyFailure(err: unknown): "locked" | "corrupt" | "fts-unavailable" | "other" {
  const m = err instanceof Error ? err.message : String(err);
  if (/\blocked\b|\bbusy\b/i.test(m)) return "locked";
  if (/FTS5/i.test(m)) return "fts-unavailable";
  if (/corrupt|unreadable|could not be opened/i.test(m)) return "corrupt";
  return "other";
}

/**
 * Builds the run's facts (summary note first, then decisions -> `decision`, failures/preferences/conventions -> `fact`,
 * capped at {@link MAX_RUN_FACTS}) and saves each to the global store under the derived project name and source
 * `osa run <id8>`. A store refusal ({@link UsageError}) is counted and its reason class recorded; any OTHER error (the
 * database is unwritable, locked or corrupt) aborts the whole capture and is rethrown for the caller to report as
 * `global_memory_failed`. De-duplication is the store's: an identical fact from an earlier run is counted as `deduped`.
 * The store module is loaded lazily so no static import graph reaches node:sqlite.
 */
export async function captureRun(record: RunRecord, repoDir: string, opts: { readonly dbPath?: string } = {}): Promise<CaptureResult> {
  const { saveFact } = await import("./memory.ts");
  const project = projectNameFor(repoDir);
  const source = `osa run ${record.runId.slice(0, 8)}`;
  const facts = deriveFacts(record);
  const items: { readonly text: string; readonly kind: FactKind }[] = [
    { text: summaryNote(record), kind: "note" },
    ...facts.decisions.map((t) => ({ text: t, kind: "decision" as const })),
    ...facts.failures.map((t) => ({ text: t, kind: "fact" as const })),
    ...facts.preferences.map((t) => ({ text: t, kind: "fact" as const })),
    ...facts.conventions.map((t) => ({ text: t, kind: "fact" as const })),
  ];
  const saveOpts = opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {};
  let saved = 0;
  let deduped = 0;
  let refused = 0;
  let redacted = 0;
  const reasons: string[] = [];
  for (const item of items.slice(0, MAX_RUN_FACTS)) {
    try {
      const res = saveFact({ text: item.text, project, kind: item.kind, source }, saveOpts);
      if (res.deduped) deduped += 1;
      else saved += 1;
      redacted += res.redactions.length;
    } catch (err) {
      if (err instanceof UsageError) {
        refused += 1;
        reasons.push(refusalClass(err.message));
        continue;
      }
      throw err;
    }
  }
  return { saved, deduped, refused, redacted, reasons };
}
