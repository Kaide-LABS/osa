// Implements PHASE_5_SPEC.md §6.2
//
// `assessAcceptanceEvidence()` -- the acceptance harness's own re-derivation of PRD §2's AC1/AC2/AC3
// straight from a completed run's persisted `HandoffRecord` files, independently of and without
// trusting any report the run itself produced live. Every sub-check is [DET]: a deterministic
// re-derivation from artifacts already on disk (`readHandoffRecord`, `verifyContinuation`,
// `assertLooprArtifactsReferenced`, `assertNextPhaseSpecProduced`, `nextPhaseSpecPath` -- all Phase
// 1/4, unmodified), never an LLM self-report, matching PRD §7 I2. This module imports only `node:fs`
// for directory/file enumeration -- no `runProcess`, no `node:child_process` -- and never mutates the
// target repo.

import { readFile, readdir } from "node:fs/promises";
import type { HandoffRecord } from "../domain/relay.ts";
import { readHandoffRecord } from "../domain/relay.ts";
import { LooprArtifactBypassError } from "../domain/errors.ts";
import type { ProviderId } from "../domain/run.ts";
import type { ContinuityCheckId, ContinuityVerdictLabel } from "../verify/continuity.ts";
import { verifyContinuation } from "../verify/continuity.ts";
import type { LooprArtifactPaths } from "./artifacts.ts";
import { assertLooprArtifactsReferenced, assertNextPhaseSpecProduced, nextPhaseSpecPath } from "./artifacts.ts";

/** One consecutive-pair continuity re-check, as reported inside {@link AcceptanceEvidence.ac1}. */
export interface AcceptanceContinuityEntry {
  readonly fromTurnIndex: number;
  readonly toTurnIndex: number;
  readonly verdict: ContinuityVerdictLabel;
  readonly failedCheckIds: readonly ContinuityCheckId[];
}

/** One persisted turn's reference-attestation re-check, as reported inside {@link AcceptanceEvidence.ac3}. */
export interface AcceptanceReferenceEntry {
  readonly turnIndex: number;
  readonly archetype: "executor" | "reviewer";
  readonly provider: ProviderId;
  readonly status: "completed" | "blocked" | "halted";
  readonly artifactsReferenced: boolean;
  readonly missingArtifactPaths: readonly string[];
}

/** The reviewer turn's real-production re-check, or `null` iff no reviewer turn was found. */
export interface AcceptanceProduction {
  readonly satisfied: boolean;
  readonly detail: string;
}

/** The full, deterministic re-derivation of PRD §2's AC1/AC2/AC3 for one persisted run. */
export interface AcceptanceEvidence {
  readonly repoDir: string;
  readonly runId: string;
  readonly finalPhase: boolean;
  readonly turnsFound: number;
  readonly ac1: {
    readonly satisfied: boolean;
    readonly detail: string;
    readonly providerSequence: readonly ProviderId[];
    readonly continuity: readonly AcceptanceContinuityEntry[];
  };
  readonly ac2: {
    readonly satisfied: boolean;
    readonly detail: string;
    readonly turnStatuses: readonly { readonly turnIndex: number; readonly status: string }[];
  };
  readonly ac3: {
    readonly satisfied: boolean;
    readonly detail: string;
    readonly references: readonly AcceptanceReferenceEntry[];
    readonly production: AcceptanceProduction | null;
  };
  readonly problems: readonly string[];
}

/**
 * The scoping note attached to every {@link AcceptanceEvidence.ac2} `detail` (satisfied or not):
 * this offline audit cannot re-observe, after the fact, whether a turn's child process ever had a
 * TTY on its stdin -- that guarantee is structural to `runProcess()`'s own closed-stdin/
 * mandatory-timeout design (PHASE_1_SPEC.md §6.1, PRD FM7), not re-derived here. What this check can
 * honestly assert is the necessary downstream consequence: a run that hung on an interactive prompt
 * would never have produced three persisted, "completed" records at all (it would have hit
 * `TurnTimeoutError` first), so their presence is genuine, if indirect, evidence for AC2. Implements
 * PHASE_5_SPEC.md §6.2 step 4.
 */
