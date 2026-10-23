// Implements PHASE_9_SPEC.md §3
//
// Closed enumerations and zod schemas for the `OSA setup` feature. Host-agnostic data with
// no I/O, matching where `src/domain/run.ts`, `src/domain/driver.ts`, and `src/domain/roles.ts`
// already sit. Contains no shell-out, no `node:child_process`, and no filesystem access.

import { z } from "zod";

/**
 * The servers `osa setup` registers: OSA's own only. (Pre-OSA this was a three-server catalog that also
 * registered `arxiv-mcp` and `paper-search-mcp`; the directive replaced them with built-in HTTP clients --
 * docs/osa/CONFLICTS.md C-09.)
 */
export const SETUP_SERVER_IDS = ["osa"] as const;

/** zod schema for {@link SetupServerId}. */
export const SetupServerIdSchema = z.enum(SETUP_SERVER_IDS);

/** The type of a value in {@link SETUP_SERVER_IDS}. */
export type SetupServerId = (typeof SETUP_SERVER_IDS)[number];

/** The launcher shapes `resolveServerLaunch` can resolve to. */
export const SETUP_LAUNCHER_KINDS = ["node"] as const;

/** zod schema for {@link SetupLauncherKind}. */
export const SetupLauncherKindSchema = z.enum(SETUP_LAUNCHER_KINDS);

/** The type of a value in {@link SETUP_LAUNCHER_KINDS}. */
export type SetupLauncherKind = (typeof SETUP_LAUNCHER_KINDS)[number];

/**
 * The seven genuinely distinct outcomes one server's registration attempt can reach. Every
 * member's exact meaning is normative -- PHASE_9_SPEC.md §3.1's table is authoritative; a summary:
 *
 * - `registered` -- `claude mcp add` exited 0 AND an independent post-add `claude mcp get` exited
 *   0. Means "present in the agent's configuration", never "the server works" (FM-I2).
 * - `registered-unverified` -- `claude mcp add` exited 0 but the post-add `claude mcp get` did not.
 *   Distinct from both `registered` and `failed` (FM-I1, PRD §9 FM10).
 * - `already-registered` -- the pre-add `claude mcp get` exited 0. No `claude mcp add` was issued.
 * - `failed` -- `claude mcp add` was issued and exited non-zero (or the spawn itself failed).
 * - `skipped-launcher-unavailable` -- no runnable launch command could be resolved. Nothing was
 *   written to the config.
 * - `skipped-no-agent-cli` -- the `claude` CLI itself was not found.
 * - `indeterminate` -- a probe timed out or returned an undocumented result. Nothing was written.
 */
export const SETUP_OUTCOMES = [
  "registered",
  "registered-unverified",
  "already-registered",
  "failed",
  "skipped-launcher-unavailable",
  "skipped-no-agent-cli",
  "indeterminate",
] as const;

/** zod schema for {@link SetupOutcome}. */
export const SetupOutcomeSchema = z.enum(SETUP_OUTCOMES);

/** The type of a value in {@link SETUP_OUTCOMES}. */
export type SetupOutcome = (typeof SETUP_OUTCOMES)[number];

/**
 * The three-state result of a `claude mcp get <name>` probe, mirroring `AuthProbeState`'s own
 * existing three-state precedent (`src/verify/preflight.ts`): a probe that failed is not the same
 * fact as a server that is missing.
 */
export const OPTIONAL_SERVER_STATES = ["present", "absent", "indeterminate"] as const;

/** zod schema for {@link OptionalServerState}. */
export const OptionalServerStateSchema = z.enum(OPTIONAL_SERVER_STATES);

/** The type of a value in {@link OPTIONAL_SERVER_STATES}. */
export type OptionalServerState = (typeof OPTIONAL_SERVER_STATES)[number];

/**
 * The per-server result of one `OSA setup` invocation. `required` is a *reported* field,
 * not a decision input -- `computeSetupExitCode` reads `SETUP_SERVERS`' own catalog, not this
 * report. Implements PHASE_9_SPEC.md §3.2.
 */
export const ServerSetupResult = z.strictObject({
  id: SetupServerIdSchema,
  /** True for "osa" (the only server since OSA WS3; the optional research servers were removed). */
  required: z.boolean(),
  outcome: SetupOutcomeSchema,
  /** The launcher kind actually resolved, or null when none was (or when nothing was attempted). */
  launcher: SetupLauncherKindSchema.nullable(),
  /** The command this invocation registered (or would have). Null when nothing was resolved. */
  command: z.string().nullable(),
  /** The args this invocation registered (or would have). Null when nothing was resolved. */
  args: z.array(z.string()).nullable(),
  /**
   * Human-readable detail. For `already-registered` this carries the raw first lines of
   * `claude mcp get`'s stdout, passed through verbatim and never parsed -- see registry.ts.
   */
  detail: z.string(),
  /** Exact, copy-pasteable remediation, or null when there is nothing for the operator to do. */
  remediation: z.string().nullable(),
});

/** The inferred type of {@link ServerSetupResult}. */
export type ServerSetupResult = z.infer<typeof ServerSetupResult>;
