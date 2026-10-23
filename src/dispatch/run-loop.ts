// Implements PHASE_3_SPEC.md §6.5
//
// `runDispatch()` -- the top-level orchestrator: preflight, lock, the turn loop, continuity gating
// with bounded retry, halt propagation. Never throws a `OsaError` for a modelled failure --
// mirrors `runDoctor`'s own established "returns the exit code, never calls `process.exit`, never
// throws for an expected condition" contract. An unexpected (non-modelled) throw -- including a
// `BoundaryViolationError` from `assertNeutralCommits` inside `runTurn`, which is deliberately
// never caught anywhere in this module (I4 is a hard invariant, never retried) -- is allowed to
// propagate normally, to be caught by `src/cli/run.ts`/`main.ts`'s existing generic catch, same as
// any other module in this codebase. Phase 4 (PHASE_4_SPEC.md §9 item 3) adds a second such
// uncaught-throw error class, `LooprArtifactBypassError`, raised from inside `runTurn` by
// `assertLooprArtifactsReferenced()`/`assertNextPhaseSpecProduced()` and treated identically --
// this module still never constructs `RunHaltedError`, and this phase gives no new reason to.
//
// This module is also the one place that deliberately *destroys* repository state: before a
// continuity retry is dispatched, `runTurnLoop` hard-resets `config.repo_dir` back to the last
// known-good turn's `repo.head_after`, discarding the failed attempt's commits. That is a
// correctness requirement rather than tidiness -- the retry's continuity verdict is computed
// against the last-good record, so the retry must actually *start* from that same commit, exactly
// as a normal turn does. The retry call site carries the full derivation.

import type { AdapterRegistry, ProviderAdapter } from "../ports/provider-adapter.ts";
import { ADAPTER_REGISTRY } from "../adapters/registry.ts";
import type { FileRef, HaltSignal, HandoffRecord } from "../domain/relay.ts";
import type { ProviderId, RunConfig, TurnRequest } from "../domain/run.ts";
import { ExitCode, LockHeldError, exitCodeFor } from "../domain/errors.ts";
import { getRole } from "../domain/roles.ts";
import type { ContinuityVerdict, ContinuityVerdictLabel } from "../verify/continuity.ts";
import { verifyContinuation } from "../verify/continuity.ts";
import { diffText, resetHard } from "../verify/git.ts";
import { runPreflight } from "../verify/preflight.ts";
import { acquireRunLock, releaseRunLock } from "../util/lock.ts";
import { readFile } from "node:fs/promises";
import { handoffPath, repoRelToAbs } from "../util/paths.ts";
import { sha256File } from "../util/hash.ts";
import { runProcess } from "../util/exec.ts";
import { ensureChatLogGitignore } from "./chat-log.ts";
import { nextPhaseSpecPath } from "./artifacts.ts";
import type { TurnPlan } from "./plan.ts";
import { planTurnSequence } from "./plan.ts";
import { buildExecutorPrompt, buildReviewerPrompt, sanitizeProjectRolePrompt } from "./prompt.ts";
import type { RunTurnDeps } from "./turn.ts";
import { runTurn } from "./turn.ts";

/**
 * Builds a {@link RunTurnDeps} without ever explicitly assigning `undefined` to the optional
 * `runProcessFn` property -- required under `exactOptionalPropertyTypes` (a variable typed
 * `typeof runProcess | undefined` cannot be assigned directly to an optional property of type
 * `typeof runProcess`, even though simply omitting the property is fine).
 */
function buildTurnDeps(adapter: ProviderAdapter, runProcessFn: typeof runProcess | undefined): RunTurnDeps {
  return runProcessFn === undefined ? { adapter } : { adapter, runProcessFn };
}

/** One dispatched turn attempt's summary, as reported in {@link RunResult.turns}. */
export interface TurnAttemptSummary {
  readonly turnIndex: number;
  readonly archetype: "executor" | "reviewer";
  readonly provider: ProviderId;
  readonly status: "completed" | "blocked" | "halted" | "failed";
  readonly continuityVerdict: ContinuityVerdictLabel | null;
  readonly retried: boolean;
}

