#!/usr/bin/env node
// Implements PHASE_1_SPEC.md §6.11
//
// Argument parsing (hand-rolled, no dependency -- `dependencies` is allowlisted to `zod` alone,
// boundary rule B2), command dispatch, and top-level error -> exit-code mapping. Declared as the
// `bin` entry in package.json.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isEntryPoint } from "../util/entry.ts";
import pkg from "../../package.json" with { type: "json" };
import { ExitCode, InternalError, OsaError, UsageError } from "../domain/errors.ts";
import type { DoctorOptions, DoctorReport } from "./doctor.ts";
import { runDoctor } from "./doctor.ts";
import type { RunCommandOptions, RunReport } from "./run.ts";
import { runRunCommand } from "./run.ts";
import type { EvidenceCommandOptions, EvidenceReport } from "./evidence.ts";
import { runEvidenceCommand } from "./evidence.ts";
import type { DriveCommandOptions, DriveReport } from "./drive.ts";
import { runDriveCommand } from "./drive.ts";
import { runMcpServer } from "../mcp/server.ts";
import { renderSetupHumanReport, runSetupCommand } from "./setup.ts";
import type { OsaCommandOptions } from "../osa/pipeline.ts";
import { runIndexCommand, runSearchCommand } from "./index-cmd.ts";
import { runCbmCommand } from "./cbm-cmd.ts";
import type { CbmCommandOptions } from "./cbm-cmd.ts";
import type { IndexCommandOptions, SearchCommandOptions } from "./index-cmd.ts";
import { runMemoryCommand } from "./memory-cmd.ts";
import type { MemoryCommandOptions } from "./memory-cmd.ts";
import { renderOsaRunReport, runOsaCommand } from "../osa/pipeline.ts";
import { applyFeatureFlags, describeFeatures, mergeFlags, parseFeatureFlag, renderFeatures } from "../features/features.ts";
import type { FeatureFlags } from "../features/features.ts";
import { loadOsaConfig } from "../util/config-file.ts";

const USAGE_TEXT = `Usage: osa <command> [options]

OSA -- One-Shot Anything.

One-shot:
  osa "<what you want built>" [--file <path>]... [--repo-dir <path>] [--yes] [--spec-only] [--json]
                                            Turn one prompt into a TL;DR + baby PRD with tagged
                                            assumptions, confirm once at the lock (Lock / Edit /
                                            Cancel), then run to completion with no further questions.
                                            --yes locks automatically only when no assumption is risky.
                                            --spec-only stops after research and the spec (no build).

Code index:
  osa index [--repo-dir <path>] [--json]    Build or refresh the local semantic code index (.osa/index, git-ignored).
  osa search "<query>" [-k <n>] [--repo-dir <path>] [--no-refresh] [--json]
                                            Find where something lives: ranked paths + line ranges + snippets.

Project memory:
  osa memory [--repo-dir <path>] [--json]   Show what OSA remembers about this project (.osa/memory).

Optional plug-ins (each has one switch; OFF means none of its code runs):
  osa cbm install [--dir <path>] [--harden] [--write-config]   Download, verify and test the pinned codebase-memory-mcp (opt-in code search);
  osa cbm status [--repo-dir <path>] [--json]        check it is installed, the right version, and can start
  osa features [--repo-dir <path>] [--json] List the switches -- CBM code index, trim-1, quoted stated rules --
                                            with their state and where each was set (flag, config or default).
  Flags for one command (they win over osa.config.json): --index-engine lexical|cbm|hybrid, --trim / --no-trim,
  --quote-stated-rules / --no-quote-stated-rules. Accepted by: osa "<prompt>", search, doctor, features.

Commands:
  osa --version | -v                        Print the version and exit.
  osa --help | -h                           Print this usage text and exit.
  osa doctor [--json]                       Full health check: toolchain, all provider identities,
                                            boundary scan, and a lock smoke test.
  osa doctor --boundary [--json]            Boundary scan only (fast, no provider probes).
  osa doctor --providers [--json]           Provider preflight only.
  osa run --config <path> [--json]          Dispatch one loopr phase's turn sequence. Providers may
                                            be pinned to a fixed role via the config's role_pins.
  osa evidence --repo-dir <path> --run-id <uuid> [--final-phase] [--json]
                                            Re-derive AC1/AC2/AC3 evidence for a completed run
                                            from its persisted handoff records.
  osa drive --config <path> [--json]        Dispatch a target build's own phases sequentially, one
                                            runDispatch() call per phase, halting on the first
                                            ambiguous or incoherent filesystem read.
  osa mcp                                   Start a local, stdio-only Model Context Protocol server
                                            exposing osa_plan / osa_build / osa_status (the one-shot
                                            flow) and run/drive/doctor/evidence/code_search/memory.
  osa setup [--json]                        Register osa's own MCP server into your Claude Code
                                            configuration, at user scope.
  osa mcp-config                            Print the MCP server entry (JSON, plus the Claude Code
                                            command) to paste into any other MCP client.
`;

