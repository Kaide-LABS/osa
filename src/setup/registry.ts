// Implements PHASE_9_SPEC.md §6.1, §6.2, §6.5, §6.7
//
// The `claude mcp` interaction layer: pure argv builders, pure raw-result interpreters, the pure
// outcome decision, and the two thin I/O wrappers that call them. (The optional-research-server
// probe and note were removed with the servers themselves: docs/osa/CONFLICTS.md C-09.)

import type { OptionalServerState, SetupOutcome, SetupServerId } from "../domain/setup.ts";
import type { ResolvedLaunch } from "./servers.ts";
import type { RawInvocationResult } from "../domain/run.ts";
import type { RunProcessOptions } from "../util/exec.ts";
import { InternalError } from "../domain/errors.ts";
import { runProcess as runProcessDefault } from "../util/exec.ts";

const MCP_GET_TIMEOUT_MS = 60_000;
const MCP_ADD_TIMEOUT_MS = 60_000;

type RunProcessFn = (o: RunProcessOptions) => ReturnType<typeof runProcessDefault>;

/**
 * Builds the exact argv for `claude mcp add`:
 * `["mcp", "add", "--scope", "user", "--transport", "stdio", name, "--", command, ...args]`.
 * Pure -- reads only its arguments, never `process.env`/`process.cwd()`/`process.platform`/the
 * clock. `--scope user` is unconditional (PRD §9 FM11); `--transport stdio` is emitted explicitly
 * so the "stdio only" property is visible in the argv itself. Implements PHASE_9_SPEC.md §6.1, §6.2.
 */
export function buildMcpAddArgs(name: SetupServerId, launch: ResolvedLaunch): readonly string[] {
  return ["mcp", "add", "--scope", "user", "--transport", "stdio", name, "--", launch.command, ...launch.args];
}

/** Builds the exact argv for `claude mcp get`: `["mcp", "get", name]`. Pure. Implements PHASE_9_SPEC.md §6.2. */
export function buildMcpGetArgs(name: string): readonly string[] {
  return ["mcp", "get", name];
}

/**
 * Pure interpretation of a `claude mcp get <name>` invocation's raw result. Used only for the
 * post-add verify step (Step B below) and for `probeOptionalResearchServers`. Keyed on exit code
 * only, verified locally: `claude mcp get` exits 0 for a present server (including one that is
 * registered but non-functional), 1 for an absent name, and the `Status:` glyph rendered in its
 * stdout is never parsed (PRD §9 FM10) -- it is not a machine-readable signal, and Claude Code's
 * own docs warn it degrades on legacy Windows consoles.
 *
 * NOTE: `claude mcp get --help` has no `-s`/`--scope` flag at all -- a `get` on a name that exists
 * at *any* scope (local, project, or user) reports `present`, indistinguishable from a genuine
 * user-scope registration. That scope-blindness is exactly why this function is no longer used as
 * a pre-check gate before `claude mcp add` (see {@link interpretMcpAddResult}'s doc comment).
 */
export function interpretMcpGetResult(raw: RawInvocationResult): OptionalServerState {
  if (raw.timedOut) {
    return "indeterminate";
  }
  if (raw.exitCode === 0) {
    return "present";
  }
  if (raw.exitCode === 1) {
    return "absent";
  }
  return "indeterminate";
}

/**
 * Literal stderr substring `claude mcp add --scope user` prints, verbatim, when-and-only-when a
 * server of that exact name already exists at **user** scope specifically (verified live against
 * the real CLI). Unlike `claude mcp get`, this signal IS scope-specific: an existing local- or
 * project-scope entry of the same name does not trigger it, and `claude mcp add --scope user`
 * proceeds to create the user-scope entry in that case. Exported so the exact string this project
 * depends on is visible and testable in one place, not duplicated between implementation and tests.
 */
export const MCP_ADD_ALREADY_EXISTS_MARKER = "already exists in user config";

/**
 * Pure interpretation of a `claude mcp add --scope user` invocation's raw result. Implements the
 * post-bugfix flow described in {@link mcpAdd}'s doc comment: `--scope user` is attempted directly
 * (no `claude mcp get` pre-check), and the add's own result carries the idempotency signal.
 *
 * Four outcomes:
 * - `"ok"` -- exit 0. Newly added (or re-added identically); Step B below verifies via `get`.
 * - `"already-exists"` -- exit 1 (or any non-zero/non-timeout exit) AND stderr contains
 *   {@link MCP_ADD_ALREADY_EXISTS_MARKER}. A user-scope entry of this exact name already existed;
 *   nothing was changed, and `decideServerOutcome` maps this straight to `already-registered`.
 * - `"failed"` -- exit non-zero for any other reason (verified live: a malformed name, a missing
 *   `commandOrUrl` argument, and other genuine add failures all also exit 1, but their stderr does
 *   NOT contain {@link MCP_ADD_ALREADY_EXISTS_MARKER} -- so exit code alone cannot distinguish
 *   "already registered" from "genuinely failed"; the marker string is load-bearing here, not
 *   cosmetic).
 * - `"indeterminate"` -- the invocation timed out.
 */
