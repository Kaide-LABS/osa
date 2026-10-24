// Turns a finished run's RECORD into memory facts (OSA_DIRECTIVE.md WS8: "written at run end from the run log, not
// mid-run chatter"). Deterministic: no model call. Everything here is a recorded outcome -- what the person locked, what
// the spec and architecture decided, what failed and how, and what the person changed at the lock -- never conversation.

import type { BabyPrd } from "../domain/intake.ts";
import { appendFacts, MEMORY_CATEGORIES, MEMORY_DIR_REL } from "./store.ts";
import type { AppendResult, MemoryCategory } from "./store.ts";
import type { EventSink } from "../osa/events.ts";
import { commitPaths, isPathIgnored } from "../verify/git.ts";

/** One phase as recorded by the run. */
export interface PhaseRecord {
  readonly phase: number;
  readonly ok: boolean;
  readonly retriedTurns: number;
  readonly problems: readonly string[];
}

/** Everything a run knows about itself at its end. */
export interface RunRecord {
  readonly runId: string;
  readonly date: string;
  /** The PRD intake generated, before any edit at the lock. */
  readonly prdGenerated: BabyPrd;
  /** The PRD the person locked. */
  readonly prdLocked: BabyPrd;
  readonly outcome: "finished" | "stopped";
  readonly stoppedBecause: string | null;
  readonly specAssumptions: readonly string[];
  readonly architecture: { readonly chosen: string; readonly why: string } | null;
  /** Research claims the cross-provider check did not confirm. */
  readonly flaggedClaims: readonly string[];
  readonly failedResearchItems: readonly { readonly slug: string; readonly problem: string }[];
  readonly phases: readonly PhaseRecord[];
  /** Unmet requirements from the application check, and a could-not-run reason. */
  readonly applicationUnmet: readonly { readonly text: string; readonly reason: string | null }[];
  readonly applicationCouldNotRun: string | null;
  /** False for a spec-only run (nothing was built, so phase and requirement counts mean nothing). Absent = built. */
  readonly built?: boolean;
  /** False when the final application check did not run at all (switched off, or the build stopped first). Absent = it ran. */
  readonly applicationChecked?: boolean;
}

/** Facts per category. */
export type DerivedFacts = Readonly<Record<MemoryCategory, readonly string[]>>;

