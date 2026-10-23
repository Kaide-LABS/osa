// Implements PHASE_1_SPEC.md §3.3
//
// The host-agnostic archetype/role registry (PRD §6, §6.3). This file records *what* each
// archetype is and how it participates in V1 -- never a concrete provider, model name, or spawn
// mechanism. `receivesPriorAgentReasoning` is pinned to the literal `false` for every role, which
// makes the isolation invariant (PRD §7 I5) a type-level fact rather than a convention.

import { z } from "zod";
import { InternalError } from "./errors.ts";
import { ModelTierSchema } from "./tiers.ts";

/** The five canonical archetypes (PRD §6). */
export const ARCHETYPES = ["architect", "researcher", "executor", "reviewer", "auditor"] as const;

/** A member of {@link ARCHETYPES}. */
export type Archetype = (typeof ARCHETYPES)[number];

/** Host-agnostic definition of a single archetype's participation in V1 (PRD §6.3). */
export const RoleDefinition = z.strictObject({
  archetype: z.enum(ARCHETYPES),
  tier: ModelTierSchema,
  instantiatedInV1: z.boolean(),
  crossProviderInV1: z.boolean(),
  receivesPriorAgentReasoning: z.literal(false),
  profileSummary: z.string().min(20).max(600),
});

/** The inferred type of {@link RoleDefinition}. */
export type RoleDefinition = z.infer<typeof RoleDefinition>;

/**
 * The canonical role registry, matching PRD §6 and §6.3 exactly. `architect.instantiatedInV1` is
 * `false` because the architect is the operator's own persistent session, never dispatched by
 * OSA. `executor` is the only archetype `crossProviderInV1: true` -- it is the handoff
 * AC1 measures.
 */
export const ROLE_REGISTRY: Readonly<Record<Archetype, RoleDefinition>> = {
  architect: {
    archetype: "architect",
    tier: "research-grade",
    instantiatedInV1: false,
    crossProviderInV1: false,
    receivesPriorAgentReasoning: false,
    profileSummary:
      "Owns the spec chain and scratch files, routes escalations, and dispatches every other " +
      "archetype. The persistent, operator-controlled session; never spawned or swapped across " +
      "providers by OSA itself.",
  },
  researcher: {
    archetype: "researcher",
    tier: "research-grade",
    instantiatedInV1: false,
    crossProviderInV1: false,
    receivesPriorAgentReasoning: false,
    profileSummary:
      "Verifies real external facts -- versions, API signatures, documentation -- against current " +
      "sources and escalates contradictions rather than silently resolving them. Not instantiated " +
      "in V1.",
  },
  executor: {
    archetype: "executor",
    tier: "high-volume-low-effort",
    instantiatedInV1: true,
    crossProviderInV1: true,
    receivesPriorAgentReasoning: false,
    profileSummary:
      "Writes code against the phase spec it is given, without visibility into upstream " +
      "conversation or reasoning. Highest output volume of any archetype; checked immediately " +
      "downstream by the reviewer.",
  },
  reviewer: {
    archetype: "reviewer",
    tier: "verification-grade",
    instantiatedInV1: true,
    crossProviderInV1: false,
    receivesPriorAgentReasoning: false,
    profileSummary:
      "Verifies an executor's phase output against the phase spec and the diff alone, then " +
      "generates the next phase spec. Flags problems; never overrules. Isolated from the " +
      "executor's conversation by construction.",
  },
  auditor: {
    archetype: "auditor",
    tier: "verification-grade",
    instantiatedInV1: false,
    crossProviderInV1: false,
    receivesPriorAgentReasoning: false,
    profileSummary:
      "Dispatched on demand, scoped only to the specific items flagged by a halted reviewer and " +
      "their referenced spec clauses and code. Not instantiated in V1.",
  },
};

/**
 * Looks up a role definition by archetype. Total over {@link ARCHETYPES}; throws
 * {@link InternalError} only if called with a value outside that union (unreachable at the type
 * level, guarded defensively at runtime).
 */
export function getRole(a: Archetype): RoleDefinition {
  const role = ROLE_REGISTRY[a];
  if (role === undefined) {
    throw new InternalError(`getRole: unreachable archetype "${a}"`, { archetype: a });
  }
  return role;
}
