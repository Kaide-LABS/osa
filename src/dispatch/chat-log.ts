// Implements PHASE_10_SPEC.md §4.4, §6
//
// The write-only I/O + pure-construction module for the persistent chat log: entry builders,
// credential detection, warning composition, the append function, and the gitignore-management
// function. No reader function of any kind (an entry parser, a whole-log loader) exists here or
// anywhere in `src/**` (PHASE_10_SPEC.md §6.6, PRD §9 FM16) -- see that section's own greppable
// guard for the exact forbidden name shapes this file must never introduce.
//
// Both I/O functions (`appendChatLogEntry`, `ensureChatLogGitignore`) never reject and never throw
// (PRD §7 I6, §9 FM14): a logging failure can never abort, corrupt, or change the exit code of the
// run it logs. Their return value (`string | null`) is only ever pushed onto a warnings array --
// never used to branch.

import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RawInvocationResult, TurnOutcome, TurnRequest } from "../domain/run.ts";
import type { ChatLogEntry } from "../domain/chat-log.ts";
import { CHAT_LOG_SCHEMA_VERSION } from "../domain/chat-log.ts";
import { InternalError } from "../domain/errors.ts";
import { chatLogGitignorePath } from "../util/paths.ts";

/**
 * Narrows `TurnRequest.archetype` (the five-member `Archetype` union) to `ChatLogEntry.role`'s
 * two-member set. Every turn `runTurn()` is ever invoked with is dispatched by
 * `dispatchOneAttempt()` (`src/dispatch/run-loop.ts`), whose own `slot.archetype` is already typed
 * `"executor" | "reviewer"` -- V1 dispatches no other archetype -- so this narrowing is total in
 * practice; an unreachable third value throws {@link InternalError} rather than being silently
 * miscategorised, the same defensive shape `getRole()` (`src/domain/roles.ts`) already uses for the
 * identical kind of "structurally total, but not provably so to the type checker" narrowing.
 */
function chatLogRole(archetype: TurnRequest["archetype"]): "executor" | "reviewer" {
  if (archetype === "executor" || archetype === "reviewer") {
    return archetype;
  }
  throw new InternalError(`chat log: unexpected archetype "${archetype}" for a dispatched turn`, { archetype });
}

/**
 * The managed content of the chat log's own directory-local `.gitignore`. A bare `*` line ignores
 * that directory's entire contents, **including the `.gitignore` file itself** -- no root-level
 * `.gitignore` edit and no `!.gitignore` negation is needed [VERIFIED-LOCAL against real
 * `git 2.54.0.windows.1`, PRD §8.9.4 item 4]. Implements PHASE_10_SPEC.md §4.3.
 */
export const CHAT_LOG_GITIGNORE_CONTENT: string = [
  "# OSA persistent chat log -- ignored by default.",
  "#",
  "# This directory holds the verbatim prompt and response of every dispatched turn, including",
  "# whatever the provider CLIs actually emitted. OSA does NOT claim these files are safe",
  "# to commit. Read one before you make it trackable.",
  "#",
  "# To override: set \"chat_log_gitignored\": false in your run/drive config and run again --",
  "# OSA will remove this file and the logs become trackable. See README.md.",
  "*",
  "",
].join("\n");

/**
 * The credential-shaped-content pattern, copied verbatim (non-global form, correct for `.test()`)
 * from this project's own existing use in `src/adapters/conformance.ts` -- reused, not reinvented.
 * Deliberately **not** the `/g`-flagged variant in `src/cli/doctor.ts`: a global regex carries
 * `lastIndex` state across `.test()` calls and would produce alternating false negatives.
 */
const CREDENTIAL_LOOKING_PATTERN = /(sk-|ghp_|xoxb-)[A-Za-z0-9_-]+/;

/**
 * [DET] `true` iff any non-null text in `texts` contains a credential-shaped token this project's
 * existing pattern recognises (`sk-`, `ghp_`, `xoxb-` prefixed). Pure. This is a flag only: it never
 * alters, redacts, masks, elides, or withholds one byte of the texts it inspects (PRD §9 FM17
 * layer 2). Implements PHASE_10_SPEC.md §6.7.
 */
export function detectCredentialShapedContent(texts: readonly (string | null)[]): boolean {
  return texts.some((t) => t !== null && CREDENTIAL_LOOKING_PATTERN.test(t));
}

/** Input to {@link buildPromptEntry}. */
export interface BuildPromptEntryInput {
  readonly req: TurnRequest;
}