/** The result of {@link runDispatch}. */
export interface RunResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly turns: readonly TurnAttemptSummary[];
  readonly halt: HaltSignal | null;
  readonly problems: readonly string[];
  /**
   * Non-empty iff some reviewer slot in this run's `planTurnSequence` output had
   * `reviewerReviewedOwnWork === true` -- surfaced here, not only in an internal log, per
   * `.claude/loopr-role-pinning/baby_prd.md` acceptance criterion 3. Always `[]` for a run whose
   * `RunConfig.role_pins` is absent or produces no such slot -- every pre-Phase-7 fixture is
   * unaffected. Implements PHASE_7_SPEC.md §6.2.
   */
  readonly warnings: readonly string[];
}

/**
 * Dependencies {@link runDispatch} needs beyond `RunConfig` itself.
 *
 * `preflightFn` is an AUTONOMOUS CRITIQUE addition beyond PHASE_3_SPEC.md §6.5's literal
 * two-field interface (`adapters`, `runProcessFn`) -- see the handoff notes for the full
 * rationale. In short: `runPreflight()` (Phase 1, unchanged) always shells out to the real
 * `claude`/`codex` binaries with no injection seam of its own, so without this field it is
 * structurally impossible for any test to reach `runDispatch`'s own turn-loop logic (lock,
 * planning, continuity retry, halt) without both provider CLIs being genuinely installed and
 * authenticated on the machine running the test -- directly contradicting §8 acceptance criterion
 * #30's explicit requirement that "no test in this phase spawns a real `claude` or `codex`
 * process." Defaults to the real {@link runPreflight} when omitted, so every call site that does
 * not pass `deps` (in particular `src/cli/run.ts`'s `runDispatch(config)`, which never passes
 * `deps` at all) is completely unaffected -- production behaviour is byte-identical to the spec as
 * literally written.
 */
export interface RunDispatchDeps {
  /** Test overrides may provide only adapters active in the fixture; production uses the total registry. */
  readonly adapters?: Readonly<Partial<AdapterRegistry>>;
  readonly runProcessFn?: typeof runProcess;
  readonly preflightFn?: typeof runPreflight;
}

function buildRetryNote(verdict: ContinuityVerdict): string {
  const lines: string[] = [
    `RETRY NOTICE: your prior attempt's output did not pass OSA's deterministic ` +
      `continuity checks (verdict: ${verdict.verdict}). Failing checks:`,
  ];
  for (const check of verdict.checks) {
    if (!check.passed) {
      lines.push(`  - ${check.id}: ${check.detail}`);
    }
  }
  lines.push("Address these specific issues in this attempt; do not repeat the same mistake.");
  // Told explicitly because the agent can otherwise observe it and draw the wrong conclusion. The
  // retry is dispatched only after `runTurnLoop` has hard-reset the repository to the last
  // known-good commit, so the failed attempt's commit is genuinely absent from `git log` by the
  // time this agent could look. Without this line, an agent that does inspect history sees a repo
  // with no trace of the work this very notice is critiquing -- and might "helpfully" try to revert
  // or fix up a commit that no longer exists, or conclude the notice is stale and ignore it.
  lines.push(
    "The repository has already been reset to the last known-good commit, so the failed attempt's " +
      "changes and commits no longer exist -- do not try to revert or repair them. Start from the " +
      "current state and do the work again, correctly.",
  );
  return lines.join("\n");
}

