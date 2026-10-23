// Implements PHASE_1_SPEC.md §3.5
//
// Provider identity, the operator-facing `RunConfig`, and the plain (non-wire) types a turn
// passes between the dispatch layer and a `ProviderAdapter` (Phase 2+). Phase 1 defines and
// validates `RunConfig`; nothing in Phase 1 consumes it (no dispatch loop exists yet -- §9).
//
// Module dependency note: this file intentionally has zero runtime dependency on `./relay.ts`.
// `RunConfig.run_id` validates with an inline `z.uuid()` (behaviourally identical to relay.ts's
// exported `RunId` primitive) rather than importing it, and `TurnRequest`/`TurnOutcome` pull in
// `FileRef`/`HandoffRecord`/`OsaError` via `import type` only, which Node's type stripping
// erases entirely. This keeps relay.ts's runtime import of `ProviderIdSchema` from this file a
// one-directional edge instead of an ES-module import cycle. See the note at the top of relay.ts.

import { z } from "zod";
import type { Archetype } from "./roles.ts";
import type { ModelTier } from "./tiers.ts";
import type { FileRef, HandoffRecord } from "./relay.ts";
import type { OsaError } from "./errors.ts";
import { isSafeRepoRelPath } from "../util/paths.ts";

/**
 * A repo-relative POSIX path, declared locally rather than imported from `./relay.ts`'s
 * `RepoRelPath` -- this file has zero *runtime* dependency on `relay.ts` (see the module
 * dependency note above) to keep the two files' dependency a one-directional DAG. This is not a
 * new safety rule: it delegates to the same single-source-of-truth `isSafeRepoRelPath`
 * (`src/util/paths.ts`) that `RepoRelPath` itself already delegates to (PHASE_1_SPEC.md §6.3: "the
 * rule lives in one place"), just declared a second time as a schema value in the one file that
 * cannot safely import the other's schema object without a cycle. Implements PHASE_3_SPEC.md §1.3.
 */
const RepoRelPathLike = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafeRepoRelPath, "must be a safe, repo-relative POSIX path (no absolute path, no backslash separators, no upward traversal)");

/** Provider identities OSA can drive. A run uses one or two of them (two seats; they may be the same provider on different models). */
export const PROVIDER_IDS = ["claude-code", "codex-cli", "antigravity-cli", "opencode-cli", "copilot-cli"] as const;

/** A member of {@link PROVIDER_IDS}. */
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** zod schema for {@link ProviderId}. */
export const ProviderIdSchema = z.enum(PROVIDER_IDS);

/**
 * The three genuinely distinct outcomes of *observing* a provider CLI's credential state (boundary
 * rule B6 -- OSA only ever observes it, never establishes it):
 *
 * - `"authenticated"` -- the CLI ran and its own output positively says the operator is signed in.
 * - `"unauthenticated"` -- the CLI ran fine and its own output positively says the operator is not
 *   signed in (Claude Code's `loggedIn: false`; Codex's documented not-signed-in exit code with no
 *   API key env var set). A **claim**, and an actionable one: the operator needs to sign in.
 * - `"indeterminate"` -- the probe did not answer the question: the child process failed to spawn,
 *   timed out, returned an exit code matching neither documented outcome, or emitted output that
 *   did not parse. The **absence** of a claim, and a different action: look closer.
 *
 * Collapsing the last two into a single `false` is exactly the shape that let the Windows `cmd.exe`
 * argument-quoting defect (fixed in `src/util/exec.ts`) stay invisible: a probe failing for a reason
 * entirely unrelated to credentials read identically to "not signed in", so `doctor --providers`
 * reported a plausible-looking provider state right up until a real turn silently failed. A probe
 * that cannot answer must say so rather than guess the more familiar answer.
 */
export const AUTH_PROBE_STATES = ["authenticated", "unauthenticated", "indeterminate"] as const;

/** A member of {@link AUTH_PROBE_STATES}. */
export type AuthProbeState = (typeof AUTH_PROBE_STATES)[number];

/** zod schema for {@link AuthProbeState}. */
export const AuthProbeStateSchema = z.enum(AUTH_PROBE_STATES);

/** The two roles an operator may pin a provider to (PRD §6.3a). Implements PHASE_7_SPEC.md §3.1. */
export const ROLE_PINS = ["executor", "reviewer"] as const;

/** A member of {@link ROLE_PINS}. */
export type RolePin = (typeof ROLE_PINS)[number];

/** zod schema for {@link RolePin}. */
export const RolePinSchema = z.enum(ROLE_PINS);

