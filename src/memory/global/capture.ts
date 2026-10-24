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

import { basename, resolve } from "node:path";
import { detectInjection, scrubUntrusted } from "../../osa/untrusted.ts";
import { findSecret } from "../secrets.ts";
import { clip, deriveFacts } from "../derive.ts";
import type { RunRecord } from "../derive.ts";
import { maskCommitHashes, redactSecrets } from "./redact.ts";
import type { FactKind, SaveFactsEntry } from "./memory.ts";

/** Hard cap on facts saved per run (summary note first, then decisions, failures, preferences, conventions). */
export const MAX_RUN_FACTS = 40;
const MAX_PROJECT_CHARS = 100;
/** A run's capture must not freeze the process for long when another process holds the database: a short wait, then give up. */
const CAPTURE_BUSY_TIMEOUT_MS = 1500;

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
  /** Derived facts left out because a run keeps at most {@link MAX_RUN_FACTS} (lowest priority first: conventions, then preferences). */
  readonly truncated: number;
}

/**
 * The project name a run's facts are stored under: the repository folder's basename, cleaned the way `saveFact` cleans a
 * label (hidden content, control characters, NFKC-folding, whitespace collapse). If the result is empty, over-length, or
 * would be refused as secret-shaped or instruction-like, it falls back to `default` rather than letting the save abort
 * (FM-F). Pure.
 */
export function projectNameFor(repoDir: string): string {
  if (repoDir.trim() === "") return "default"; // resolve("") would be the current directory, which is not this repository's name
  // Resolve first: "." or a relative path has no folder name of its own. (A path that is already absolute, from another OS, resolves to itself.)
  const raw = basename(resolve(repoDir).replace(/[\\/]+$/, ""));
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
export function summaryNote(r: RunRecord, withGoal = true): string {
  // Secrets are redacted BEFORE any clipping: a token cut in half is too short for the rules to recognise and would be stored as a fragment.
  const safe = (s: string): string => redactSecrets(s).text;
  const reason = r.outcome === "stopped" && r.stoppedBecause !== null ? ` (${clip(safe(r.stoppedBecause), 120)})` : "";
  const built = r.built !== false;
  const head = r.outcome === "stopped" ? `Run stopped${reason}.` : built ? "Run finished." : "Run finished (spec only, nothing built).";
  const arch = r.architecture === null ? "no architecture decision recorded" : r.architecture.chosen === "planned" ? "kept the planned architecture" : `adopted "${safe(r.architecture.chosen)}"`;
  const parts = [head];
  if (built) {
    parts.push(`Phases passed: ${String(r.phases.filter((p) => p.ok).length)}/${String(r.phases.length)}.`);
    // The count of unmet requirements only means something if the final check actually ran.
    parts.push(r.applicationCouldNotRun !== null ? "Final check could not run." : r.applicationChecked === false ? "Final check not run." : `Unmet requirements: ${String(r.applicationUnmet.length)}.`);
  }
  parts.push(`Architecture: ${arch}.`);
  // The counts come first and the goal gets whatever room is left, so a long goal can never push the outcome out of the note.
  if (withGoal) parts.push(`Goal: ${safe(r.prdLocked.tldr.join(" "))}`);
  return clip(parts.join(" "), 300);
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
export type CaptureFailureClass = "locked" | "corrupt" | "unwritable" | "fts-unavailable" | "other";

export function classifyFailure(err: unknown): CaptureFailureClass {
  // The class comes from the error's own typed `reason` (set where the database error is raised), never from its message: the message names the database path, and a folder called "busy" or "locked" must not change the answer. Duck-typed so this file never imports the sqlite-backed db module.
  const reason = (err as { reason?: unknown } | null)?.reason;
  return reason === "locked" || reason === "corrupt" || reason === "unwritable" || reason === "fts-unavailable" ? reason : "other";
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
  const { saveFacts, validateLabel } = await import("./memory.ts");
  // The folder name must pass the store's own label rules; anything the store would refuse (even after its NFKC fold) becomes `default`,
  // so one odd folder name can never cost a run all of its facts.
  let project = "default";
  try {
    project = validateLabel(projectNameFor(repoDir), "project name", MAX_PROJECT_CHARS) || "default";
  } catch {
    // keep "default"
  }
  const source = `osa run ${record.runId.slice(0, 8)}`;
  const facts = deriveFacts(record);
  const all: { readonly text: string; readonly kind: FactKind }[] = [
    { text: summaryNote(record), kind: "note" },
    ...facts.decisions.map((t) => ({ text: t, kind: "decision" as const })),
    ...facts.failures.map((t) => ({ text: t, kind: "fact" as const })),
    ...facts.preferences.map((t) => ({ text: t, kind: "fact" as const })),
    ...facts.conventions.map((t) => ({ text: t, kind: "fact" as const })),
  ];
  const items = all.slice(0, MAX_RUN_FACTS);
  const saveOpts = { ...(opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {}), busyTimeoutMs: CAPTURE_BUSY_TIMEOUT_MS };
  // One connection for the whole capture (saving 40 facts one by one reopened, probed and migrated the database 40 times).
  const results = saveFacts(items.map((it) => ({ text: it.text, project, kind: it.kind, source })), saveOpts);
  // A goal that quotes an instruction makes the store refuse the whole summary note; the run still deserves one, without the goal.
  const first = results[0];
  let saved = 0;
  let deduped = 0;
  let refused = 0;
  let redacted = 0;
  const reasons: string[] = [];
  if (first !== undefined && !first.ok) {
    // The refusal still happened and is still reported; the fallback note is counted on its own.
    refused += 1;
    reasons.push(refusalClass(first.error.message));
    results[0] = saveFacts([{ text: summaryNote(record, false), project, kind: "note", source }], saveOpts)[0] as SaveFactsEntry; // one input, one result
  }
  for (const r of results) {
    if (r.ok) {
      if (r.result.deduped) deduped += 1;
      else saved += 1;
      redacted += r.result.redactions.length;
    } else {
      refused += 1;
      reasons.push(refusalClass(r.error.message));
    }
  }
  return { saved, deduped, refused, redacted, reasons, truncated: all.length - items.length };
}