interface BuildPromptInput {
  readonly slot: TurnPlan;
  readonly specRepoRelPath: string;
  readonly handoffAbsPath: string;
  /** Repo-relative path to loopr's `baby_prd.md` for this build (PHASE_4_SPEC.md §6.4, new). */
  readonly babyPrdRepoRelPath: string;
  /** Repo-relative path to loopr's `context.md` for this build (PHASE_4_SPEC.md §6.4, new). */
  readonly contextRepoRelPath: string;
  readonly prevRecord: HandoffRecord | null;
  readonly diff: string | null;
  /** The reviewer's expected next-artifact path; unused for an executor slot (PHASE_4_SPEC.md §6.4, new). */
  readonly nextArtifactPath: string;
  /** `RunConfig.is_final_phase`; unused for an executor slot (PHASE_4_SPEC.md §6.4, new). */
  readonly isFinalPhase: boolean;
  readonly retryNote: string | null;
  /**
   * This build's own customized loopr Step 11/12 prompt content for `slot.archetype`, already
   * sanitized via `sanitizeProjectRolePrompt` -- or `null` when the corresponding `RunConfig`
   * path (`executor_prompt_path`/`reviewer_prompt_path`) was not supplied for this run.
   */
  readonly roleTaskInstructions: string | null;
}

function buildPromptForSlot(input: BuildPromptInput): string {
  if (input.slot.archetype === "executor") {
    return buildExecutorPrompt({
      role: "executor",
      specRepoRelPath: input.specRepoRelPath,
      handoffAbsPath: input.handoffAbsPath,
      babyPrdRepoRelPath: input.babyPrdRepoRelPath,
      contextRepoRelPath: input.contextRepoRelPath,
      priorRecord: input.prevRecord,
      retryNote: input.retryNote,
      roleTaskInstructions: input.roleTaskInstructions,
    });
  }
  // The reviewer slot always has a non-null prevRecord and diff -- it is never the first slot in
  // planTurnSequence's fixed three-slot order (§6.1).
  return buildReviewerPrompt({
    specRepoRelPath: input.specRepoRelPath,
    handoffAbsPath: input.handoffAbsPath,
    babyPrdRepoRelPath: input.babyPrdRepoRelPath,
    contextRepoRelPath: input.contextRepoRelPath,
    priorRecord: input.prevRecord as HandoffRecord,
    diff: input.diff ?? "",
    expectedArtifactPath: input.nextArtifactPath,
    isFinalPhase: input.isFinalPhase,
    retryNote: input.retryNote,
    roleTaskInstructions: input.roleTaskInstructions,
  });
}

interface DispatchOneAttemptInput {
  readonly config: RunConfig;
  readonly deps: RunTurnDeps;
  readonly slot: TurnPlan;
  readonly turnIndex: number;
  readonly specRef: FileRef;
  readonly prevRecord: HandoffRecord | null;
  readonly diff: string | null;
  /** The reviewer's expected next-artifact path, computed once per run (PHASE_4_SPEC.md §6.4, new). */
  readonly nextArtifactPath: string;
  readonly retryNote: string | null;
  /**
   * This build's own customized loopr Step 11/12 prompt content, sanitized and selected for
   * `slot.archetype` by the caller (`runTurnLoop` reads and sanitizes both paths at most once per
   * run, not once per attempt) -- or `null` when the run carries no such customization.
   */
  readonly roleTaskInstructions: string | null;
}

async function dispatchOneAttempt(input: DispatchOneAttemptInput) {
  const { config, slot, turnIndex } = input;
  const tier = getRole(slot.archetype).tier;
  const modelOverride = config.model_overrides?.[slot.provider] ?? null;
  const handoffAbsPath = handoffPath(config.repo_dir, config.run_id, config.phase, turnIndex, slot.archetype, slot.provider);
  const prompt = buildPromptForSlot({
    slot,
    specRepoRelPath: config.spec_path,
    handoffAbsPath,
    babyPrdRepoRelPath: config.baby_prd_path,
    contextRepoRelPath: config.context_path,
    prevRecord: input.prevRecord,
    diff: input.diff,
    nextArtifactPath: input.nextArtifactPath,
    isFinalPhase: config.is_final_phase,
    retryNote: input.retryNote,
    roleTaskInstructions: input.roleTaskInstructions,
  });
  const req: TurnRequest = {
    runId: config.run_id,
    phase: config.phase,
    turnIndex,
    archetype: slot.archetype,
    provider: slot.provider,
    tier,
    modelOverride,
    repoDir: config.repo_dir,
    specRef: input.specRef,
    priorRecord: input.prevRecord,
    prompt,
    timeoutMs: config.turn_timeout_ms,
    babyPrdPath: config.baby_prd_path,
    contextPath: config.context_path,
    expectedArtifactPath: slot.archetype === "reviewer" ? input.nextArtifactPath : null,
    // [DET] PHASE_10_SPEC.md §6.2: `chat_log_id ?? run_id` under `run`; a `drive` unconditionally
    // sets `chat_log_id` to its own `driver_run_id` so a whole multi-phase drive lands in one file.
    chatLogId: config.chat_log_id ?? config.run_id,
    chatLogGitignored: config.chat_log_gitignored,
  };
  const result = await runTurn(req, input.deps);
  return { req, result };
}