/**
 * Operator-supplied run configuration. Phase 1 defines and validates it; Phase 3's dispatch loop
 * is its only consumer.
 */
const RunConfigShape = z.strictObject({
  run_id: z.uuid(),
  repo_dir: z.string().min(1),
  executor_providers: z
    .tuple([ProviderIdSchema, ProviderIdSchema])
    .refine(([a, b]) => a !== b, "executor_providers must be two different provider ids"),
  reviewer_provider: ProviderIdSchema.nullable().default(null),
  /**
   * Pins a provider exclusively to the executor role, exclusively to the reviewer role, or leaves it
   * unpinned (absent from this record -- today's default alternation, PRD §6.3). A sparse,
   * per-provider record, mirroring `model_overrides`'s own existing `z.partialRecord` shape rather
   * than introducing a new config-representation pattern (PRD §8.6 item 6). Cross-field validity
   * (RP1-RP4, §3.3) is enforced by this schema's own object-level `.refine()` chain, not by
   * `planTurnSequence` or any runtime check inside `runDispatch` -- the same "schema is the single
   * source of validity" precedent `executor_providers`'s own `.refine()` already established.
   * Implements PHASE_7_SPEC.md §3.1.
   */
  role_pins: z.partialRecord(ProviderIdSchema, RolePinSchema).optional(),
  turn_timeout_ms: z.number().int().min(1000).max(7_200_000).default(1_800_000),
  model_overrides: z.partialRecord(ProviderIdSchema, z.string().min(1)).optional(),
  /** Which loopr phase this run dispatches (PHASE_3_SPEC.md §1.3). */
  phase: z.number().int().min(1),
  /** Repo-relative path to the `PHASE_N_SPEC.md` this run's turns work from (PHASE_3_SPEC.md §1.3). */
  spec_path: RepoRelPathLike,
  /**
   * Repo-relative path to loopr's own `baby_prd.md` for this build -- required (never nullable):
   * by the time any `OSA run` dispatch happens, loopr's interrogation stage has necessarily
   * already produced it. Genuinely read (never generated) by every dispatched turn
   * (`assertLooprArtifactsReferenced()`, PHASE_4_SPEC.md §6.1).
   */
  baby_prd_path: RepoRelPathLike,
  /** Repo-relative path to loopr's own `context.md` for this build. Same treatment as `baby_prd_path`. */
  context_path: RepoRelPathLike,
  /**
   * Whether this run dispatches the target build's own final phase. Operator-supplied per run --
   * OSA never infers it. Determines what the reviewer turn is instructed, and mechanically
   * held, to produce next: `PHASE_(N+1)_SPEC.md` when `false`, a `BUILD_COMPLETE.md` completion
   * artifact when `true` (`nextPhaseSpecPath()`, PHASE_4_SPEC.md §6.1). Defaults `false` so every
   * pre-Phase-4 `RunConfig` fixture that omits it keeps parsing, the same reasoning
   * `turn_timeout_ms`'s own default already established.
   */
  is_final_phase: z.boolean().default(false),
  /**
   * Repo-relative path to this build's own customized loopr Step 11 (execution) prompt -- the
   * output of `loopr customize --step 11` for the project `spec_path` belongs to. Optional: when
   * omitted, an executor turn receives only the executor role's generic `profileSummary` plus
   * OSA's own protocol instructions, exactly as every run before this field existed. When
   * present, its content is read once by OSA itself and layered into every executor
   * turn's prompt ahead of the protocol instructions, carrying loopr's real per-project discipline
   * (autonomous critique, its MAY/MAY-NOT invariant list, phase discovery) across whichever
   * provider actually executes the turn -- never welding that discipline to a concrete provider or
   * spawn mechanism (PRD §6.1 portability constraint).
   */
  executor_prompt_path: RepoRelPathLike.optional(),
  /** Same treatment as {@link RunConfig.executor_prompt_path}, for loopr's Step 12 (adversarial review + phase advancement) prompt. */
  reviewer_prompt_path: RepoRelPathLike.optional(),
  /**
   * Identifies the chat-log FILE this run's turns append to. Set by the driver to its own
   * `driver_run_id` so a whole multi-phase drive produces ONE ordered log; absent for a standalone
   * `OSA run`, in which case `run_id` is used. Operators do not normally set this by hand.
   * Implements PHASE_10_SPEC.md §3.7.
   */
  chat_log_id: z.uuid().optional(),
  /**
   * Whether OSA keeps the chat-log directory gitignored (the default, `true`). Setting it to
   * `false` is THE documented override: OSA removes the ignore file it manages, and the log
   * becomes trackable by git.
   *
   * OSA does NOT claim a chat log is safe to commit. It is a verbatim record of everything
   * the providers actually emitted, and captured stdout is empirically the dominant credential-
   * leakage channel in agent systems (PRD §9 FM17, §8.9.3). Read the log before you make it
   * trackable. OSA flags credential-shaped content it recognises as a warning, but that
   * detector recognises only three token shapes and is explicitly advisory, not a guarantee.
   * Implements PHASE_10_SPEC.md §3.7.
   */
  chat_log_gitignored: z.boolean().default(true),
});