const AC2_SCOPE_NOTE =
  'This command cannot re-verify, after the fact, that a turn\'s stdin was never inherited from a ' +
  "TTY -- that guarantee is structural to runProcess()'s own closed-stdin/mandatory-timeout design " +
  "(PHASE_1_SPEC.md §6.1, PRD FM7), not re-derived here. What it can honestly assert is the " +
  'necessary downstream consequence: a run that hung on an interactive prompt would never have ' +
  'produced persisted, "completed" records at all (it would have hit TurnTimeoutError first), so ' +
  "their presence is genuine, if indirect, evidence for AC2.";

function emptyEvidence(
  repoDir: string,
  runId: string,
  finalPhase: boolean,
  problems: readonly string[],
): AcceptanceEvidence {
  const noTurns = "No persisted turns were available to assess.";
  return {
    repoDir,
    runId,
    finalPhase,
    turnsFound: 0,
    ac1: { satisfied: false, detail: noTurns, providerSequence: [], continuity: [] },
    ac2: { satisfied: false, detail: `${noTurns} ${AC2_SCOPE_NOTE}`, turnStatuses: [] },
    ac3: { satisfied: false, detail: noTurns, references: [], production: null },
    problems: [...problems],
  };
}

/**
 * [DET, DECISION Phase 5] AC1 (cross-provider continuity) re-derivation: exactly 3 persisted turns,
 * shaped executor/executor/reviewer
 * (`planTurnSequence`'s own fixed shape, Phase 3; the two executors may be the same provider on different models), and both consecutive-pair
 * `verifyContinuation()` calls (Phase 1, unmodified) returning `CONTINUED`. `providerSequence` is
 * always `records.map(r => r.provider)`, regardless of outcome, so a failing run's evidence still
 * shows which providers were actually dispatched. A `ContinuityError` from `verifyContinuation()`'s
 * own C1 bad-object path is folded into an unsatisfied verdict rather than propagated, so this
 * function never throws for a modelled outcome (§6.2 step 6). Implements PHASE_5_SPEC.md §6.2 step 3.
 */
async function assessAc1(
  repoDir: string,
  records: readonly HandoffRecord[],
): Promise<AcceptanceEvidence["ac1"]> {
  const providerSequence = records.map((r) => r.provider);

  if (records.length !== 3) {
    return {
      satisfied: false,
      detail: `AC1 requires exactly 3 persisted turns; found ${String(records.length)}.`,
      providerSequence,
      continuity: [],
    };
  }

  const first = records[0] as HandoffRecord;
  const second = records[1] as HandoffRecord;
  const third = records[2] as HandoffRecord;

  const structuralProblems: string[] = [];
  if (first.role !== "executor") {
    structuralProblems.push(`turn ${String(first.turn_index)}'s role is "${first.role}", expected "executor"`);
  }
  if (second.role !== "executor") {
    structuralProblems.push(`turn ${String(second.turn_index)}'s role is "${second.role}", expected "executor"`);
  }
  if (third.role !== "reviewer") {
    structuralProblems.push(`turn ${String(third.turn_index)}'s role is "${third.role}", expected "reviewer"`);
  }
  // The two executor turns may report the same provider (two seats on different models of one provider): that is a valid run, and the
  // continuity checks below are what prove the second turn really continued the first one's work.

  if (structuralProblems.length > 0) {
    return {
      satisfied: false,
      detail: `AC1 structural requirements not met: ${structuralProblems.join("; ")}.`,
      providerSequence,
      continuity: [],
    };
  }

  let verdict1: { readonly verdict: ContinuityVerdictLabel; readonly failedCheckIds: readonly ContinuityCheckId[] };
  let verdict2: { readonly verdict: ContinuityVerdictLabel; readonly failedCheckIds: readonly ContinuityCheckId[] };
  try {
    verdict1 = await verifyContinuation(repoDir, first, second);
    verdict2 = await verifyContinuation(repoDir, second, third);
  } catch (err) {
    return {
      satisfied: false,
      detail: `AC1 continuity re-verification failed to run: ${err instanceof Error ? err.message : String(err)}.`,
      providerSequence,
      continuity: [],
    };
  }

  const continuity: readonly AcceptanceContinuityEntry[] = [
    {
      fromTurnIndex: first.turn_index,
      toTurnIndex: second.turn_index,
      verdict: verdict1.verdict,
      failedCheckIds: verdict1.failedCheckIds,
    },
    {
      fromTurnIndex: second.turn_index,
      toTurnIndex: third.turn_index,
      verdict: verdict2.verdict,
      failedCheckIds: verdict2.failedCheckIds,
    },
  ];
  const satisfied = verdict1.verdict === "CONTINUED" && verdict2.verdict === "CONTINUED";
  return {
    satisfied,
    detail: satisfied
      ? "Both consecutive continuity re-checks (executor->executor, executor->reviewer) returned CONTINUED."
      : `Continuity re-check failed: turn ${String(first.turn_index)}->${String(second.turn_index)} ` +
        `verdict ${verdict1.verdict}, turn ${String(second.turn_index)}->${String(third.turn_index)} ` +
        `verdict ${verdict2.verdict}.`,
    providerSequence,
    continuity,
  };
}