/**
 * The MCP server entry for clients `osa setup` does not configure (everything except Claude Code): the JSON block most clients accept under
 * `mcpServers`, and the equivalent Claude Code command. The path is this installation's own entry file, so it keeps working however npm laid it out.
 * Pure.
 */
export function renderMcpConfig(entryPath: string): string {
  const entry = { mcpServers: { osa: { command: "node", args: [entryPath, "mcp"] } } };
  const quoted = entryPath.includes(" ") ? `"${entryPath}"` : entryPath;
  return [
    "Add this to your MCP client's configuration (Cursor, VS Code, Windsurf, Claude Desktop and most others use an \"mcpServers\" block):",
    "",
    JSON.stringify(entry, null, 2),
    "",
    "For Claude Code, `osa setup` does this for you; the equivalent command is:",
    `  claude mcp add --scope user --transport stdio osa -- node ${quoted} mcp`,
    "",
    "Then ask your assistant to build something with OSA (it will show you a plan and ask before anything is built).",
    "",
  ].join("\n");
}

type Command =
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  | ({ readonly kind: "doctor" } & DoctorOptions)
  | ({ readonly kind: "run" } & RunCommandOptions)
  | ({ readonly kind: "evidence" } & EvidenceCommandOptions)
  | ({ readonly kind: "drive" } & DriveCommandOptions)
  | { readonly kind: "mcp" }
  | ({ readonly kind: "osa" } & OsaCommandOptions)
  | ({ readonly kind: "index" } & IndexCommandOptions)
  | ({ readonly kind: "search" } & SearchCommandOptions)
  | ({ readonly kind: "memory" } & MemoryCommandOptions)
  | { readonly kind: "features"; readonly repoDir: string; readonly json: boolean; readonly features: FeatureFlags }
  | ({ readonly kind: "cbm" } & CbmCommandOptions)
  | { readonly kind: "setup"; readonly json: boolean }
  | { readonly kind: "mcp-config" };

function parseDoctorArgs(rest: readonly string[]): Command {
  let json = false;
  let boundaryFlag = false;
  let providersFlag = false;
  let features: FeatureFlags = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const feature = parseFeatureFlag(rest, i);
    if (feature !== null) {
      features = mergeFlags(features, feature.patch);
      i = feature.last;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--boundary") {
      boundaryFlag = true;
    } else if (arg === "--providers") {
      providersFlag = true;
    } else {
      throw new UsageError(`Unknown flag for doctor: ${arg}`, { flag: arg });
    }
  }

  if (boundaryFlag && providersFlag) {
    throw new UsageError("doctor --boundary and --providers are mutually exclusive.", {
      flags: ["--boundary", "--providers"],
    });
  }

  const only: DoctorOptions["only"] = boundaryFlag ? "boundary" : providersFlag ? "providers" : "all";
  return { kind: "doctor", json, only, ...(Object.keys(features).length > 0 ? { features } : {}) };
}