const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
// An absolute Windows (C:\...) or POSIX (/home/..., /tmp/...) path: machine-specific noise in a project's memory.
const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|(?<![\w.])\/(?:home|tmp|var|Users|private|mnt)\/)[^\s'"`)]+/g;

/**
 * One memory-ready line: run ids and machine-specific absolute paths scrubbed (a failure note that says
 * "Failed to parse C:\Users\x\...\84ef52b0-....json" is junk the next run cannot use), byte-order marks dropped,
 * whitespace collapsed, length bounded. Pure.
 */
export function clip(s: string, max = 280): string {
  const one = s.replace(/\uFEFF/g, "").replace(UUID_RE, "<id>").replace(ABS_PATH_RE, "<path>").replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  // Cut at a word boundary, never inside a token: a key cut in half is too short for any secret rule to recognise and would be stored as a fragment.
  const window = one.slice(0, max - 3);
  const space = window.lastIndexOf(" ");
  return `${(space >= Math.floor(max / 2) ? window.slice(0, space) : window).trimEnd()}...`;
}

function added(before: readonly string[], after: readonly string[]): string[] {
  const b = new Set(before.map((x) => x.trim().toLowerCase()));
  return after.filter((x) => !b.has(x.trim().toLowerCase()));
}

/** Derives the facts. Pure. */
export function deriveFacts(r: RunRecord): DerivedFacts {
  const decisions: string[] = [];
  const conventions: string[] = [];
  const failures: string[] = [];
  const preferences: string[] = [];
  const locked = r.prdLocked;

  for (const a of locked.assumptions.filter((x) => x.risk === "risky")) decisions.push(clip(`Accepted risky assumption: ${a.text}`));
  if (r.architecture !== null) {
    decisions.push(clip(`Architecture: ${r.architecture.chosen === "planned" ? "kept the planned architecture" : `adopted "${r.architecture.chosen}"`} -- ${r.architecture.why}`));
  }
  for (const s of r.specAssumptions.slice(0, 8)) decisions.push(clip(`Spec decision: ${s}`));
  for (const o of locked.outOfScope.slice(0, 5)) decisions.push(clip(`Out of scope: ${o}`));

  if (locked.researchPlan.docsTargets.length > 0) conventions.push(clip(`Technologies/libraries this project documents and relies on: ${locked.researchPlan.docsTargets.join(", ")}`));
  for (const c of locked.constraints.slice(0, 5)) conventions.push(clip(`Constraint: ${c}`));

  if (r.outcome === "stopped" && r.stoppedBecause !== null) failures.push(clip(`Run stopped: ${r.stoppedBecause}`));
  for (const p of r.phases) {
    if (!p.ok) failures.push(clip(`Phase ${String(p.phase)} did not complete${p.problems[0] !== undefined ? `: ${p.problems[0]}` : ""}`));
    else if (p.retriedTurns > 0) failures.push(clip(`Phase ${String(p.phase)} needed ${String(p.retriedTurns)} retry(ies) after a continuity failure, then passed`));
  }
  for (const u of r.applicationUnmet) failures.push(clip(`Final check found a requirement NOT met: ${u.text}${u.reason !== null ? ` (${u.reason})` : ""}`));
  if (r.applicationCouldNotRun !== null) failures.push(clip(`The final check could not be carried out: ${r.applicationCouldNotRun}`));
  for (const c of r.flaggedClaims.slice(0, 5)) failures.push(clip(`Unconfirmed research claim (do not rely on it): ${c}`));
  for (const f of r.failedResearchItems) failures.push(clip(`Research item ${f.slug} failed: ${f.problem}`));

  // Preferences = what the person changed between the generated PRD and the one they locked.
  const gen = r.prdGenerated;
  for (const x of added(gen.inScope, locked.inScope).slice(0, 2)) preferences.push(clip(`Wanted in scope: ${x}`));
  for (const x of added(locked.inScope, gen.inScope).slice(0, 2)) preferences.push(clip(`Did not want in scope: ${x}`));
  for (const x of added(gen.outOfScope, locked.outOfScope).slice(0, 2)) preferences.push(clip(`Wanted out of scope: ${x}`));
  for (const x of added(gen.acceptanceCriteria, locked.acceptanceCriteria).slice(0, 2)) preferences.push(clip(`Added acceptance criterion: ${x}`));
  const genRisky = new Set(gen.assumptions.filter((a) => a.risk === "risky").map((a) => a.text.trim().toLowerCase()));
  for (const a of locked.assumptions) if (a.risk === "safe" && genRisky.has(a.text.trim().toLowerCase())) preferences.push(clip(`Treats as safe: ${a.text}`));

  return { decisions, conventions, failures, preferences };
}

/** The outcome of {@link writeRunMemory}. */
export interface WriteMemoryResult {
  readonly byCategory: Readonly<Record<MemoryCategory, AppendResult>>;
  readonly appended: number;
  readonly rejected: number;
  readonly committed: boolean;
}

/**
 * Writes the facts derived from `record` and commits `.osa/memory` -- unless that path is git-ignored (memory is
 * "git-ignorable"), in which case it is left alone. Emits `memory_written`. Rejected facts (secret-shaped, too long)
 * are counted in the event and returned, never dropped silently.
 */
export async function writeRunMemory(repoDir: string, record: RunRecord, opts: { readonly maxFacts?: number; readonly events?: EventSink; readonly commit?: boolean } = {}): Promise<WriteMemoryResult> {
  const facts = deriveFacts(record);
  const byCategory = {} as Record<MemoryCategory, AppendResult>;
  for (const c of MEMORY_CATEGORIES) {
    byCategory[c] = await appendFacts(repoDir, c, facts[c], { runId: record.runId, date: record.date, ...(opts.maxFacts !== undefined ? { maxFacts: opts.maxFacts } : {}) });
  }
  const appended = MEMORY_CATEGORIES.reduce((n, c) => n + byCategory[c].appended.length, 0);
  const rejected = MEMORY_CATEGORIES.reduce((n, c) => n + byCategory[c].rejected.length, 0);
  let committed = false;
  if (appended > 0 && opts.commit !== false && !(await isPathIgnored(repoDir, `${MEMORY_DIR_REL}/decisions.md`))) {
    await commitPaths(repoDir, `chore: project memory from OSA run ${record.runId}`, [MEMORY_DIR_REL]);
    committed = true;
  }
  await opts.events?.emit("memory_written", {
    runId: record.runId,
    appended,
    rejected,
    duplicates: MEMORY_CATEGORIES.reduce((n, c) => n + byCategory[c].duplicates.length, 0),
    byCategory: Object.fromEntries(MEMORY_CATEGORIES.map((c) => [c, byCategory[c].appended.length])),
    rejectedReasons: MEMORY_CATEGORIES.flatMap((c) => byCategory[c].rejected.map((x) => x.reason)),
    committed,
  });
  return { byCategory, appended, rejected, committed };
}
