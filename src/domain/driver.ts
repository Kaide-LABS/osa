// Implements PHASE_6_SPEC.md §3.1-§3.6
//
// Driver-level schemas and types: `DriveConfig` (one driver invocation's operator-supplied
// configuration), the six-member `DriverStateId` enumeration and the three-member
// `DriverDecisionKind` enumeration (the two closed sets baby_prd.md acceptance criteria 1/2 name),
// and `DriverLogEntry` (one line of the append-only dispatch log, §3.5). Zero I/O, zero provider
// knowledge -- the same remit `src/domain/run.ts` already has for `RunConfig`.
//
// `RepoRelPath`/`IsoUtc` are imported directly from `./relay.ts` here, not redeclared a third time
// the way `src/domain/run.ts` redeclares `RepoRelPath` locally as `RepoRelPathLike`. `run.ts`'s own
// file-header comment explains that redeclaration exists solely to avoid a runtime import cycle
// *between `relay.ts` and `run.ts` themselves* (`relay.ts` already imports `ProviderIdSchema` from
// `run.ts`, so `run.ts` cannot also import from `relay.ts` without a cycle). `driver.ts` is a new
// leaf module that neither `relay.ts` nor `run.ts` imports from, so no cycle risk exists here.

import { z } from "zod";
import { ProviderIdSchema, RolePinSchema } from "./run.ts";
import { IsoUtc, RepoRelPath } from "./relay.ts";

/**
 * Operator-supplied driver configuration. One `DriveConfig` describes one driver invocation, which
 * may dispatch many `RunConfig`s (one per target-build phase) over its lifetime. Implements
 * PHASE_6_SPEC.md §3.1.
 */
const DriveConfigShape = z.strictObject({
  repo_dir: z.string().min(1),
  /** Identifies this driver invocation's own dispatch-log directory (§3.5) -- distinct from, and never reused as, any individual phase's `RunConfig.run_id`. */
  driver_run_id: z.uuid(),
  /** The target build's own first phase to dispatch. Almost always `1`; not hardcoded, so a driver invocation can resume a target build partway through. */
  starting_phase: z.number().int().min(1).default(1),
  /** Repo-relative path to `starting_phase`'s own `PHASE_N_SPEC.md`. */
  starting_spec_path: RepoRelPath,
  baby_prd_path: RepoRelPath,
  context_path: RepoRelPath,
  /**
   * Repo-relative path to the completion marker the driver checks for after every dispatched
   * phase (and before its very first dispatch, in {@link checkDriverStartCoherence}). Defaults to
   * `"BUILD_COMPLETE.md"`, so every existing caller/config that omits this field keeps today's
   * exact behavior unchanged. Exists because a target repository can legitimately host more than
   * one loopr-managed build track at once, each with its own completion marker (e.g.
   * `BUILD_COMPLETE.md`, `BUILD_COMPLETE_ANON.md`, `BUILD_COMPLETE_V3.md`) -- the identical problem
   * the `--build-complete-path` option exists to solve.
   */
  build_complete_path: RepoRelPath.default("BUILD_COMPLETE.md"),
  /**
   * The target build's own declared total phase count, from *its own* modernised PRD's phase plan
   * (the same number a human operator manually re-invoking `OSA run` would already have had
   * to know to set `RunConfig.is_final_phase` correctly per dispatch -- see PHASE_6_SPEC.md §6.3 for
   * the full derivation). Required, never inferred: `RunConfig.is_final_phase`'s own doc comment
   * already establishes "operator-supplied per run -- OSA never infers it" as an existing,
   * unmodified invariant (`src/domain/run.ts`), and this field is what lets the driver honour that
   * invariant without asking the operator to set it by hand on every single phase.
   */
  target_total_phases: z.number().int().min(1),
  /** The AC6 cap. Sane default chosen for a target build expected to need low-single-digit-to-low-double-digit phases; generous enough not to trip on a legitimate build, small enough to bound a runaway reviewer. */
  max_phases: z.number().int().min(1).default(25),
  /** The two seats' providers. They may be the SAME provider when `seat_models` puts different models in them. */
  executor_providers: z.tuple([ProviderIdSchema, ProviderIdSchema]),
  /** The model of each seat, aligned with `executor_providers` (`null` = that provider's default). Absent = both default. */
  seat_models: z.tuple([z.string().min(1).nullable(), z.string().min(1).nullable()]).optional(),
  reviewer_provider: ProviderIdSchema.nullable().default(null),
  /** Same treatment as {@link RunConfig.role_pins} -- threaded unchanged into every phase's own
   * `RunConfig` by `buildPhaseRunConfig` (`src/dispatch/driver-loop.ts` §1.1). Implements
   * PHASE_7_SPEC.md §3.2. */
  role_pins: z.partialRecord(ProviderIdSchema, RolePinSchema).optional(),
  turn_timeout_ms: z.number().int().min(1000).max(7_200_000).default(1_800_000),
  model_overrides: z.partialRecord(ProviderIdSchema, z.string().min(1)).optional(),
  executor_prompt_path: RepoRelPath.optional(),
  reviewer_prompt_path: RepoRelPath.optional(),
  /** Same treatment as {@link RunConfig.chat_log_gitignored} -- threaded unchanged into every
   *  phase's own `RunConfig` by `buildPhaseRunConfig`. Read that field's doc comment: OSA
   *  does not claim a chat log is safe to commit. `DriveConfig` gets no `chat_log_id` field: a
   *  drive's log id **is** its `driver_run_id`. Implements PHASE_10_SPEC.md §3.9. */
  chat_log_gitignored: z.boolean().default(true),
});