/**
 * [DET, DECISION Phase 5] AC2 (clean, non-interactive completion) re-derivation: exactly 3 persisted
 * turns, every one reporting `status === "completed"`. A `"blocked"`/`"halted"` record means the run
 * stopped itself deliberately, distinguished in `detail` from a timeout/hang. Implements
 * PHASE_5_SPEC.md §6.2 step 4.
 */
function assessAc2(records: readonly HandoffRecord[]): AcceptanceEvidence["ac2"] {
  const turnStatuses = records.map((r) => ({ turnIndex: r.turn_index, status: r.status }));
  const notCompleted = records.filter((r) => r.status !== "completed");
  const satisfied = records.length === 3 && notCompleted.length === 0;

  let detail: string;
  if (records.length !== 3) {
    detail = `AC2 requires exactly 3 persisted turns; found ${String(records.length)}. ${AC2_SCOPE_NOTE}`;
  } else if (notCompleted.length > 0) {
    const names = notCompleted.map((r) => `turn ${String(r.turn_index)}: "${r.status}"`).join(", ");
    detail =
      `Not every turn completed cleanly (${names}) -- a "blocked"/"halted" record means the run ` +
      `stopped itself deliberately, not that it hung. ${AC2_SCOPE_NOTE}`;
  } else {
    detail = `All 3 persisted turns report status "completed". ${AC2_SCOPE_NOTE}`;
  }

  return { satisfied, detail, turnStatuses };
}

function basenameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Detects this module's own disclosed derivation limitation (§6.2 step 5): a record's
 * `artifacts_read` may genuinely reference `basename` under a different path than the one this
 * function derived from the reviewer's `spec_ref.path` directory prefix. Returns that other path, or
 * `null` if no such entry exists.
 */
function findBasenameElsewhere(record: HandoffRecord, derivedPath: string, basename: string): string | null {
  const found = record.artifacts_read.find((a) => a.path !== derivedPath && basenameOf(a.path) === basename);
  return found === undefined ? null : found.path;
}

/**
 * If `specPath` is an OSA spec (`runs/<osa-run-id>/spec/...`), the repo-relative path of that run's locked baby PRD, read
 * from its `prd.lock.json`; otherwise `null` (the caller falls back to the loopr convention). Never throws.
 */