/**
 * Parses `run`'s flags: `--config <path>` (consumes the next argv element; missing value or
 * missing flag entirely -> `UsageError`) and `--json`. Any other flag -> `UsageError` -- unknown
 * flags are never ignored, the same rule `PHASE_1_SPEC.md` §4.1 already established for `doctor`.
 */
function parseRunArgs(rest: readonly string[]): Command {
  let configPath: string | null = null;
  let json = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--config") {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new UsageError("run --config requires a path argument.", { flag: "--config" });
      }
      configPath = value;
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new UsageError(`Unknown flag for run: ${String(arg)}`, { flag: arg });
    }
  }

  if (configPath === null) {
    throw new UsageError("run requires --config <path>.", { flag: "--config" });
  }
  return { kind: "run", json, configPath };
}

/**
 * Parses `evidence`'s flags: `--repo-dir <path>` and `--run-id <uuid>` (each consumes the next argv
 * element; missing value or missing flag entirely -> `UsageError`), plus the boolean presence flags
 * `--final-phase` (absent means `false`, mirroring `RunConfig.is_final_phase`'s own default) and
 * `--json`. Any other flag -> `UsageError` -- unknown flags are never ignored, the same rule every
 * prior CLI surface in this project already enforces. Implements PHASE_5_SPEC.md §6.4.
 */
function parseEvidenceArgs(rest: readonly string[]): Command {
  let repoDir: string | null = null;
  let runId: string | null = null;
  let finalPhase = false;
  let json = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--repo-dir") {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new UsageError("evidence --repo-dir requires a path argument.", { flag: "--repo-dir" });
      }
      repoDir = value;
      i += 1;
    } else if (arg === "--run-id") {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new UsageError("evidence --run-id requires a uuid argument.", { flag: "--run-id" });
      }
      runId = value;
      i += 1;
    } else if (arg === "--final-phase") {
      finalPhase = true;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new UsageError(`Unknown flag for evidence: ${String(arg)}`, { flag: arg });
    }
  }

  if (repoDir === null) {
    throw new UsageError("evidence requires --repo-dir <path>.", { flag: "--repo-dir" });
  }
  if (runId === null) {
    throw new UsageError("evidence requires --run-id <uuid>.", { flag: "--run-id" });
  }
  return { kind: "evidence", repoDir, runId, finalPhase, json };
}

/**
 * Parses `drive`'s flags: `--config <path>` (consumes the next argv element; missing value or
 * missing flag entirely -> `UsageError`) and `--json`. Any other flag -> `UsageError` -- unknown
 * flags are never ignored, the same rule every existing CLI surface in this project already
 * enforces. Does not touch `parseRunArgs`/`parseDoctorArgs`/`parseEvidenceArgs` or their own
 * argument surfaces. Implements PHASE_6_SPEC.md §4.1.
 */
function parseDriveArgs(rest: readonly string[]): Command {
  let configPath: string | null = null;
  let json = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--config") {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new UsageError("drive --config requires a path argument.", { flag: "--config" });
      }
      configPath = value;
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new UsageError(`Unknown flag for drive: ${String(arg)}`, { flag: arg });
    }
  }

  if (configPath === null) {
    throw new UsageError("drive requires --config <path>.", { flag: "--config" });
  }
  return { kind: "drive", json, configPath };
}

/**
 * Parses `mcp`'s flags: none. Any element in `rest` is a `UsageError` -- mirrors every other
 * `parse*Args` function's own "unknown flags are never ignored" discipline (PHASE_1_SPEC.md §4.1);
 * `mcp` simply takes none (PHASE_8_SPEC.md §4.1, §9 non-goal 7).
 */
function parseMcpArgs(rest: readonly string[]): Command {
  if (rest.length > 0) {
    throw new UsageError(`Unknown flag for mcp: ${String(rest[0])}`, { flag: rest[0] });
  }
  return { kind: "mcp" };
}