export function interpretMcpAddResult(raw: RawInvocationResult): "ok" | "already-exists" | "failed" | "indeterminate" {
  if (raw.timedOut) {
    return "indeterminate";
  }
  if (raw.exitCode === 0) {
    return "ok";
  }
  if (raw.stderr.includes(MCP_ADD_ALREADY_EXISTS_MARKER)) {
    return "already-exists";
  }
  return "failed";
}

/**
 * The single total function mapping the add/post-verify pair to a {@link SetupOutcome}. Total over
 * every input combination, with a `never`-typed exhaustiveness assertion in the final arm -- the
 * same compile-time totality proof `decideDriverStep()` uses. Every reachable combination is
 * enumerated in `src/setup/registry.test.ts`'s AC-D1 table test.
 *
 * Sequencing note (bugfix, post-INSTALLER_BUNDLING_BUILD_COMPLETE.md): PHASE_9_SPEC.md §6.5
 * originally documented a pre-check/add/verify triple, gated by a `claude mcp get` pre-check whose
 * exit code cannot distinguish "registered at user scope" from "registered at local or project
 * scope" (`claude mcp get` has no `--scope` flag). That made the pre-check wrongly report
 * `already-registered` for a name that existed only at local/project scope, silently skipping the
 * `add --scope user` call this command exists to make. The pre-check is gone: `add --scope user`
 * is now attempted directly, and its own result -- specifically, whether its non-zero exit carries
 * {@link MCP_ADD_ALREADY_EXISTS_MARKER} -- carries the idempotency signal instead, because that
 * signal (verified live) IS scope-specific.
 */
export function decideServerOutcome(add: "ok" | "already-exists" | "failed" | "indeterminate", post: OptionalServerState | "not-attempted"): SetupOutcome {
  switch (add) {
    case "already-exists":
      return "already-registered";
    case "failed":
      return "failed";
    case "indeterminate":
      return "indeterminate";
    case "ok":
      switch (post) {
        case "present":
          return "registered";
        case "absent":
        case "indeterminate":
          return "registered-unverified";
        case "not-attempted":
          // Unreachable when add === "ok" (Step B always runs after a successful add), but still
          // mapped rather than left partial.
          return "registered-unverified";
        default: {
          const exhaustive: never = post;
          throw new InternalError(`decideServerOutcome: unreachable post state`, { post: exhaustive });
        }
      }
    default: {
      const exhaustive: never = add;
      throw new InternalError(`decideServerOutcome: unreachable add state`, { add: exhaustive });
    }
  }
}

/**
 * Runs `claude mcp add --scope user ...` for `name`/`launch` and returns the raw result. Thin I/O
 * wrapper around {@link buildMcpAddArgs}. `deps.runProcess` is a test seam only, defaulting to the
 * real `runProcess`. Called directly, with no `claude mcp get` pre-check gating it -- see
 * {@link interpretMcpAddResult}'s doc comment for why the pre-check was removed.
 */
export async function mcpAdd(
  name: SetupServerId,
  launch: ResolvedLaunch,
  deps?: { readonly runProcess?: RunProcessFn },
): Promise<RawInvocationResult> {
  const runProcess = deps?.runProcess ?? runProcessDefault;
  return runProcess({ command: "claude", args: [...buildMcpAddArgs(name, launch)], cwd: process.cwd(), timeoutMs: MCP_ADD_TIMEOUT_MS });
}

/**
 * Runs `claude mcp get <name>` and returns the raw result. Thin I/O wrapper around
 * {@link buildMcpGetArgs}. `deps.runProcess` is a test seam only, defaulting to the real
 * `runProcess`.
 */
export async function mcpGet(
  name: string,
  deps?: { readonly runProcess?: RunProcessFn },
): Promise<RawInvocationResult> {
  const runProcess = deps?.runProcess ?? runProcessDefault;
  return runProcess({ command: "claude", args: [...buildMcpGetArgs(name)], cwd: process.cwd(), timeoutMs: MCP_GET_TIMEOUT_MS });
}