/**
 * Object-level role-pinning refinements (RP1-RP4), chained onto {@link RunConfigShape}. Mirrors
 * `src/domain/relay.ts`'s `HandoffRecordShape.refine(...).refine(...)` idiom exactly: one named
 * rule per genuinely distinct invariant, independently nameable and independently testable, rather
 * than one combined boolean predicate. `PROVIDER_IDS` (not a hardcoded two-provider check) is used
 * so each refinement reads as a general "no role is left without an eligible provider" invariant.
 * Implements PHASE_7_SPEC.md §3.3.
 *
 * Deliberately does **not** check whether a pinned reviewer would end up reviewing its own prior
 * work (`reviewerReviewedOwnWork`, `src/dispatch/plan.ts` §6.1) -- that is a structurally valid
 * configuration whose *consequence* is surfaced loudly at dispatch time (`RunResult.warnings`),
 * never rejected at parse time (PHASE_7_SPEC.md §3.3).
 */
export const RunConfig = RunConfigShape.refine(
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

/** The inferred type of {@link RunConfig}. */
export type RunConfig = z.infer<typeof RunConfig>;

/**
 * Everything a `ProviderAdapter` needs to build one turn's invocation. Not a wire schema -- it
 * never crosses a process boundary, so it is a plain TypeScript type.
 */
export interface TurnRequest {
  readonly runId: string;
  readonly phase: number;
  readonly turnIndex: number;
  readonly archetype: Archetype;
  readonly provider: ProviderId;
  readonly tier: ModelTier;
  /**
   * Operator-supplied override from `RunConfig.model_overrides` (PHASE_1_SPEC.md §3.5) -- "the
   * only place a concrete model name may appear at runtime, and it is operator-supplied data,
   * never source." `null` when the operator did not override this provider's model for this run.
   * Implements PHASE_2_SPEC.md §1.3.
   */
  readonly modelOverride: string | null;
  readonly repoDir: string;
  readonly specRef: FileRef;
  readonly priorRecord: HandoffRecord | null;
  readonly prompt: string;
  readonly timeoutMs: number;
  /**
   * Repo-relative path to loopr's `baby_prd.md` for this build, threaded from
   * `RunConfig.baby_prd_path` -- a plain path string, not a `FileRef`: unlike `specRef` it never
   * participates in a cross-turn consistency check (there is no `C_BABY_PRD_CONTINUITY`), so no
   * ground-truth hash needs to be precomputed for it. Implements PHASE_4_SPEC.md §1.2.
   */
  readonly babyPrdPath: string;
  /** Repo-relative path to loopr's `context.md` for this build, threaded from `RunConfig.context_path`. */
  readonly contextPath: string;
  /**
   * The repo-relative path the reviewer turn must genuinely produce next (`nextPhaseSpecPath()`),
   * or `null` for every executor turn -- the same "null unless this specific slot needs it" shape
   * `diff` already uses in `run-loop.ts`'s `BuildPromptInput`. Implements PHASE_4_SPEC.md §1.2.
   */
  readonly expectedArtifactPath: string | null;
  /**
   * The chat-log file id this turn's entries belong to (`RunConfig.chat_log_id ?? run_id`).
   * REQUIRED, deliberately: a required field makes it structurally impossible to construct a turn
   * that silently logs nowhere (PRD §9 FM15).
   *
   * A `ProviderAdapter` must never read this field. It is not part of the invocation. Implements
   * PHASE_10_SPEC.md §3.8.
   */
  readonly chatLogId: string;
  /**
   * `RunConfig.chat_log_gitignored`, threaded so `runTurn` can word the FM17 credential warning
   * correctly. A `ProviderAdapter` must never read this field either. Implements PHASE_10_SPEC.md
   * §3.8.
   */
  readonly chatLogGitignored: boolean;
}

/** The raw result of spawning a child process, before any provider-specific interpretation. */
export interface RawInvocationResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

/** The result of interpreting a turn: either a valid handoff record, or a modelled failure. */
export interface TurnOutcome {
  readonly ok: boolean;
  readonly record: HandoffRecord | null;
  readonly failure: OsaError | null;
}