/**
 * Object-level role-pinning refinements (RP1-RP4), byte-identical in substance to
 * `src/domain/run.ts`'s `RunConfig` refinements, chained onto {@link DriveConfigShape}'s own field
 * list. Implements PHASE_7_SPEC.md §3.3.
 */
export const DriveConfig = DriveConfigShape.refine(
  (c) => c.executor_providers.some((p) => c.role_pins?.[p] !== "reviewer"),
  {
    message: "role_pins must not pin every provider to reviewer -- no provider would be left eligible for the executor role (RP1)",
    path: ["role_pins"],
  },
).refine(
  (c) => c.executor_providers.some((p) => c.role_pins?.[p] !== "executor"),
  {
    message: "role_pins must not pin every provider to executor -- no provider would be left eligible for the reviewer role (RP2)",
    path: ["role_pins"],
  },
).refine(
  (c) => c.reviewer_provider === null || c.role_pins?.[c.reviewer_provider] !== "executor",
  {
    message: "reviewer_provider names a provider role_pins has pinned to executor -- conflicting reviewer configuration (RP3)",
    path: ["reviewer_provider"],
  },
).refine(
  (c) => c.reviewer_provider === null || c.executor_providers.every((p) => p === c.reviewer_provider || c.role_pins?.[p] !== "reviewer"),
  {
    message: "reviewer_provider disagrees with the provider role_pins has pinned to reviewer -- conflicting reviewer configuration (RP4)",
    path: ["reviewer_provider"],
  },
).refine(
  (c) => c.reviewer_provider === null || c.executor_providers.includes(c.reviewer_provider),
  { message: "reviewer_provider must be one of executor_providers -- a run activates exactly two providers, and a reviewer outside that pair would make three (RP5)", path: ["reviewer_provider"] },
).refine(
  (c) => c.role_pins === undefined || Object.keys(c.role_pins).every((p) => (c.executor_providers as readonly string[]).includes(p)),
  { message: "role_pins may only name providers listed in executor_providers -- pinning a role to a provider this run does not activate has no effect and would silently mislead (RP6)", path: ["role_pins"] },
);

/** The inferred type of {@link DriveConfig}. */
export type DriveConfig = z.infer<typeof DriveConfig>;

/**
 * The closed, enumerated driver state set (baby_prd.md acceptance criterion 1, verbatim). Exactly
 * six members: no phase run yet (D0); a phase that errored mid-run (D1); phase complete with a new
 * spec present (D2); phase complete with BUILD_COMPLETE present (D3); phase complete with neither
 * present (D4); phase complete with both present (D5). Implements PHASE_6_SPEC.md §3.2.
 */
export const DRIVER_STATE_IDS = [
  "D0_NOT_STARTED",
  "D1_RUN_ERRORED",
  "D2_NEXT_SPEC_PRESENT",
  "D3_BUILD_COMPLETE_PRESENT",
  "D4_NEITHER_PRESENT",
  "D5_BOTH_PRESENT",
] as const;

/** A member of {@link DRIVER_STATE_IDS}. */
export type DriverStateId = (typeof DRIVER_STATE_IDS)[number];

/** zod schema for {@link DriverStateId}. */
export const DriverStateIdSchema = z.enum(DRIVER_STATE_IDS);

/** The closed, three-member decision-kind set every {@link DriverStateId} resolves to. Implements PHASE_6_SPEC.md §3.3. */
export const DRIVER_DECISION_KINDS = ["dispatch", "stop", "halt"] as const;

/** A member of {@link DRIVER_DECISION_KINDS}. */
export type DriverDecisionKind = (typeof DRIVER_DECISION_KINDS)[number];

/** zod schema for {@link DriverDecisionKind}. */
export const DriverDecisionKindSchema = z.enum(DRIVER_DECISION_KINDS);

/**
 * One line of the append-only, JSONL dispatch log (PHASE_6_SPEC.md §6.4/§6.7). Implements
 * PHASE_6_SPEC.md §3.5, baby_prd.md acceptance criterion 7.
 */
export const DriverLogEntry = z.strictObject({
  schema_version: z.literal(1),
  written_at: IsoUtc,
  driver_run_id: z.uuid(),
  /** The target-build phase this decision concerns -- the phase that was just dispatched (for D1-D5) or the phase about to be dispatched for the first time (D0). */
  phase: z.number().int().min(1),
  state_id: DriverStateIdSchema,
  decision_kind: DriverDecisionKindSchema,
  /** Mandatory, non-empty -- §7 FM-D3 (the direct analogue of loopr's own G3 "silence read as evidence" guard). A `DriverLogEntry` with an empty reason fails validation outright; it is not a legal record. */
  reason: z.string().min(1),
  /** The `RunConfig.run_id` this decision's own `runDispatch()` call used, or `null` for the pre-first-dispatch D0/start-incoherence case, which never calls `runDispatch()` at all. */
  dispatched_run_id: z.uuid().nullable(),
  /** The `RunResult.exitCode` `runDispatch()` returned for `dispatched_run_id`, or `null` when `dispatched_run_id` is `null`. */
  dispatched_run_exit_code: z.number().int().nullable(),
  /** The phase number dispatched next, or `null` for a terminal (`stop`/`halt`) decision. */
  next_phase: z.number().int().min(1).nullable(),
  /** The driver's own terminal exit code, or `null` for a non-terminal (`dispatch`) decision. */
  exit_code: z.number().int().nullable(),
});

/** The inferred type of {@link DriverLogEntry}. */
export type DriverLogEntry = z.infer<typeof DriverLogEntry>;