/** Input to {@link buildResponseEntry}. */
export interface BuildResponseEntryInput {
  readonly req: TurnRequest;
  readonly raw: RawInvocationResult;
  readonly outcome: TurnOutcome;
}

/**
 * [DET, FM15] Builds the `"prompt"` half of one turn's chat-log entry pair -- capture point 1,
 * written *before* the provider process is spawned, so an in-flight turn's input survives even if
 * the operator kills the run before a response exists. `req.prompt` is recorded exactly as
 * `buildExecutorPrompt`/`buildReviewerPrompt` produced it: never reconstructed, re-rendered,
 * normalised, trimmed, or "cleaned up". Implements PHASE_10_SPEC.md §6.5.
 */
export function buildPromptEntry(input: BuildPromptEntryInput): ChatLogEntry {
  const { req } = input;
  return {
    schema_version: CHAT_LOG_SCHEMA_VERSION,
    written_at: new Date().toISOString(),
    chat_log_id: req.chatLogId,
    run_id: req.runId,
    phase: req.phase,
    turn_index: req.turnIndex,
    entry_kind: "prompt",
    role: chatLogRole(req.archetype),
    provider: req.provider,
    model_tier: req.tier,
    model_override: req.modelOverride,
    spec_ref: req.specRef,
    baby_prd_path: req.babyPrdPath,
    context_path: req.contextPath,
    outcome: null,
    credential_shaped_content_detected: detectCredentialShapedContent([req.prompt]),
    transcript: { prompt: req.prompt, stdout: null, stderr: null },
  };
}

/**
 * [DET, FM15] Builds the `"response"` half of one turn's chat-log entry pair -- capture point 2,
 * written immediately after the raw invocation is interpreted, above every `return` in `runTurn`
 * (PHASE_10_SPEC.md §6.4). `raw.stdout`/`raw.stderr` are recorded exactly as captured. Implements
 * PHASE_10_SPEC.md §6.5.
 */
export function buildResponseEntry(input: BuildResponseEntryInput): ChatLogEntry {
  const { req, raw, outcome } = input;
  return {
    schema_version: CHAT_LOG_SCHEMA_VERSION,
    written_at: new Date().toISOString(),
    chat_log_id: req.chatLogId,
    run_id: req.runId,
    phase: req.phase,
    turn_index: req.turnIndex,
    entry_kind: "response",
    role: chatLogRole(req.archetype),
    provider: req.provider,
    model_tier: req.tier,
    model_override: req.modelOverride,
    spec_ref: req.specRef,
    baby_prd_path: req.babyPrdPath,
    context_path: req.contextPath,
    outcome: {
      ok: outcome.ok,
      exit_code: raw.exitCode,
      signal: raw.signal,
      timed_out: raw.timedOut,
      duration_ms: raw.durationMs,
      failure_message: outcome.failure?.message ?? null,
    },
    credential_shaped_content_detected: detectCredentialShapedContent([raw.stdout, raw.stderr]),
    transcript: { prompt: null, stdout: raw.stdout, stderr: raw.stderr },
  };
}

/**
 * [DET] Serialises one {@link ChatLogEntry} as a single JSONL line: `JSON.stringify(entry)` plus a
 * trailing `"\n"`. No pretty-printing (would break the one-object-per-line contract) and no key
 * reordering pass (unlike `serialiseHandoffRecord`, this log is never diffed for stability, and
 * `JSON.stringify` on an object literal already preserves insertion order). Implements
 * PHASE_10_SPEC.md §6.8.
 */
export function serialiseChatLogEntry(entry: ChatLogEntry): string {
  return JSON.stringify(entry) + "\n";
}

/**
 * [DET] Returns a human-readable warning naming the phase, turn index, role, provider and
 * `entry_kind` when `entry.credential_shaped_content_detected` is `true`, stating that the log was
 * written verbatim and nothing was redacted -- and, when `gitignored === false`, adding explicitly
 * that the override means this content is committable and should be reviewed first. Returns `null`
 * when the flag is `false`. The payload is never altered by this function or any other in this
 * module (PRD §9 FM17 layer 2). Implements PHASE_10_SPEC.md §6.7.
 */
export function credentialWarningFor(entry: ChatLogEntry, gitignored: boolean): string | null {
  if (!entry.credential_shaped_content_detected) {
    return null;
  }
  const base =
    `chat log: credential-shaped content detected in phase ${String(entry.phase)} turn ` +
    `${String(entry.turn_index)} (${entry.role}/${entry.provider}, ${entry.entry_kind} entry). The log was ` +
    "written verbatim -- nothing was redacted, masked, or altered.";
  if (!gitignored) {
    return (
      base +
      " The chat-log ignore has been overridden (chat_log_gitignored: false), so this content is " +
      "committable -- review it before committing."
    );
  }
  return base;
}

