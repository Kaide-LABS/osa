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
}

/**
 * [DET] Total over this run's two active executor identities: returns the member of
 * `config.executor_providers` that is not `id`. It intentionally does not consult the global
 * provider identity registry (PHASE_11_SPEC.md §6.1).
 */
export function otherExecutorProvider(config: RunConfig, id: ProviderId): ProviderId {
  if (!config.executor_providers.includes(id)) {
    throw new InternalError(`otherExecutorProvider: provider "${id}" is not in executor_providers`, { id });
  }
  const other = config.executor_providers.find((p) => p !== id);
  if (other === undefined) {
    throw new InternalError(`otherExecutorProvider: no other provider for "${id}"`, { id });
  }
  return other;
}

/** `true` iff `config.role_pins` pins `provider` to `role`. */
function isPinned(config: RunConfig, provider: ProviderId, role: RolePin): boolean {
  return config.role_pins?.[provider] === role;
}

/**
 * [DET, DECISION Phase 3, AMENDED Phase 7 §6.3a] Resolves PRD §6.3's DECISION -- extended by §6.3a
 * to admit operator role pinning -- into the concrete, ordered, three-slot V1 turn sequence for one
 * run: two executor slots, then one reviewer slot. With no `role_pins` set, this is byte-identical
 * to the pre-Phase-7 behaviour: executor slots ordered exactly as `executor_providers`, reviewer
 * slot defaulting to whichever provider did *not* produce the diff under review
 * (`otherExecutorProvider(config, executor_providers[1])`) unless the operator set `reviewer_provider`
 * explicitly (PHASE_7_SPEC.md §6.1 worked table row 1, AC2). A `role_pins` pinning a provider to
 * `"reviewer"` removes it from the executor pool (collapsing both executor slots onto the sole
 * remaining eligible provider, RP1 guarantees this pool is never empty); a `role_pins` pinning a
 * provider to `"executor"` removes it from reviewer eligibility. No other archetype ever appears.
 * Implements PHASE_3_SPEC.md §6.1, PHASE_7_SPEC.md §6.1.
 */
export function planTurnSequence(config: RunConfig): readonly TurnPlan[] {
  const [firstExecutor, secondExecutor] = config.executor_providers;

  // Executor pool: every provider NOT pinned "reviewer" is eligible to fill an executor slot. RP1
  // (PHASE_7_SPEC.md §3.3) guarantees this pool is never empty.
  const executorPool = config.executor_providers.filter((p) => !isPinned(config, p, "reviewer"));

  const [execA, execB]: readonly [ProviderId, ProviderId] =
    executorPool.length === 2
      ? [firstExecutor, secondExecutor] // byte-identical to today's default (AC2) -- nobody is pinned "reviewer"
      : [executorPool[0] as ProviderId, executorPool[0] as ProviderId]; // collapse: the sole eligible provider fills both executor slots

  // The provider whose diff the reviewer slot reviews is always the second executor slot's
  // provider -- unchanged from today's definition (`run-loop.ts`'s own diff computation keys off
  // exactly this slot, PHASE_3_SPEC.md §6.1).
  const diffWriter = execB;

  const pinnedReviewer = config.executor_providers.find((p) => isPinned(config, p, "reviewer")) ?? null;

  let reviewerProvider: ProviderId;
  if (pinnedReviewer !== null) {
    // A provider pinned "reviewer" is always the reviewer when one exists -- RP4 (§3.3) guarantees
    // this agrees with `reviewer_provider` if that was also set explicitly.
    reviewerProvider = pinnedReviewer;
  } else if (config.reviewer_provider !== null) {
    // Today's existing explicit override, unaffected when no provider is pinned "reviewer". RP3
    // (§3.3) already guarantees this is not pinned "executor".
    reviewerProvider = config.reviewer_provider;
  } else {
    // Today's existing default: whichever provider did not write the diff under review.
    const naiveDefault = otherExecutorProvider(config, diffWriter);
    // If the naive default is pinned "executor" it is banned from the reviewer role (§6.3a). With
    // exactly two providers and no provider pinned "reviewer" in this branch (else we would already
    // be in the `pinnedReviewer !== null` branch above), the diff-writer itself is the only
    // remaining candidate -- RP2 (§3.3) guarantees at least one of {naiveDefault, diffWriter} is not
    // pinned "executor", so this always resolves to a valid provider.
    reviewerProvider = isPinned(config, naiveDefault, "executor") ? diffWriter : naiveDefault;
  }

  return [
    { archetype: "executor", provider: execA, reviewerReviewedOwnWork: false },
    { archetype: "executor", provider: execB, reviewerReviewedOwnWork: false },
    { archetype: "reviewer", provider: reviewerProvider, reviewerReviewedOwnWork: reviewerProvider === diffWriter },
  ];
}