function nonCompleteSummary(
  turnIndex: number,
  slot: TurnPlan,
  status: "blocked" | "halted" | "failed",
  retried: boolean,
): TurnAttemptSummary {
  return { turnIndex, archetype: slot.archetype, provider: slot.provider, status, continuityVerdict: null, retried };
}

/**
 * [DET] The extended preflight check (§6.5 step 1; PHASE_4_SPEC.md §6.4 extends it with two more
 * checks of the identical shape): the ordinary `runPreflight()` (Phase 1, unchanged) plus
 * readability checks on `config.spec_path`, `config.baby_prd_path`, and `config.context_path`,
 * plus the same check on `config.executor_prompt_path`/`config.reviewer_prompt_path` whenever
 * either is supplied (both optional -- unset means "no check", not "must be absent"), all folded
 * into the same "is everything this run needs actually present and healthy" concept rather than a
 * new exit code.
 */
async function runExtendedPreflight(
  config: RunConfig,
  preflightFn: typeof runPreflight,
): Promise<{ ok: boolean; problems: readonly string[] }> {
  const summary = await preflightFn(config.repo_dir);
  const problems: string[] = [...summary.problems];
  let ok = summary.ok;

  // Implements PHASE_11_SPEC.md §6.5. Aggregate health permits an unused third identity to be
  // unhealthy; a run may still only dispatch providers that are healthy for its own two slots.
  for (const [index, provider] of config.executor_providers.entries()) {
    const report = summary.providers.find((candidate) => candidate.provider === provider);
    if (report === undefined || report.problems.length > 0) {
      ok = false;
      const detail = report === undefined ? "no preflight report was returned" : report.problems.join(" ");
      problems.push(`executor_providers[${String(index)}] names ${provider}, which is not healthy: ${detail}`);
    }
  }

  const readabilityChecks: [string, string][] = [
    ["spec_path", config.spec_path],
    ["baby_prd_path", config.baby_prd_path],
    ["context_path", config.context_path],
  ];
  if (config.executor_prompt_path !== undefined) {
    readabilityChecks.push(["executor_prompt_path", config.executor_prompt_path]);
  }
  if (config.reviewer_prompt_path !== undefined) {
    readabilityChecks.push(["reviewer_prompt_path", config.reviewer_prompt_path]);
  }
  for (const [label, path] of readabilityChecks) {
    try {
      await sha256File(repoRelToAbs(config.repo_dir, path));
    } catch {
      ok = false;
      problems.push(`${label} "${path}" does not resolve to a readable file in "${config.repo_dir}".`);
    }
  }

  return { ok, problems };
}

/**
 * The top-level orchestrator: extended preflight, run lock, then the fixed three-slot turn loop
 * (planning, prompt assembly, spawn, ground-truth reconciliation, neutrality assertion, continuity
 * gating with exactly one bounded retry scoped to a non-`CONTINUED` verdict -- preceded by a hard
 * reset of the repository to the last known-good commit, see `runTurnLoop`'s retry path -- and halt
 * propagation). Implements PHASE_3_SPEC.md §6.5.
 */
