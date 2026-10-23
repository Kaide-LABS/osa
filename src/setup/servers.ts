// Implements PHASE_9_SPEC.md §6.3, §6.4 (amended by OSA WS3, docs/osa/CONFLICTS.md C-09)
//
// The server catalog and the pure launcher resolution. The catalog used to carry two OPTIONAL research
// servers (`arxiv-mcp`, `paper-search-mcp`) registered at setup time; OSA's directive replaces them with
// built-in arXiv/OpenAlex clients (`src/research/net/`), so the catalog is now OSA's own server only and
// the uvx / Python-module launch forms are gone. Only `probeLauncherFacts` performs I/O, and it does so
// exclusively through `runProcess` (`src/util/exec.ts`) -- never `node:child_process` directly
// (PHASE_1_SPEC.md §8 acceptance check #8).

import type { SetupLauncherKind, SetupServerId } from "../domain/setup.ts";
import type { RunProcessOptions } from "../util/exec.ts";
import { runProcess as runProcessDefault } from "../util/exec.ts";

const LAUNCHER_PROBE_TIMEOUT_MS = 15_000;

/** One entry in the fixed, `as const` server catalog. */
export interface SetupServerDefinition {
  readonly id: SetupServerId;
  readonly kind: "self";
  readonly required: boolean;
}

/** The fixed catalog: OSA's own MCP server, required. */
export const SETUP_SERVERS: readonly SetupServerDefinition[] = [{ id: "osa", kind: "self", required: true }] as const;

/** The concretely resolved launch command for one server: the launcher kind, the command to spawn, and its arguments. */
export interface ResolvedLaunch {
  readonly kind: SetupLauncherKind;
  readonly command: string;
  readonly args: readonly string[];
}

/** The environment facts `resolveServerLaunch` needs, gathered once per `osa setup` invocation by {@link probeLauncherFacts}. */
export interface LauncherProbeFacts {
  readonly platform: NodeJS.Platform;
  /** True iff `node --version` exited 0 (i.e. `node` is resolvable on PATH, not just as argv[0]). */
  readonly nodeOnPath: boolean;
  /** Absolute path to the currently running Node binary -- `process.execPath`. */
  readonly nodeExecPath: string;
}

/**
 * Runs the one launcher-availability probe (`node --version`) and returns the observed facts. It goes
 * through `runProcess`, so stdin is closed and a timeout is always armed (PRD §9 FM7); `runProcess` never
 * rejects, so this function never throws. `deps.runProcess` is a test seam only.
 */
export async function probeLauncherFacts(deps?: {
  readonly runProcess?: (o: RunProcessOptions) => ReturnType<typeof runProcessDefault>;
}): Promise<LauncherProbeFacts> {
  const runProcess = deps?.runProcess ?? runProcessDefault;
  const nodeResult = await runProcess({ command: "node", args: ["--version"], cwd: process.cwd(), timeoutMs: LAUNCHER_PROBE_TIMEOUT_MS });
  return { platform: process.platform, nodeOnPath: nodeResult.exitCode === 0, nodeExecPath: process.execPath };
}

/** The result of {@link resolveServerLaunch}: either a concretely resolved launch, or why not. */
export type LaunchResolution =
  | { readonly kind: "resolved"; readonly launch: ResolvedLaunch }
  | { readonly kind: "unavailable"; readonly reason: string; readonly remediation: string };

/**
 * Rejects an `entryPath` this project's own `src/util/exec.ts` (`buildWindowsCmdRelaunch`) could
 * never safely spawn: not absolute, containing a `"`, or ending in `\`.
 */
function isUnsafeEntryPath(entryPath: string): boolean {
  return !isAbsolutePath(entryPath) || entryPath.includes('"') || entryPath.endsWith("\\");
}

/** Minimal absolute-path check covering both POSIX (`/...`) and Windows (`C:\...`, `\\...`) forms. */
function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(p);
}

/**
 * Pure resolution of the launch command for the catalog entry, given the current machine's launcher
 * facts and the CLI entry module's absolute path. Reads only its three arguments -- no `process.platform`,
 * no I/O. Implements PHASE_9_SPEC.md §6.4.
 */
export function resolveServerLaunch(_def: SetupServerDefinition, facts: LauncherProbeFacts, entryPath: string): LaunchResolution {
  if (isUnsafeEntryPath(entryPath)) {
    return {
      kind: "unavailable",
      reason: `the osa CLI entry path "${entryPath}" cannot be safely written into a spawned command (not absolute, or contains a quote, or ends in a backslash)`,
      remediation: "Reinstall osa so its entry module resolves to a safe absolute path, then re-run `osa setup`.",
    };
  }
  return facts.nodeOnPath
    ? { kind: "resolved", launch: { kind: "node", command: "node", args: [entryPath, "mcp"] } }
    : { kind: "resolved", launch: { kind: "node", command: facts.nodeExecPath, args: [entryPath, "mcp"] } };
}