/**
 * Appends one {@link ChatLogEntry} to the JSONL chat log at `absPath`, creating parent directories
 * as needed. Never throws and never rejects -- any failure is returned as a human-readable warning
 * string; the run this entry belongs to is unaffected and the entry is simply missing from the log
 * (PRD §7 I6, §9 FM14). Sole-writer property: `runTurnLoop`/`runDrive` are strictly sequential and
 * concurrent runs against one repo are already prevented by the exclusive run lock
 * (`src/util/lock.ts`, PRD §9 FM6), so file order equals real dispatch order without any lock,
 * queue, write stream, or mutex here. Implements PHASE_10_SPEC.md §6.8.
 */
export async function appendChatLogEntry(absPath: string, entry: ChatLogEntry): Promise<string | null> {
  try {
    await mkdir(dirname(absPath), { recursive: true });
    await appendFile(absPath, serialiseChatLogEntry(entry), "utf8");
    return null;
  } catch (err) {
    return (
      `chat log: failed to append ${entry.entry_kind} entry for phase ${String(entry.phase)} turn ` +
      `${String(entry.turn_index)} to "${absPath}": ${err instanceof Error ? err.message : String(err)}. ` +
      "The run is unaffected; this entry is missing from the log."
    );
  }
}

/**
 * Narrows an unknown catch value to a Node.js `ErrnoException`, the same structural check
 * `src/dispatch/driver-loop.ts`'s own private `isNodeError` helper uses (not imported from there:
 * that helper is not exported and this file is not on its own touched-files list).
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * [DET] Ensures the chat log's own directory-local `.gitignore` matches `gitignored`, applying the
 * deliberately asymmetric table from PHASE_10_SPEC.md §4.3 exactly:
 *
 * | on disk | gitignored: true | gitignored: false |
 * |---|---|---|
 * | no file | write {@link CHAT_LOG_GITIGNORE_CONTENT} | no-op |
 * | content equals the managed content | no-op | `unlink` it |
 * | content differs | **overwrite** it, warn that pre-existing content was replaced | **leave it untouched**, warn the override could not take effect |
 *
 * OSA will write its own safe default over anything inside the directory it owns, but will
 * **never delete a file it did not write** -- erring toward "ignored" is safe, erring toward
 * "deleted the operator's file" is not.
 *
 * Never throws and never rejects; any unexpected error is returned as a warning naming
 * `chatLogGitignorePath(repoDir)` and the OS error message. Returns `null` on success (including
 * every no-op case). Call this exactly once per run, before any chat-log entry can be written
 * (`runTurnLoop`, before its turn-dispatch loop begins) -- never after, so a log file can never
 * become momentarily visible to `git status` before it is ignored. Implements PHASE_10_SPEC.md §6.1.
 */
export async function ensureChatLogGitignore(repoDir: string, gitignored: boolean): Promise<string | null> {
  const gitignorePath = chatLogGitignorePath(repoDir);
  try {
    await mkdir(dirname(gitignorePath), { recursive: true });

    let existing: string | null;
    try {
      existing = await readFile(gitignorePath, "utf8");
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        existing = null;
      } else {
        throw err;
      }
    }

    if (gitignored) {
      if (existing === null) {
        await writeGitignore(gitignorePath);
        return null;
      }
      if (existing === CHAT_LOG_GITIGNORE_CONTENT) {
        return null;
      }
      await writeGitignore(gitignorePath);
      return (
        `chat log: a pre-existing file at "${gitignorePath}" did not match OSA's managed ` +
        "gitignore content and was overwritten with the managed default."
      );
    }

    // gitignored === false: the documented override.
    if (existing === null) {
      return null;
    }
    if (existing === CHAT_LOG_GITIGNORE_CONTENT) {
      await unlink(gitignorePath);
      return null;
    }
    return (
      `chat log: chat_log_gitignored is false, but a file at "${gitignorePath}" that OSA does ` +
      "not manage sits at that path, so the override could not take effect. It was left untouched."
    );
  } catch (err) {
    return (
      `chat log: failed to manage "${gitignorePath}": ${err instanceof Error ? err.message : String(err)}. ` +
      "The run is unaffected."
    );
  }
}

/** Writes {@link CHAT_LOG_GITIGNORE_CONTENT} to `gitignorePath`. */
async function writeGitignore(gitignorePath: string): Promise<void> {
  await writeFile(gitignorePath, CHAT_LOG_GITIGNORE_CONTENT, "utf8");
}
