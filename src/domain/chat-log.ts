// Implements PHASE_10_SPEC.md §3
//
// `ChatLogEntry` -- the persistent chat log's own zod schema, its sub-schemas, and its three
// object-level refinements. Zero I/O, zero provider knowledge -- the same remit `src/domain/
// driver.ts` already has for `DriverLogEntry`.
//
// New leaf module: it imports `IsoUtc`/`RepoRelPath`/`FileRef` from `./relay.ts`, `ProviderIdSchema`
// from `./run.ts`, and `ModelTierSchema` from `./tiers.ts`, directly rather than redeclared -- the
// same treatment `src/domain/driver.ts` already gives the identical imports, and for the identical
// reason: the redeclaration in `run.ts` (`RepoRelPathLike`) exists solely to avoid a runtime cycle
// *between `relay.ts` and `run.ts` themselves*; this file imports neither in a way that could cycle.
// Nothing in `src/domain/**` imports this module (PHASE_10_SPEC.md §3.1).
//
// There is deliberately no reader function of any kind exported here (no entry parser, no entry
// loader) -- see PHASE_10_SPEC.md §6.6's greppable guard for the exact forbidden name shapes. This
// schema exists so the *writer* (`src/dispatch/chat-log.ts`) can be validated and unit-tested; it
// is never a reader (PHASE_10_SPEC.md §3.6, §6.6, PRD §9 FM16).

import { z } from "zod";
import { FileRef, IsoUtc, RepoRelPath } from "./relay.ts";
import { ProviderIdSchema } from "./run.ts";
import { ModelTierSchema } from "./tiers.ts";

/** The current (and, in Phase 10, only) chat-log schema version. Mirrors `RELAY_SCHEMA_VERSION`/`DriverLogEntry.schema_version`'s own precedent (PRD §9 FM5). */
export const CHAT_LOG_SCHEMA_VERSION = 1 as const;

/** The two genuinely distinct halves of one dispatched turn's chat-log record. */
export const CHAT_LOG_ENTRY_KINDS = ["prompt", "response"] as const;

/** A member of {@link CHAT_LOG_ENTRY_KINDS}. */
export type ChatLogEntryKind = (typeof CHAT_LOG_ENTRY_KINDS)[number];

/** zod schema for {@link ChatLogEntryKind}. */
export const ChatLogEntryKindSchema = z.enum(CHAT_LOG_ENTRY_KINDS);

/**
 * The verbatim payload. Three fields, **no length cap of any kind** on any of them -- a `.max()`
 * here would be truncation by validation and is forbidden (PRD §7 I7). All three are nullable
 * because a `"prompt"` entry carries only `prompt` and a `"response"` entry carries only
 * `stdout`/`stderr`; the object-level refinements below (CL1/CL2) make the correspondence exact.
 *
 * The containing key is named `transcript` **deliberately and must not be renamed**. `transcript`
 * matches `FORBIDDEN_RELAY_KEY_PATTERN` (`src/domain/relay.ts`) on purpose, converting the isolation
 * rule (PRD §7 I5) into a guard that fires on its own if a chat-log entry were ever wrongly merged
 * into a relay payload (PRD §6.5, §9 FM16c). See PHASE_10_SPEC.md §3.4.
 */
export const ChatLogTranscript = z.strictObject({
  prompt: z.string().nullable(),
  stdout: z.string().nullable(),
  stderr: z.string().nullable(),
});

/** The inferred type of {@link ChatLogTranscript}. */
export type ChatLogTranscript = z.infer<typeof ChatLogTranscript>;

/**
 * The turn's real result, recorded as data, never as a gate on whether the entry is written
 * (PRD §9 FM15). Sourced field-for-field from values `runTurn` already holds:
 * `RawInvocationResult.exitCode`/`.signal`/`.timedOut`/`.durationMs`, plus `TurnOutcome.ok` and
 * `TurnOutcome.failure?.message ?? null`. Implements PHASE_10_SPEC.md §3.5.
 */
export const ChatLogOutcome = z.strictObject({
  ok: z.boolean(),
  exit_code: z.number().int().nullable(),
  signal: z.string().min(1).nullable(),
  timed_out: z.boolean(),
  duration_ms: z.number().int().min(0),
  failure_message: z.string().min(1).nullable(),
});

/** The inferred type of {@link ChatLogOutcome}. */
export type ChatLogOutcome = z.infer<typeof ChatLogOutcome>;

const ChatLogEntryShape = z.strictObject({
  schema_version: z.literal(CHAT_LOG_SCHEMA_VERSION),
  written_at: IsoUtc,
  chat_log_id: z.uuid(),
  run_id: z.uuid(),
  phase: z.number().int().min(1),
  turn_index: z.number().int().min(0),
  entry_kind: ChatLogEntryKindSchema,
  role: z.enum(["executor", "reviewer"]),
  provider: ProviderIdSchema,
  model_tier: ModelTierSchema,
  model_override: z.string().min(1).nullable(),
  spec_ref: FileRef,
  baby_prd_path: RepoRelPath,
  context_path: RepoRelPath,
  outcome: ChatLogOutcome.nullable(),
  credential_shaped_content_detected: z.boolean(),
  transcript: ChatLogTranscript,
});

/**
 * One JSONL line of the persistent chat log: one half (`entry_kind`) of one dispatched turn's
 * exchange. Enforces three object-level refinements, chained in the
 * `HandoffRecordShape.refine(...).refine(...)` idiom `src/domain/relay.ts`/`src/domain/run.ts`
 * both already use -- one named rule per genuinely distinct invariant:
 * - CL1: `entry_kind === "prompt"` iff `transcript.prompt !== null`.
 * - CL2: `entry_kind === "response"` iff both `transcript.stdout` and `transcript.stderr` are
 *   non-null.
 * - CL3: `entry_kind === "prompt"` iff `outcome === null` (the turn has not run yet).
 * Implements PHASE_10_SPEC.md §3.6.
 */
export const ChatLogEntry = ChatLogEntryShape.refine(
  (e) => (e.entry_kind === "prompt") === (e.transcript.prompt !== null),
  {
    message: 'entry_kind === "prompt" iff transcript.prompt !== null (CL1)',
    path: ["transcript", "prompt"],
  },
)
  .refine((e) => (e.entry_kind === "response") === (e.transcript.stdout !== null && e.transcript.stderr !== null), {
    message: 'entry_kind === "response" iff both transcript.stdout and transcript.stderr are non-null (CL2)',
    path: ["transcript", "stdout"],
  })
  .refine((e) => (e.entry_kind === "prompt") === (e.outcome === null), {
    message: 'entry_kind === "prompt" iff outcome === null (CL3)',
    path: ["outcome"],
  });

/** The inferred type of {@link ChatLogEntry}. */
export type ChatLogEntry = z.infer<typeof ChatLogEntry>;
