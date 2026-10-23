// Implements PHASE_5_SPEC.md §6.5, §3.3
//
// The `evidence` CLI command: reads a completed run's persisted `HandoffRecord` files via
// `assessAcceptanceEvidence()` (`src/dispatch/acceptance.ts`) and reports AC1/AC2/AC3. Mirrors
// `src/cli/doctor.ts`'s and `src/cli/run.ts`'s own shape exactly: a function that returns
// `{report, exitCode}` and never calls `process.exit`.

import { z } from "zod";
import { ExitCode, InternalError } from "../domain/errors.ts";
import { IsoUtc, RunId } from "../domain/relay.ts";
import { ProviderIdSchema } from "../domain/run.ts";
import { assessAcceptanceEvidence } from "../dispatch/acceptance.ts";

/** The `evidence --json` output shape (PHASE_5_SPEC.md §3.3). Mirrors `DoctorReport`'s/`RunReport`'s own shape. */
export const EvidenceReport = z.strictObject({
  schema_version: z.literal(1),
  generated_at: IsoUtc,
  repo_dir: z.string().min(1),
  run_id: RunId,
  final_phase: z.boolean(),
  ok: z.boolean(),
  exit_code: z.number().int(),
  turns_found: z.number().int().min(0),
  ac1: z.strictObject({
    satisfied: z.boolean(),
    detail: z.string(),
    provider_sequence: z.array(ProviderIdSchema),
    continuity: z.array(
      z.strictObject({
        from_turn_index: z.number().int(),
        to_turn_index: z.number().int(),
        verdict: z.enum(["CONTINUED", "REDO", "PARTIAL_REVERT", "IGNORED", "DIVERGED"]),
        failed_check_ids: z.array(z.string()),
      }),
    ),
  }),
  ac2: z.strictObject({
    satisfied: z.boolean(),
    detail: z.string(),
    turn_statuses: z.array(
      z.strictObject({
        turn_index: z.number().int(),
        status: z.enum(["completed", "blocked", "halted"]),
      }),
    ),
  }),
  ac3: z.strictObject({
    satisfied: z.boolean(),
    detail: z.string(),
    references: z.array(
      z.strictObject({
        turn_index: z.number().int(),
        archetype: z.enum(["executor", "reviewer"]),
        provider: ProviderIdSchema,
        artifacts_referenced: z.boolean(),
        missing_artifact_paths: z.array(z.string()),
      }),
    ),
    production: z.strictObject({ satisfied: z.boolean(), detail: z.string() }).nullable(),
  }),
  problems: z.array(z.string()),
});

/** The inferred type of {@link EvidenceReport}. */
export type EvidenceReport = z.infer<typeof EvidenceReport>;

/** `evidence` command options, derived from CLI flags (`src/cli/main.ts`). */
export interface EvidenceCommandOptions {
  readonly repoDir: string;
  readonly runId: string;
  readonly finalPhase: boolean;
  readonly json: boolean;
}

/**
 * Narrows a `HandoffRecord.status` value (already constrained to exactly these three literals by
 * `HandoffRecord`'s own zod schema, Phase 1, unmodified) to the literal union `EvidenceReport`'s
 * wire schema requires. Throws {@link InternalError} on any other input -- unreachable given every
 * `AcceptanceEvidence.ac2.turnStatuses` entry is sourced from a real `HandoffRecord.status`, defended
 * anyway per this codebase's established "exhaustive-over-a-closed-set, defend at runtime" idiom
 * (`src/dispatch/plan.ts`'s `otherExecutorProvider`).
 */
function narrowTurnStatus(status: string): "completed" | "blocked" | "halted" {
  if (status === "completed" || status === "blocked" || status === "halted") {
    return status;
  }
  throw new InternalError(`narrowTurnStatus: unreachable status "${status}"`, { status });
}

/**
 * Calls `assessAcceptanceEvidence(opts.repoDir, opts.runId, opts.finalPhase)` (§6.2), translates the
 * returned `AcceptanceEvidence` into `EvidenceReport`'s snake_case wire shape, computes
 * `ok = evidence.turnsFound === 3 && evidence.ac1.satisfied && evidence.ac2.satisfied &&
 * evidence.ac3.satisfied` (the same formula `assessAcceptanceEvidence()`'s own §6.2 step 6 computes
 * internally -- `AcceptanceEvidence` itself carries no `ok` field, so this command recomputes it from
 * the returned evidence's own fields rather than adding one to the plain, in-process-only type) and
 * `exit_code = ok ? ExitCode.OK : ExitCode.ACCEPTANCE_INCOMPLETE`. **Never calls `process.exit`** --
 * only `main.ts`'s own entry guard does, the same rule every prior CLI command function in this
 * project already follows (`runDoctor()`, `runRunCommand()`). Implements PHASE_5_SPEC.md §6.5.
 */
export async function runEvidenceCommand(
  opts: EvidenceCommandOptions,
): Promise<{ report: EvidenceReport; exitCode: number }> {
  const evidence = await assessAcceptanceEvidence(opts.repoDir, opts.runId, opts.finalPhase);
  const ok = evidence.turnsFound === 3 && evidence.ac1.satisfied && evidence.ac2.satisfied && evidence.ac3.satisfied;
  const exitCode = ok ? ExitCode.OK : ExitCode.ACCEPTANCE_INCOMPLETE;

  const report: EvidenceReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    repo_dir: evidence.repoDir,
    run_id: evidence.runId,
    final_phase: evidence.finalPhase,
    ok,
    exit_code: exitCode,
    turns_found: evidence.turnsFound,
    ac1: {
      satisfied: evidence.ac1.satisfied,
      detail: evidence.ac1.detail,
      provider_sequence: [...evidence.ac1.providerSequence],
      continuity: evidence.ac1.continuity.map((c) => ({
        from_turn_index: c.fromTurnIndex,
        to_turn_index: c.toTurnIndex,
        verdict: c.verdict,
        failed_check_ids: [...c.failedCheckIds],
      })),
    },
    ac2: {
      satisfied: evidence.ac2.satisfied,
      detail: evidence.ac2.detail,
      turn_statuses: evidence.ac2.turnStatuses.map((t) => ({
        turn_index: t.turnIndex,
        status: narrowTurnStatus(t.status),
      })),
    },
    ac3: {
      satisfied: evidence.ac3.satisfied,
      detail: evidence.ac3.detail,
      references: evidence.ac3.references.map((r) => ({
        turn_index: r.turnIndex,
        archetype: r.archetype,
        provider: r.provider,
        artifacts_referenced: r.artifactsReferenced,
        missing_artifact_paths: [...r.missingArtifactPaths],
      })),
      production:
        evidence.ac3.production === null
          ? null
          : { satisfied: evidence.ac3.production.satisfied, detail: evidence.ac3.production.detail },
    },
    problems: [...evidence.problems],
  };

  return { report, exitCode };
}