export async function resolveOsaPrdPath(repoDir: string, specPath: string): Promise<string | null> {
  const m = specPath.match(/^runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/spec\//i);
  if (m?.[1] === undefined) return null;
  try {
    const rec: unknown = JSON.parse(await readFile(`${repoDir}/.osa/runs/${m[1]}/prd.lock.json`, "utf8"));
    const p = typeof rec === "object" && rec !== null ? (rec as Record<string, unknown>)["prd_path"] : undefined;
    return typeof p === "string" && p !== "" ? p : null;
  } catch {
    return null;
  }
}

/**
 * [DET, DECISION Phase 5] AC3 (reference and production) re-derivation. Derives `baby_prd.md`/
 * `context.md`'s expected repo-relative paths once, from the reviewer turn's own persisted
 * `spec_ref.path` directory prefix (this module's own documented assumption -- a target build whose
 * `baby_prd_path`/`context_path` do not share `spec_path`'s directory will report a false
 * `artifactsReferenced: false` here even if the live run's own guards genuinely passed;
 * `findBasenameElsewhere` detects and surfaces that specific case in `detail` rather than silently
 * misreporting it). Re-runs `assertLooprArtifactsReferenced()` (Phase 4, unmodified) per persisted
 * turn using that turn's own `spec_ref.path` as the expected spec path, and, for the reviewer turn
 * specifically, `assertNextPhaseSpecProduced()` (Phase 4, unmodified) against
 * `nextPhaseSpecPath(reviewerRecord.spec_ref.path, reviewerRecord.phase, finalPhase)`. If no reviewer
 * turn was found among the persisted records, `baby_prd.md`/`context.md` cannot be derived at all
 * (there is no other source for them, by this module's own documented design), so AC3 is reported
 * unsatisfied with `production: null` rather than guessed. Implements PHASE_5_SPEC.md §6.2 step 5.
 */
async function assessAc3(
  repoDir: string,
  records: readonly HandoffRecord[],
  finalPhase: boolean,
): Promise<AcceptanceEvidence["ac3"]> {
  const reviewerRecord = records.find((r) => r.role === "reviewer") ?? null;

  if (reviewerRecord === null) {
    return {
      satisfied: false,
      detail:
        "No reviewer turn was found among the persisted records. This module derives the expected " +
        "baby_prd.md/context.md paths from the reviewer turn's own spec_ref.path directory prefix " +
        "(PHASE_5_SPEC.md §6.2 step 5's documented assumption); without a reviewer record, AC3 cannot " +
        "be assessed.",
      references: [],
      production: null,
    };
  }

  const lastSlash = reviewerRecord.spec_ref.path.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : reviewerRecord.spec_ref.path.slice(0, lastSlash + 1);
  // OSA runs keep the locked PRD at runs/<id>/baby-prd.md, not beside the spec; its lock record names the real path
  // (found by the first live run: this command wrongly reported AC3 unsatisfied for a build whose live guard passed).
  const babyPrdPath = (await resolveOsaPrdPath(repoDir, reviewerRecord.spec_ref.path)) ?? `${dir}baby_prd.md`;
  const contextPath = `${dir}context.md`;

  const references: AcceptanceReferenceEntry[] = [];
  const mismatchNotes: string[] = [];

  for (const record of records) {
    const expected: LooprArtifactPaths = { babyPrdPath, contextPath, specPath: record.spec_ref.path };
    let artifactsReferenced = true;
    let missingArtifactPaths: readonly string[] = [];
    try {
      assertLooprArtifactsReferenced(record, expected);
    } catch (err) {
      artifactsReferenced = false;
      missingArtifactPaths =
        err instanceof LooprArtifactBypassError && Array.isArray(err.details["missingPaths"])
          ? (err.details["missingPaths"] as readonly string[])
          : [];
      for (const [label, basename] of [
        [babyPrdPath, "baby_prd.md"],
        [contextPath, "context.md"],
      ] as const) {
        if (missingArtifactPaths.includes(label)) {
          const elsewhere = findBasenameElsewhere(record, label, basename);
          if (elsewhere !== null) {
            mismatchNotes.push(
              `turn ${String(record.turn_index)} references "${basename}" at "${elsewhere}", not the ` +
                `expected "${label}" (derived from the reviewer's spec_ref directory) -- this may be a ` +
                "false negative caused by this module's own derivation limitation, not necessarily a " +
                "genuine bypass.",
            );
          }
        }
      }
    }
    references.push({
      turnIndex: record.turn_index,
      archetype: record.role,
      provider: record.provider,
      status: record.status,
      artifactsReferenced,
      missingArtifactPaths,
    });
  }

  const expectedNextPath = nextPhaseSpecPath(reviewerRecord.spec_ref.path, reviewerRecord.phase, finalPhase);
  let production: AcceptanceProduction;
  try {
    await assertNextPhaseSpecProduced(repoDir, reviewerRecord, expectedNextPath);
    production = { satisfied: true, detail: `The reviewer turn genuinely produced "${expectedNextPath}" (declared and turn-committed).` };
  } catch (err) {
    production = { satisfied: false, detail: err instanceof Error ? err.message : String(err) };
  }

  const allReferenced = references.every((r) => r.artifactsReferenced);
  const satisfied = allReferenced && production.satisfied;

  const detailParts: string[] = [
    allReferenced
      ? "Every persisted turn's reconciled artifacts_read genuinely referenced baby_prd.md, context.md, and its own phase spec."
      : `${String(references.filter((r) => !r.artifactsReferenced).length)} of ${String(references.length)} turn(s) failed to reference one or more required loopr artifacts.`,
    production.satisfied ? `Production check passed: ${production.detail}` : `Production check failed: ${production.detail}`,
  ];
  if (mismatchNotes.length > 0) {
    detailParts.push(`Note: ${mismatchNotes.join(" ")}`);
  }

  return { satisfied, detail: detailParts.join(" "), references, production };
}

/**
 * [DET] Re-derives PRD §2's AC1/AC2/AC3 for one already-completed run, purely by reading its
 * persisted `HandoffRecord` files back off disk -- never by trusting any report the run itself
 * produced live, and never by spawning a `claude`/`codex` process. Enumerates
 * `<repoDir>/.osa/runs/<runId>/handoff/` (via `fs.readdir`, no glob dependency): a missing
 * directory or zero phase subdirectories yields `turnsFound: 0` with every AC unsatisfied and a
 * `problems` entry naming the missing path; more than one phase subdirectory yields every AC
 * unsatisfied with a `problems` entry naming every phase number found (this function assesses
 * exactly one phase's worth of evidence per call, matching V1's "no multi-phase autonomous looping"
 * restriction). A parse failure on any individual turn file is a `problems` entry naming the file and
 * the error; that record is dropped from the set and `turnsFound` reflects only the records that
 * parsed. Never throws for any input short of a genuine programming error. Implements
 * PHASE_5_SPEC.md §6.2.
 */
export async function assessAcceptanceEvidence(
  repoDir: string,
  runId: string,
  finalPhase: boolean,
): Promise<AcceptanceEvidence> {
  const handoffRoot = `${repoDir}/.osa/runs/${runId}/handoff`;

  let phaseDirNames: string[];
  try {
    const entries = await readdir(handoffRoot, { withFileTypes: true });
    phaseDirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (err) {
    return emptyEvidence(repoDir, runId, finalPhase, [
      `No persisted handoff records found: "${handoffRoot}" does not exist or is not readable ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    ]);
  }

  if (phaseDirNames.length === 0) {
    return emptyEvidence(repoDir, runId, finalPhase, [`No phase subdirectory found under "${handoffRoot}".`]);
  }
  if (phaseDirNames.length > 1) {
    return emptyEvidence(repoDir, runId, finalPhase, [
      `More than one phase subdirectory found under "${handoffRoot}": ${phaseDirNames.join(", ")}. ` +
        "assessAcceptanceEvidence() assesses exactly one phase's worth of evidence per call.",
    ]);
  }

  const phaseDir = `${handoffRoot}/${phaseDirNames[0] as string}`;
  const problems: string[] = [];

  let turnFileNames: string[];
  try {
    turnFileNames = (await readdir(phaseDir)).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    return emptyEvidence(repoDir, runId, finalPhase, [
      `Failed to list turn files under "${phaseDir}": ${err instanceof Error ? err.message : String(err)}.`,
    ]);
  }

  const records: HandoffRecord[] = [];
  for (const fileName of turnFileNames) {
    const absPath = `${phaseDir}/${fileName}`;
    try {
      records.push(await readHandoffRecord(absPath));
    } catch (err) {
      problems.push(`Failed to parse handoff record "${absPath}": ${err instanceof Error ? err.message : String(err)}.`);
    }
  }

  const turnsFound = records.length;
  const ac1 = await assessAc1(repoDir, records);
  const ac2 = assessAc2(records);
  const ac3 = await assessAc3(repoDir, records, finalPhase);

  return { repoDir, runId, finalPhase, turnsFound, ac1, ac2, ac3, problems };
}