/**
 * Parses `setup`'s flags: `--json` only. Any other argument -> `UsageError` -- unknown flags are
 * never ignored, the same rule every existing CLI surface in this project already enforces. There
 * is deliberately no `--scope`/`--only`/`--skip` flag (PHASE_9_SPEC.md §4.1, §9 non-goals 5).
 * Mirrors `parseDriveArgs`' own shape, minus the `--config` branch.
 */
function parseSetupArgs(rest: readonly string[]): Command {
  let json = false;

  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
    } else {
      throw new UsageError(`Unknown flag for setup: ${String(arg)}`, { flag: arg });
    }
  }

  return { kind: "setup", json };
}

/**
 * Parses the one-shot form `osa "<prompt>" [--file <path>]... [--repo-dir <path>] [--yes] [--json]`.
 * Every non-flag token is part of the prompt. A *single* whitespace-free token is not accepted as a prompt:
 * it is far more likely a mistyped command (`osa doctr`), and a mistyped command must stay a usage error.
 */
function parsePromptArgs(args: readonly string[], repoDirDefault: string): Command {
  const words: string[] = [];
  const files: string[] = [];
  let repoDir = repoDirDefault;
  let yes = false;
  let json = false;
  let build = true;
  let features: FeatureFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const feature = parseFeatureFlag(args, i);
    if (feature !== null) {
      features = mergeFlags(features, feature.patch);
      i = feature.last;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--spec-only") {
      build = false;
    } else if (arg === "--file" || arg === "--repo-dir") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new UsageError(`${arg} requires a path argument.`, { flag: arg });
      }
      if (arg === "--file") files.push(value);
      else repoDir = value;
      i += 1;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown flag: ${arg}`, { flag: arg });
    } else {
      words.push(arg);
    }
  }
  const prompt = words.join(" ").trim();
  if (prompt === "" || (words.length === 1 && !/\s/.test(prompt))) {
    throw new UsageError(`Unknown command: ${args.join(" ")}`, { argv: args });
  }
  return { kind: "osa", prompt, files, repoDir: resolve(repoDir), yes, json, build, ...(Object.keys(features).length > 0 ? { features } : {}) };
}

/** Parses `index [--repo-dir <path>] [--json]`. */
function parseIndexArgs(rest: readonly string[]): Command {
  let repoDir = process.cwd();
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") json = true;
    else if (arg === "--repo-dir") {
      const v = rest[i + 1];
      if (v === undefined) throw new UsageError("index --repo-dir requires a path argument.", { flag: "--repo-dir" });
      repoDir = v;
      i += 1;
    } else throw new UsageError(`Unknown flag for index: ${String(arg)}`, { flag: arg });
  }
  return { kind: "index", repoDir: resolve(repoDir), json };
}

/** Parses `memory [--repo-dir <path>] [--json]`. */
function parseMemoryArgs(rest: readonly string[]): Command {
  let repoDir = process.cwd();
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") json = true;
    else if (arg === "--repo-dir") {
      const v = rest[i + 1];
      if (v === undefined) throw new UsageError("memory --repo-dir requires a path argument.", { flag: "--repo-dir" });
      repoDir = v;
      i += 1;
    } else throw new UsageError(`Unknown flag for memory: ${String(arg)}`, { flag: arg });
  }
  return { kind: "memory", repoDir: resolve(repoDir), json };
}

/** Parses `search "<query>" [-k <n>] [--repo-dir <path>] [--no-refresh] [--json]`. */
function parseSearchArgs(rest: readonly string[]): Command {
  let repoDir = process.cwd();
  let json = false;
  let refresh = true;
  let k = 8;
  let features: FeatureFlags = {};
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const feature = parseFeatureFlag(rest, i);
    if (feature !== null) {
      features = mergeFlags(features, feature.patch);
      i = feature.last;
    } else if (arg === "--json") json = true;
    else if (arg === "--no-refresh") refresh = false;
    else if (arg === "--repo-dir" || arg === "-k") {
      const v = rest[i + 1];
      if (v === undefined) throw new UsageError(`search ${arg} requires a value.`, { flag: arg });
      if (arg === "-k") {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 50) throw new UsageError("search -k must be an integer from 1 to 50.", { flag: arg });
        k = n;
      } else repoDir = v;
      i += 1;
    } else if (arg.startsWith("-")) throw new UsageError(`Unknown flag for search: ${arg}`, { flag: arg });
    else words.push(arg);
  }
  const query = words.join(" ").trim();
  if (query === "") throw new UsageError('search requires a query: osa search "where is the session token verified"', { argv: rest });
  return { kind: "search", repoDir: resolve(repoDir), query, k, json, refresh, ...(Object.keys(features).length > 0 ? { features } : {}) };
}

/** Parses `cbm install [--dir <path>] [--force] [--write-config] [--repo-dir <path>] [--json]` and `cbm status [--repo-dir <path>] [--json]`. */
function parseCbmArgs(rest: readonly string[]): Command {
  const action = rest[0];
  if (action !== "install" && action !== "status") throw new UsageError("Usage: osa cbm install [--dir <path>] [--force] [--harden] [--write-config] [--repo-dir <path>] [--json]  |  osa cbm status [--repo-dir <path>] [--json]", { action: action ?? null });
  let repoDir = process.cwd();
  let dir: string | null = null;
  let force = false;
  let harden = false;
  let writeConfig = false;
  let json = false;
  for (let i = 1; i < rest.length; i++) {
    const arg = rest[i] as string;
    const value = (flag: string): string => {
      const v = rest[i + 1];
      if (v === undefined) throw new UsageError(`cbm ${flag} requires a path argument.`, { flag });
      i += 1;
      return v;
    };
    if (arg === "--json") json = true;
    else if (arg === "--repo-dir") repoDir = value(arg);
    else if (action === "install" && arg === "--dir") dir = value(arg);
    else if (action === "install" && arg === "--force") force = true;
    else if (action === "install" && arg === "--harden") harden = true;
    else if (action === "install" && arg === "--write-config") writeConfig = true;
    else throw new UsageError(`Unknown flag for cbm ${action}: ${arg}`, { flag: arg });
  }
  return action === "install" ? { kind: "cbm", action, dir, force, harden, writeConfig, repoDir: resolve(repoDir), json } : { kind: "cbm", action, repoDir: resolve(repoDir), json };
}

/** Parses `features [--repo-dir <path>] [--json]` plus the feature flags. */
function parseFeaturesArgs(rest: readonly string[]): Command {
  let repoDir = process.cwd();
  let json = false;
  let features: FeatureFlags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const feature = parseFeatureFlag(rest, i);
    if (feature !== null) {
      features = mergeFlags(features, feature.patch);
      i = feature.last;
    } else if (arg === "--json") json = true;
    else if (arg === "--repo-dir") {
      const v = rest[i + 1];
      if (v === undefined) throw new UsageError("features --repo-dir requires a path argument.", { flag: "--repo-dir" });
      repoDir = v;
      i += 1;
    } else throw new UsageError(`Unknown flag for features: ${arg}`, { flag: arg });
  }
  return { kind: "features", repoDir: resolve(repoDir), json, features };
}

/** Parses `argv` (the full `process.argv`-shaped array; `argv.slice(2)` is the user's own args). */
export function parseArgs(argv: readonly string[]): Command {
  const args = argv.slice(2);

  if (args.length === 0) {
    return { kind: "help" };
  }

  const first = args[0];
  if ((first === "--version" || first === "-v") && args.length === 1) {
    return { kind: "version" };
  }
  if ((first === "--help" || first === "-h") && args.length === 1) {
    return { kind: "help" };
  }
  if (first === "doctor") {
    return parseDoctorArgs(args.slice(1));
  }
  if (first === "run") {
    return parseRunArgs(args.slice(1));
  }
  if (first === "evidence") {
    return parseEvidenceArgs(args.slice(1));
  }
  if (first === "drive") {
    return parseDriveArgs(args.slice(1));
  }
  if (first === "mcp") {
    return parseMcpArgs(args.slice(1));
  }
  if (first === "setup") {
    return parseSetupArgs(args.slice(1));
  }
  if (first === "mcp-config") {
    if (args.length > 1) throw new UsageError(`Unknown flag for mcp-config: ${String(args[1])}`, { flag: args[1] ?? null });
    return { kind: "mcp-config" };
  }
  if (first === "index") {
    return parseIndexArgs(args.slice(1));
  }
  if (first === "search") {
    return parseSearchArgs(args.slice(1));
  }
  if (first === "memory") {
    return parseMemoryArgs(args.slice(1));
  }
  if (first === "features") {
    return parseFeaturesArgs(args.slice(1));
  }
  if (first === "cbm") {
    return parseCbmArgs(args.slice(1));
  }

  return parsePromptArgs(args, process.cwd());
}

/**
 * The operator-facing phrasing of one provider's credential state. The whole point of the
 * three-state {@link DoctorReport} `authState` is that these three strings give *different
 * instructions*: "not authenticated" means go sign in, whereas an indeterminate probe means the
 * check itself did not work and neither answer should be trusted. Rendering both as the same
 * "not authenticated" line -- as this command did before -- sends an operator chasing a sign-in
 * problem that does not exist while the real defect stays invisible.
 */
function renderAuthState(report: DoctorReport["providers"][number]): string {
  switch (report.authState) {
    case "authenticated":
      return "authenticated";
    case "unauthenticated":
      return "not authenticated";
    case "indeterminate":
      return "auth state UNKNOWN (credential probe was inconclusive -- NOT a confirmed sign-in failure)";
  }
}

/**
 * Renders a {@link DoctorReport} as the human-readable `doctor` output. Exported solely so the
 * three-way credential-state rendering can be asserted against literally-constructed reports (the
 * indeterminate state cannot be provoked from a real local probe on demand) -- the same "test the
 * pure interpretation with a constructed input" approach `src/verify/preflight.ts`'s `parse*`
 * functions already use.
 */
export function renderHumanReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`osa doctor -- ${report.ok ? "OK" : "PROBLEMS FOUND"} (generated ${report.generated_at})`);
  lines.push("");
  lines.push(
    `Node.js: ${report.toolchain.node.found ? (report.toolchain.node.version ?? "unknown") : "not found"} ` +
      `(${report.toolchain.node.inRange ? "in range" : "out of range"})`,
  );
  lines.push(
    `git:     ${report.toolchain.git.found ? (report.toolchain.git.version ?? "unknown") : "not found"} ` +
      `(${report.toolchain.git.inRange ? "in range" : "out of range"})`,
  );
  for (const p of report.providers) {
    lines.push(
      `${p.provider}: ${p.cliFound ? (p.version ?? "unknown") : "not found"} ` +
        `(${p.versionInRange ? "in range" : "out of range"}), ` +
        renderAuthState(p),
    );
  }
  lines.push(
    `boundary: ${String(report.boundary.filesScanned)} file(s) scanned, ` +
      `${String(report.boundary.violations.length)} violation(s)`,
  );
  lines.push(`lock: ${report.lock.acquirable ? "acquirable" : "not acquirable"} (${report.lock.detail})`);
  if (report.build !== undefined) lines.push(`build: ${report.build.status} (${report.build.detail})`);
  for (const f of report.features ?? []) lines.push(`feature: ${f.name}: ${f.enabled ? "ENABLED" : "disabled"} (${f.value}, set by ${f.source})`);
  for (const w of report.warnings ?? []) lines.push(`WARNING: ${w}`);
  if (report.problems.length > 0) {
    lines.push("");
    lines.push("Problems:");
    for (const problem of report.problems) {
      lines.push(`  - ${problem}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Renders a {@link RunReport} as the human-readable `run` output. Exported (mirroring
 * {@link renderHumanReport}'s own existing precedent) so the "Warnings:" block's rendering --
 * PHASE_7_SPEC.md §4.3, the human-output half of AC3 -- can be asserted directly against a
 * synthetic {@link RunReport}, without spawning a real provider turn to trigger it end-to-end.
 */
export function renderRunHumanReport(report: RunReport): string {
  const lines: string[] = [];
  lines.push(
    `osa run -- ${report.ok ? "OK" : "FAILED"} (phase ${String(report.phase)}, generated ${report.generated_at})`,
  );
  lines.push("");
  for (const t of report.turns) {
    const verdictSuffix = t.continuity_verdict !== null ? `, continuity ${t.continuity_verdict}` : "";
    const retriedSuffix = t.retried ? " (retried)" : "";
    lines.push(`turn ${String(t.turn_index)} [${t.archetype}/${t.provider}]: ${t.status}${verdictSuffix}${retriedSuffix}`);
  }
  if (report.halt !== null) {
    lines.push("");
    lines.push(`halt: ${report.halt.code} -- ${report.halt.message}`);
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  if (report.problems.length > 0) {
    lines.push("");
    lines.push("Problems:");
    for (const problem of report.problems) {
      lines.push(`  - ${problem}`);
    }
  }
  return lines.join("\n") + "\n";
}

function renderEvidenceHumanReport(report: EvidenceReport): string {
  const lines: string[] = [];
  lines.push(
    `osa evidence -- ${report.ok ? "OK" : "ACCEPTANCE INCOMPLETE"} (run ${report.run_id}, ` +
      `${String(report.turns_found)} turn(s) found, generated ${report.generated_at})`,
  );
  lines.push("");
  lines.push(`AC1 (continuity between turns): ${report.ac1.satisfied ? "satisfied" : "not satisfied"} -- ${report.ac1.detail}`);
  lines.push(`AC2 (clean, non-interactive completion): ${report.ac2.satisfied ? "satisfied" : "not satisfied"} -- ${report.ac2.detail}`);
  lines.push(`AC3 (artifact reference and production): ${report.ac3.satisfied ? "satisfied" : "not satisfied"} -- ${report.ac3.detail}`);
  if (report.problems.length > 0) {
    lines.push("");
    lines.push("Problems:");
    for (const problem of report.problems) {
      lines.push(`  - ${problem}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Renders a {@link DriveReport} as the human-readable `drive` output: one line per phase
 * (`phase N [state_id]: decision_kind -- reason`, each a single line) followed by the final
 * `ok`/`exit_code` summary line -- FM-D5's own "illegible output" guard (PHASE_6_SPEC.md §7, §4.3).
 */
function renderDriveHumanReport(report: DriveReport): string {
  const lines: string[] = [];
  lines.push(
    `osa drive -- ${report.ok ? "OK" : "FAILED"} (driver run ${report.driver_run_id}, generated ${report.generated_at})`,
  );
  lines.push("");
  for (const p of report.phases) {
    lines.push(`phase ${String(p.phase)} [${p.state_id}]: ${p.decision_kind} -- ${p.reason}`);
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  if (report.problems.length > 0) {
    lines.push("");
    lines.push("Problems:");
    for (const problem of report.problems) {
      lines.push(`  - ${problem}`);
    }
  }
  lines.push("");
  lines.push(`ok: ${String(report.ok)}, exit_code: ${String(report.exit_code)}, final_state: ${report.final_state_id}`);
  return lines.join("\n") + "\n";
}

/**
 * Writes `text` to `stream` and resolves only once the underlying write is actually flushed (Node's
 * write callback), never merely queued. Used so output is fully flushed before the process may end, and can never be truncated by a
 * forced exit.
 */
function writeFlushed(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve) => {
    stream.write(text, () => resolve());
  });
}

/**
 * Parses `argv`, dispatches the requested command, and returns the process exit code. Never calls
 * `process.exit`.
 */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    const command = parseArgs(argv);
    switch (command.kind) {
      case "version": {
        process.stdout.write(`${pkg.version}\n`);
        return ExitCode.OK;
      }
      case "help": {
        process.stdout.write(USAGE_TEXT);
        return ExitCode.OK;
      }
      case "doctor": {
        const { report, exitCode } = await runDoctor(process.cwd(), { json: command.json, only: command.only, ...(command.features !== undefined ? { features: command.features } : {}) });
        process.stdout.write(command.json ? JSON.stringify(report, null, 2) + "\n" : renderHumanReport(report));
        return exitCode;
      }
      case "run": {
        const { report, exitCode } = await runRunCommand({ configPath: command.configPath, json: command.json });
        await writeFlushed(process.stdout, command.json ? JSON.stringify(report, null, 2) + "\n" : renderRunHumanReport(report));
        return exitCode;
      }
      case "evidence": {
        const { report, exitCode } = await runEvidenceCommand({
          repoDir: command.repoDir,
          runId: command.runId,
          finalPhase: command.finalPhase,
          json: command.json,
        });
        process.stdout.write(command.json ? JSON.stringify(report, null, 2) + "\n" : renderEvidenceHumanReport(report));
        return exitCode;
      }
      case "drive": {
        const { report, exitCode } = await runDriveCommand({ configPath: command.configPath, json: command.json });
        await writeFlushed(process.stdout, command.json ? JSON.stringify(report, null, 2) + "\n" : renderDriveHumanReport(report));
        return exitCode;
      }
      case "mcp": {
        await runMcpServer();
        return ExitCode.OK;
      }
      case "index": {
        const r = await runIndexCommand(command);
        await writeFlushed(process.stdout, r.text);
        return r.exitCode;
      }
      case "features": {
        const loaded = await loadOsaConfig(command.repoDir);
        const states = describeFeatures(applyFeatureFlags(loaded.config, command.features), loaded.explicit, command.features);
        await writeFlushed(process.stdout, command.json ? JSON.stringify({ schema_version: 1, repo_dir: command.repoDir, config_file: loaded.source, features: states }, null, 2) + "\n" : renderFeatures(states));
        return ExitCode.OK;
      }
      case "cbm": {
        const r = await runCbmCommand(command);
        await writeFlushed(process.stdout, r.text);
        return r.exitCode;
      }
      case "memory": {
        const r = await runMemoryCommand(command);
        await writeFlushed(process.stdout, r.text);
        return r.exitCode;
      }
      case "search": {
        const r = await runSearchCommand(command);
        await writeFlushed(process.stdout, r.text);
        return r.exitCode;
      }
      case "osa": {
        const report = await runOsaCommand(command);
        await writeFlushed(process.stdout, command.json ? JSON.stringify(report, null, 2) + "\n" : renderOsaRunReport(report));
        return report.exit_code;
      }
      case "mcp-config": {
        process.stdout.write(renderMcpConfig(fileURLToPath(import.meta.url)));
        return ExitCode.OK;
      }
      case "setup": {
        const { report, exitCode } = await runSetupCommand({
          json: command.json,
          entryPath: fileURLToPath(import.meta.url),
        });
        process.stdout.write(command.json ? JSON.stringify(report, null, 2) + "\n" : renderSetupHumanReport(report));
        return exitCode;
      }
    }
    // Exhaustive per the Command union above; unreachable, but satisfies noImplicitReturns.
    throw new InternalError("Unreachable: unknown command kind.");
  } catch (err) {
    const exitCode = err instanceof OsaError ? err.exitCode : ExitCode.INTERNAL;
    const message =
      err instanceof OsaError
        ? `${err.message}\n`
        : `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`;
    await writeFlushed(process.stderr, message);
    return exitCode;
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}
