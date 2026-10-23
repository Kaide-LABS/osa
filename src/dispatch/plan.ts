// Implements PHASE_3_SPEC.md §6.1
//
// Resolves PRD §6.3's DECISION (which archetypes cross-provider-dispatch in V1) into the concrete,
// ordered, three-slot turn sequence for one run. Plain types, not zod -- in-process only, like
// `Invocation`/`TurnRequest` (PHASE_1_SPEC.md §3.6).
//
// Corroborating literature for `reviewerReviewedOwnWork` (OSA-PRD.md §8.6, MODERNIZATION
// CHANGELOG 2026-08-18 pass, Phase 7): Panickssery, Bowman, and Feng, "LLM Evaluators Recognize and
// Favor Their Own Generations," arXiv:2404.13076, 2024-04-15 -- establishes a causal mechanism for
// self-preference bias when an LLM acts as both evaluator and evaluatee. Chen, Wei, Zhu, Feng, and
// Meng, "Do LLM Evaluators Prefer Themselves for a Reason?," arXiv:2504.03846, 2025-04-04 --
// on-point for code generation specifically: "Harmful self-preference persists when evaluator
// models err as generators, and stronger models display more pronounced harmful self-preference
// bias when they do err." Together these ground why a `role_pins` configuration that collapses the
// reviewer onto the diff-writer must be surfaced loudly (`RunResult.warnings`), never proceed
// silently.

import { InternalError } from "../domain/errors.ts";
import type { ProviderId, RolePin, RunConfig } from "../domain/run.ts";

/**
 * One dispatched turn's role/provider pair. `archetype` is narrowed to exactly the two
 * V1-dispatched archetypes (`ROLE_REGISTRY`'s `instantiatedInV1: true` members, PRD §6.3) --
 * `planTurnSequence` never produces `"architect"`, `"researcher"`, or `"auditor"`.
 */
export interface TurnPlan {
  readonly archetype: "executor" | "reviewer";
  readonly provider: ProviderId;
  /**
   * `true` iff this slot is the reviewer slot and its resolved provider is the same provider that
   * filled the second executor slot -- the provider whose diff this reviewer turn reviews. Always
   * `false` for an executor slot. Computed structurally from `role_pins`' own elimination logic
   * (§6.1), never from an actual git diff -- `planTurnSequence` has no I/O and needs none to know
   * this. Implements PHASE_7_SPEC.md §3.1/§6.1, `.claude/loopr-role-pinning/baby_prd.md` acceptance
   * criterion 3.
   */
  readonly reviewerReviewedOwnWork: boolean;
  /** The model this slot's seat names; absent = the provider's default (or the run's per-provider `model_overrides`). */
  readonly model?: string;
}

/**
 * [DET] The member of `config.executor_providers` that is not `id`; when both seats are the same provider (different models), that provider.
 * It intentionally does not consult the global provider identity registry (PHASE_11_SPEC.md §6.1).
 */
export function otherExecutorProvider(config: RunConfig, id: ProviderId): ProviderId {
  if (!config.executor_providers.includes(id)) {
    throw new InternalError(`otherExecutorProvider: provider "${id}" is not in executor_providers`, { id });
  }
  return config.executor_providers.find((p) => p !== id) ?? id;
}

/** `true` iff `config.role_pins` pins `provider` to `role`. */
function isPinned(config: RunConfig, provider: ProviderId, role: RolePin): boolean {
  return config.role_pins?.[provider] === role;
}

type SeatIndex = 0 | 1;
const SEAT_INDEXES: readonly SeatIndex[] = [0, 1];

/**
 * [DET] Resolves the concrete, ordered, three-slot turn sequence for one run: two executor slots, then one reviewer slot. The slots are
 * filled from two SEATS -- `executor_providers[i]` on `seat_models[i]` -- so the same provider on two different models is a valid pair.
 * With no `role_pins` set the executor slots are seat 0 then seat 1, and the reviewer slot defaults to the seat that did NOT write the diff
 * under review (seat 0), unless the operator set `reviewer_provider` explicitly. A `role_pins` pinning a provider to `"reviewer"` removes
 * its seat from the executor pool (collapsing both executor slots onto the sole remaining seat; RP1 guarantees the pool is never empty); a
 * pin to `"executor"` removes it from reviewer eligibility. For two different providers this is byte-identical to the behaviour before
 * seats existed. `reviewerReviewedOwnWork` is true only when the reviewer's seat and the diff writer's seat are the same provider AND the
 * same model; a reviewer on a different model of the same provider is an independent-enough review that is reported, not warned about.
 * Implements PHASE_3_SPEC.md §6.1, PHASE_7_SPEC.md §6.1.
 */
export function planTurnSequence(config: RunConfig): readonly TurnPlan[] {
  const seats = SEAT_INDEXES.map((i) => ({ provider: config.executor_providers[i], model: config.seat_models?.[i] ?? null }));
  const seat = (i: SeatIndex) => seats[i] as { provider: ProviderId; model: string | null };

  // Executor pool: every seat whose provider is NOT pinned "reviewer" can fill an executor slot. RP1 (§3.3) guarantees it is never empty.
  const executorPool = SEAT_INDEXES.filter((i) => !isPinned(config, seat(i).provider, "reviewer"));
  const [execA, execB]: readonly [SeatIndex, SeatIndex] = executorPool.length === 2 ? [0, 1] : [executorPool[0] as SeatIndex, executorPool[0] as SeatIndex];

  // The seat whose diff the reviewer slot reviews is always the second executor slot's seat (`run-loop.ts`'s diff computation keys off it).
  const diffWriter = execB;

  const pinnedReviewer = SEAT_INDEXES.find((i) => isPinned(config, seat(i).provider, "reviewer"));

  let reviewer: SeatIndex;
  if (pinnedReviewer !== undefined) {
    // A provider pinned "reviewer" is always the reviewer when one exists (RP4 guarantees this agrees with `reviewer_provider`).
    reviewer = pinnedReviewer;
  } else if (config.reviewer_provider !== null) {
    // The operator's explicit override (RP3 guarantees it is not pinned "executor"): the seat holding that provider, preferring the one
    // that did not write the diff when both seats hold it.
    const holders = SEAT_INDEXES.filter((i) => seat(i).provider === config.reviewer_provider);
    reviewer = holders.find((i) => i !== diffWriter) ?? holders[0] ?? diffWriter;
  } else {
    // The default: the seat that did not write the diff under review, unless its provider is pinned "executor" (then only the diff writer remains).
    const naive: SeatIndex = diffWriter === 0 ? 1 : 0;
    reviewer = isPinned(config, seat(naive).provider, "executor") ? diffWriter : naive;
  }

  const slot = (archetype: "executor" | "reviewer", i: SeatIndex, own: boolean): TurnPlan => ({
    archetype,
    provider: seat(i).provider,
    ...(seat(i).model !== null ? { model: seat(i).model as string } : {}),
    reviewerReviewedOwnWork: own,
  });
  const ownWork = seat(reviewer).provider === seat(diffWriter).provider && seat(reviewer).model === seat(diffWriter).model;
  return [slot("executor", execA, false), slot("executor", execB, false), slot("reviewer", reviewer, ownWork)];
}