export async function runDispatch(config: RunConfig, deps?: RunDispatchDeps): Promise<RunResult> {
  const preflight = await runExtendedPreflight(config, deps?.preflightFn ?? runPreflight);
  const inactiveOverrideWarnings = Object.keys(config.model_overrides ?? {})
    .filter((provider) => !(config.executor_providers as readonly string[]).includes(provider))
    .map((provider) => `model_overrides.${provider} is inert because ${provider} is not active for this run.`);
  if (!preflight.ok) {
    return { ok: false, exitCode: ExitCode.PREFLIGHT_FAILED, turns: [], halt: null, problems: preflight.problems, warnings: inactiveOverrideWarnings };
  }

  try {
    await acquireRunLock(config.repo_dir, config.run_id);
  } catch (err) {
    if (err instanceof LockHeldError) {
      return { ok: false, exitCode: ExitCode.LOCK_HELD, turns: [], halt: null, problems: [err.message], warnings: inactiveOverrideWarnings };
    }
    throw err;
  }

  try {
    return await runTurnLoop(config, deps, inactiveOverrideWarnings);
  } finally {
    await releaseRunLock(config.repo_dir, config.run_id);
  }
}

/**
 * Reads and sanitizes `config.executor_prompt_path`/`config.reviewer_prompt_path` (this build's
 * own customized loopr Step 11/12 prompts) at most once per run -- never once per attempt, since
 * neither file changes across a run's turns or a continuity retry. `null` for either path that was
 * not supplied for this run, mirroring `RunConfig`'s own optional treatment of the two fields.
 */
async function readRoleTaskInstructions(config: RunConfig): Promise<{ executor: string | null; reviewer: string | null }> {
  async function readAndSanitize(repoRelPath: string | undefined): Promise<string | null> {
    if (repoRelPath === undefined) {
      return null;
    }
    const raw = await readFile(repoRelToAbs(config.repo_dir, repoRelPath), "utf8");
    return sanitizeProjectRolePrompt(raw);
  }
  const [executor, reviewer] = await Promise.all([
    readAndSanitize(config.executor_prompt_path),
    readAndSanitize(config.reviewer_prompt_path),
  ]);
  return { executor, reviewer };
}

