// Implements PHASE_1_SPEC.md §3.6
//
// The portability seam (PRD §6.1). Declarations only -- Phase 1 ships no implementation of
// `ProviderAdapter` and no `AdapterRegistry` value. A file under `src/adapters/` appearing in
// Phase 1 is a scope violation (PHASE_1_SPEC.md §9, non-goal #1).

import type { ModelTier } from "../domain/tiers.ts";
import type { AuthProbeState, ProviderId, RawInvocationResult, TurnOutcome, TurnRequest } from "../domain/run.ts";

/**
 * A fully-specified child-process invocation, ready to hand to `runProcess()`
 * (`src/util/exec.ts`). Producing one is the entire job of `ProviderAdapter.buildInvocation`.
 */
export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  /**
   * An **additive overlay**, not a full replacement: whatever process actually spawns this
   * invocation (Phase 3's dispatch loop, via `runProcess()`) must construct the child's
   * environment as `{ ...process.env, ...invocation.env }`, never as `invocation.env` alone. This
   * is what lets `buildInvocation` stay pure (per this interface's own doc comment: "no
   * environment read beyond what `req` already carries") while the provider CLI still inherits
   * the operator's ambient PATH, credentials, and shell environment at actual spawn time. An
   * adapter returns a non-empty `env` only for values it must deterministically force (none
   * needed by either Phase 2 adapter -- see `src/adapters/claude-code.ts` / `codex-cli.ts`).
   * Implements PHASE_2_SPEC.md §1.4.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** `null` => stdin is closed immediately, never inherited from the parent TTY (PRD §9 FM7). */
  readonly stdin: string | null;
}

/** The result of a single provider's health check (toolchain presence, version, auth state). */
export interface PreflightReport {
  readonly provider: ProviderId;
  readonly cliFound: boolean;
  readonly version: string | null;
  readonly versionInRange: boolean;
  /**
   * `true` iff {@link authState} is `"authenticated"` -- exactly the meaning this field has always
   * had ("definitively authenticated"). Both of the other two states report `false` here, so every
   * consumer written against this boolean alone (including the `doctor --json` schema's own
   * `providers[].authenticated`) keeps its prior behaviour byte-for-byte. {@link authState} is the
   * additive discriminant that tells "genuinely not signed in" apart from "the probe failed".
   */
  readonly authenticated: boolean;
  /** Which of the three real probe outcomes produced {@link authenticated}. */
  readonly authState: AuthProbeState;
  /** Empty array => healthy. */
  readonly problems: readonly string[];
}

/**
 * The mechanism-independent port every provider CLI is driven through (PRD §6.1 portability
 * constraint). A port to a new provider is a new implementation of this interface, never a
 * redesign of the layers above it.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;

  /** Observes this provider's toolchain/auth health. Never establishes credentials (boundary rule B6). */
  preflight(): Promise<PreflightReport>;

  /** Maps an abstract {@link ModelTier} to this provider's own concrete effort setting (PRD §6.2). */
  resolveEffort(tier: ModelTier): string;

  /**
   * Builds the child-process invocation for one turn. **Must be pure**: no I/O, no clock, no
   * environment read beyond what `req` already carries. Purity is what makes Phase 2's adapters
   * testable without spawning an LLM, and Phase 2's conformance suite depends on it.
   */
  buildInvocation(req: TurnRequest): Invocation;

  /** Interprets a completed process result as a {@link TurnOutcome}. */
  interpretResult(raw: RawInvocationResult): TurnOutcome;
}

/** One adapter per {@link ProviderId}, always both present. Phase 1 ships no value of this type. */
export type AdapterRegistry = Readonly<Record<ProviderId, ProviderAdapter>>;