async function runTurnLoop(
  config: RunConfig,
  deps: RunDispatchDeps | undefined,
  initialWarnings: readonly string[],
): Promise<RunResult> {
  const adapters = deps?.adapters ?? ADAPTER_REGISTRY;
  const runProcessFn = deps?.runProcessFn;

  const specSha256 = await sha256File(repoRelToAbs(config.repo_dir, config.spec_path));
  const specRef: FileRef = { path: config.spec_path, sha256: specSha256 };
  const nextArtifactPath = nextPhaseSpecPath(config.spec_path, config.phase, config.is_final_phase);
  const roleTaskInstructions = await readRoleTaskInstructions(config);

  const plan = planTurnSequence(config);
  const turns: TurnAttemptSummary[] = [];
  const warnings: string[] = [...initialWarnings];
  let attemptCounter = 0;
  let prevRecord: HandoffRecord | null = null;
  let firstTurnHeadBefore: string | null = null;

  // PHASE_10_SPEC.md §6.1: exactly once per run, before any turn is dispatched and therefore
  // before any chat-log file can exist -- a log written before its directory is ignored would be
  // momentarily visible to `git status`, which confirmed acceptance criterion 4 says must not
  // occur. Idempotent; under `drive` this runs once per phase, which is correct and harmless.
  const gitignoreWarning = await ensureChatLogGitignore(config.repo_dir, config.chat_log_gitignored);
  if (gitignoreWarning !== null) {
    warnings.push(gitignoreWarning);
  }

  for (const [slotIndex, slot] of plan.entries()) {
    if (slot.archetype === "reviewer" && slot.reviewerReviewedOwnWork) {
      warnings.push(
        `Turn ${String(attemptCounter)} (reviewer/${slot.provider}) is reviewing its own prior work: ` +
          `role_pins left no other provider eligible for the reviewer role this run.`,
      );
    }

    const adapter = adapters[slot.provider] ?? ADAPTER_REGISTRY[slot.provider];

    let diff: string | null = null;
    if (slot.archetype === "reviewer") {
      diff = await diffText(config.repo_dir, firstTurnHeadBefore ?? "", (prevRecord as HandoffRecord).repo.head_after);
    }

    const turnIndex = attemptCounter;
    attemptCounter += 1;
    const { result } = await dispatchOneAttempt({
      config,
      deps: buildTurnDeps(adapter, runProcessFn),
      slot,
      turnIndex,
      specRef,
      prevRecord,
      diff,
      nextArtifactPath,
      retryNote: null,
      roleTaskInstructions: slot.archetype === "executor" ? roleTaskInstructions.executor : roleTaskInstructions.reviewer,
    });
    warnings.push(...result.chatLogWarnings);

    if (!result.outcome.ok) {
      turns.push(nonCompleteSummary(turnIndex, slot, "failed", false));
      return {
        ok: false,
        exitCode: exitCodeFor(result.outcome.failure),
        turns,
        halt: null,
        problems: [result.outcome.failure?.message ?? "turn failed with no further detail"],
        warnings: [...warnings],
      };
    }

    const record = result.record as HandoffRecord;
    if (record.status !== "completed") {
      turns.push(nonCompleteSummary(turnIndex, slot, record.status, false));
      return {
        ok: false,
        exitCode: ExitCode.RUN_HALTED,
        turns,
        halt: record.halt,
        problems: [record.halt?.message ?? `turn reported status "${record.status}"`],
        warnings: [...warnings],
      };
    }

    if (slotIndex === 0) {
      firstTurnHeadBefore = record.repo.head_before;
    }

    if (prevRecord === null) {
      turns.push({
        turnIndex,
        archetype: slot.archetype,
        provider: slot.provider,
        status: "completed",
        continuityVerdict: null,
        retried: false,
      });
      prevRecord = record;
      continue;
    }

    const verdict = await verifyContinuation(config.repo_dir, prevRecord, record);
    if (verdict.verdict === "CONTINUED") {
      turns.push({
        turnIndex,
        archetype: slot.archetype,
        provider: slot.provider,
        status: "completed",
        continuityVerdict: "CONTINUED",
        retried: false,
      });
      prevRecord = record;
      continue;
    }

    // [DECISION Phase 3] Exactly one bounded retry, scoped only to a non-CONTINUED verdict.
    turns.push({
      turnIndex,
      archetype: slot.archetype,
      provider: slot.provider,
      status: "completed",
      continuityVerdict: verdict.verdict,
      retried: false,
    });

    // [Live-run bug, fixed here.] Rewind the repository to the last known-good commit before the
    // retry is dispatched. This is required for correctness, not hygiene.
    //
    // The retry is dispatched with `prevRecord` unchanged -- still the last *genuinely good*
    // record, never the failed attempt's own -- and its verdict is computed against that same
    // record (`verifyContinuation(config.repo_dir, prevRecord, retryRecord)` below). But the failed
    // attempt's commits were real commits and, without this reset, remain the real HEAD. So
    // `captureGroundTruthBefore()` inside `runTurn` would capture the *failed* attempt's
    // `head_after` as the retry's `ground.headBefore`, and `reconcileHandoffRecord()`
    // (`src/dispatch/record.ts`) reconciles `artifacts_read` against exactly that commit. The retry
    // would therefore be hashed against the bad/reverted content while
    // `checkC5ArtifactAttestation` compared it to `prevRecord.artifacts_written` -- two different
    // baselines, so C5 could never pass for a retry, structurally, no matter what the retry agent
    // did. Resetting restores the invariant every normal turn already enjoys: `ground.headBefore`
    // equals the comparison record's `repo.head_after`.
    //
    // Discarding the failed attempt's commits is the correct semantic, not collateral damage: a
    // REDO/PARTIAL_REVERT/IGNORED/DIVERGED verdict is a deterministic judgement that this attempt's
    // work is invalid, and leaving it in history would only give the retry invalid work to build on
    // top of. `resetHard` leaves untracked files alone, so `.osa/`'s run bookkeeping --
    // including the failed attempt's own persisted record -- survives for the audit trail.
    //
    // `prevRecord` is necessarily non-null here (the `prevRecord === null` branch above `continue`s
    // before ever reaching a verdict), and every non-null `prevRecord` is a *reconciled* record
    // whose `repo.head_after` came from `revParse(repoDir, "HEAD")` -- so a first-record-with-no-
    // meaningful-`head_after` state is unreachable rather than merely unlikely, and no guard for it
    // could be exercised. A genuine reset failure (bad object, unwritable index, a file locked by
    // another process) throws `InternalError` and propagates uncaught, matching this module's
    // treatment of every other unexpected condition; `runDispatch`'s `finally` still releases the
    // run lock. Continuing with a half-rewound repository would be strictly worse -- it would
    // produce a misleading CONTINUITY_FAILED two turns later instead of naming the real fault.
    await resetHard(config.repo_dir, prevRecord.repo.head_after);

    const retryTurnIndex = attemptCounter;
    attemptCounter += 1;
    const { result: retryResult } = await dispatchOneAttempt({
      config,
      deps: buildTurnDeps(adapter, runProcessFn),
      slot,
      turnIndex: retryTurnIndex,
      specRef,
      prevRecord,
      diff,
      nextArtifactPath,
      retryNote: buildRetryNote(verdict),
      roleTaskInstructions: slot.archetype === "executor" ? roleTaskInstructions.executor : roleTaskInstructions.reviewer,
    });
    warnings.push(...retryResult.chatLogWarnings);

    if (!retryResult.outcome.ok) {
      turns.push(nonCompleteSummary(retryTurnIndex, slot, "failed", true));
      return {
        ok: false,
        exitCode: exitCodeFor(retryResult.outcome.failure),
        turns,
        halt: null,
        problems: [retryResult.outcome.failure?.message ?? "turn failed with no further detail"],
        warnings: [...warnings],
      };
    }

    const retryRecord = retryResult.record as HandoffRecord;
    if (retryRecord.status !== "completed") {
      turns.push(nonCompleteSummary(retryTurnIndex, slot, retryRecord.status, true));
      return {
        ok: false,
        exitCode: ExitCode.RUN_HALTED,
        turns,
        halt: retryRecord.halt,
        problems: [retryRecord.halt?.message ?? `turn reported status "${retryRecord.status}"`],
        warnings: [...warnings],
      };
    }

    const retryVerdict = await verifyContinuation(config.repo_dir, prevRecord, retryRecord);
    if (retryVerdict.verdict !== "CONTINUED") {
      turns.push({
        turnIndex: retryTurnIndex,
        archetype: slot.archetype,
        provider: slot.provider,
        status: "completed",
        continuityVerdict: retryVerdict.verdict,
        retried: true,
      });
      return {
        ok: false,
        exitCode: ExitCode.CONTINUITY_FAILED,
        turns,
        halt: null,
        problems: [
          `continuity check failed twice for ${slot.archetype}/${slot.provider}: first verdict ` +
            `${verdict.verdict} (failed: ${verdict.failedCheckIds.join(", ") || "none"}), retry verdict ` +
            `${retryVerdict.verdict} (failed: ${retryVerdict.failedCheckIds.join(", ") || "none"}).`,
        ],
        warnings: [...warnings],
      };
    }

    turns.push({
      turnIndex: retryTurnIndex,
      archetype: slot.archetype,
      provider: slot.provider,
      status: "completed",
      continuityVerdict: "CONTINUED",
      retried: true,
    });
    prevRecord = retryRecord;
  }

  return { ok: true, exitCode: ExitCode.OK, turns, halt: null, problems: [], warnings: [...warnings] };
}
