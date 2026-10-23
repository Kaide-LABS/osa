// Implements PHASE_1_SPEC.md §6.10, §4.2
//
// The `doctor` command: composes preflight + boundary + a lock smoke test into one report.
// `runDoctor` only ever *returns* an exit code; it never calls `process.exit` -- only `main.ts` does.

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ExitCode, LockHeldError } from "../domain/errors.ts";
import { IsoUtc } from "../domain/relay.ts";
import { AuthProbeStateSchema, ProviderIdSchema } from "../domain/run.ts";
import type { PreflightReport } from "../ports/provider-adapter.ts";
import type { BoundaryViolation } from "../verify/boundary.ts";
import { listScannedSourceFiles, scanBoundary } from "../verify/boundary.ts";
import type { BuildFreshness } from "../verify/build-stamp.ts";
import { checkBuildFreshness } from "../verify/build-stamp.ts";
import type { ToolCheck } from "../verify/preflight.ts";
import { MIN_HEALTHY_PROVIDERS, runPreflight } from "../verify/preflight.ts";
import { acquireRunLock, releaseRunLock } from "../util/lock.ts";
import { loadOsaConfig } from "../util/config-file.ts";
import { applyFeatureFlags, describeFeatures } from "../features/features.ts";
import type { FeatureFlags } from "../features/features.ts";

const ToolCheckSchema = z.strictObject({
  found: z.boolean(),
  version: z.string().nullable(),
  inRange: z.boolean(),
});

const PreflightReportSchema = z.strictObject({
  provider: ProviderIdSchema,
  cliFound: z.boolean(),
  version: z.string().nullable(),
  versionInRange: z.boolean(),
  // `authenticated` keeps its shipped meaning exactly: `true` iff definitively authenticated. Every
  // consumer already written against it is unaffected. `authState` is purely additive -- it splits
  // the `false` case into the two claims that were previously indistinguishable ("the CLI says you
  // are signed out" vs. "the probe never got an answer"), which is a new field on an existing
  // report, not a new report shape. Hence no `schema_version` bump.
  authenticated: z.boolean(),
  authState: AuthProbeStateSchema,
  problems: z.array(z.string()),
});

const FeatureStateSchema = z.strictObject({
  id: z.enum(["index.engine", "trim.enabled", "intake.quoteStatedRules"]),
  name: z.string(),
  value: z.string(),
  enabled: z.boolean(),
  source: z.enum(["flag", "config", "default"]),
  setting: z.string(),
  flags: z.string(),
  note: z.string(),
});

const BoundaryViolationSchema = z.strictObject({
  rule: z.enum(["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12"]),
  file: z.string(),
  line: z.number().int(),
  excerpt: z.string(),
});

/** The `doctor --json` output shape (PHASE_1_SPEC.md §4.2). */
export const DoctorReport = z.strictObject({
  schema_version: z.literal(1),
  generated_at: IsoUtc,
  ok: z.boolean(),
  exit_code: z.number().int(),
  toolchain: z.strictObject({ node: ToolCheckSchema, git: ToolCheckSchema }),
  providers: z.array(PreflightReportSchema),
  boundary: z.strictObject({
    filesScanned: z.number().int(),
    violations: z.array(BoundaryViolationSchema),
  }),
  lock: z.strictObject({ acquirable: z.boolean(), detail: z.string() }),
  /** Is the compiled `dist/` (which the MCP server runs) in step with `src/`? Absent for `--providers`. Additive. */
  build: z
    .strictObject({
      status: z.enum(["fresh", "stale", "missing", "process-stale", "not-applicable"]),
      detail: z.string(),
      source_hash: z.string().nullable(),
      dist_hash: z.string().nullable(),
    })
    .optional(),
  /** The optional plug-ins (CBM, trim-1, quoted stated rules): state and where each was set. A disabled feature is never probed. Additive. */
  features: z.array(FeatureStateSchema).optional(),
  /** Non-fatal findings (a stale build). They never change `ok` or the exit code. Additive. */
  warnings: z.array(z.string()).optional(),
  problems: z.array(z.string()),
});

/** The inferred type of {@link DoctorReport}. */
export type DoctorReport = z.infer<typeof DoctorReport>;

/** `doctor` command options, derived from CLI flags (`src/cli/main.ts`). */
export interface DoctorOptions {
  readonly json: boolean;
  readonly only: "all" | "boundary" | "providers";
  /** Per-command overrides of the optional plug-ins (`--index-engine`, `--trim` / `--no-trim`, `--quote-stated-rules`). */
  readonly features?: FeatureFlags;
}

/**
 * The state of the optional plug-ins for the project in `repoRoot`. A DISABLED feature is only reported -- its binary is never looked for, so a missing
 * CBM or trim-1 binary neither fails nor warns. An ENABLED feature whose configured binary is missing is a (non-fatal) warning. Never throws: an
 * unreadable config becomes a warning.
 */
export async function featureReport(repoRoot: string, flags: FeatureFlags): Promise<{ readonly features: z.infer<typeof FeatureStateSchema>[]; readonly warnings: string[] } | { readonly features: null; readonly warnings: string[] }> {
  try {
    const loaded = await loadOsaConfig(repoRoot);
    const config = applyFeatureFlags(loaded.config, flags);
    const warnings: string[] = [];
    if (config.index.engine === "cbm" && (config.index.cbm.binaryPath === "" || !existsSync(config.index.cbm.binaryPath))) {
      warnings.push(`index.engine is "cbm" but the codebase-memory-mcp binary is not at index.cbm.binaryPath (${config.index.cbm.binaryPath === "" ? "not set" : config.index.cbm.binaryPath}); searches fall back to the lexical index`);
    }
    if (config.trim.enabled && config.trim.engine === "trim1" && config.trim.binaryPath !== "" && !existsSync(config.trim.binaryPath)) {
      warnings.push(`trim.enabled is true but the trim-1 binary is not at trim.binaryPath (${config.trim.binaryPath}); handoffs use the no-op trimmer`);
    }
    return { features: describeFeatures(config, loaded.explicit, flags), warnings };
  } catch (err) {
    return { features: null, warnings: [`The feature switches could not be read from the project config: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/**
 * Any credential-looking substring is redacted, and the result capped at 200 characters, before a
 * boundary-violation excerpt is placed in a report an operator might paste into a public issue.
 */
const CREDENTIAL_LOOKING_PATTERN = /(sk-|ghp_|xoxb-)[A-Za-z0-9_-]+/g;

function redactExcerpt(excerpt: string): string {
  const redacted = excerpt.replace(CREDENTIAL_LOOKING_PATTERN, "***REDACTED***");
  return redacted.length > 200 ? redacted.slice(0, 200) : redacted;
}

/**
 * Acquires and releases the run lock against a throwaway temp directory (never the real repo, so
 * this can never contend with a genuinely active run). A {@link LockHeldError} here is reported in
 * the result, not thrown.
 */
async function lockSmokeTest(): Promise<{ acquirable: boolean; detail: string }> {
  let tempDir: string;
  try {
    tempDir = await mkdtemp(`${tmpdir()}/osa-doctor-`);
  } catch (err) {
    return {
      acquirable: false,
      detail: `failed to create smoke-test directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    const runId = randomUUID();
    try {
      await acquireRunLock(tempDir, runId);
      await releaseRunLock(tempDir, runId);
      return { acquirable: true, detail: "lock acquire/release smoke test passed" };
    } catch (err) {
      if (err instanceof LockHeldError) {
        return { acquirable: false, detail: err.message };
      }
      return { acquirable: false, detail: err instanceof Error ? err.message : String(err) };
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
}

function computeExitCode(input: {
  readonly boundaryViolations: readonly BoundaryViolation[];
  readonly providers: readonly PreflightReport[];
  readonly toolchainNode: ToolCheck;
  readonly toolchainGit: ToolCheck;
  readonly lockAcquirable: boolean;
  readonly mode: DoctorOptions["only"];
}): number {
  const candidates: number[] = [];

  const hasNonB7Violation = input.boundaryViolations.some((v) => v.rule !== "B7");
  const hasB7Violation = input.boundaryViolations.some((v) => v.rule === "B7");
  if (hasNonB7Violation) {
    // The harder failure wins when both a B7 and another B-rule fire in the same scan.
    candidates.push(ExitCode.BOUNDARY_VIOLATION);
  } else if (hasB7Violation) {
    candidates.push(ExitCode.TIER_WELDING);
  }

  if (input.mode !== "boundary") {
    const preflightFailed =
      !input.toolchainNode.inRange || !input.toolchainGit.inRange || input.providers.filter((p) => p.problems.length === 0).length < MIN_HEALTHY_PROVIDERS;
    if (preflightFailed) {
      candidates.push(ExitCode.PREFLIGHT_FAILED);
    }
  }

  if (input.mode === "all" && !input.lockAcquirable) {
    candidates.push(ExitCode.LOCK_HELD);
  }

  return candidates.length === 0 ? ExitCode.OK : Math.min(...candidates);
}

/**
 * Runs the checks selected by `opts.only` and assembles a {@link DoctorReport}. `only: "all"` runs
 * every check (toolchain + every known provider's preflight, the boundary scan, and the lock smoke test);
 * `only: "boundary"` runs the boundary scan alone (no provider probes, fast); `only: "providers"`
 * runs preflight alone (which already bundles the toolchain checks). Sections that were not run
 * for a given mode are reported with neutral placeholders that never contribute to `problems` or
 * the exit code.
 */
export async function runDoctor(
  repoRoot: string,
  opts: DoctorOptions,
  deps: { readonly buildCheck?: () => BuildFreshness } = {},
): Promise<{ report: DoctorReport; exitCode: number }> {
  const generatedAt = new Date().toISOString();
  const problems: string[] = [];

  const runBoundary = opts.only === "all" || opts.only === "boundary";
  const runProviders = opts.only === "all" || opts.only === "providers";
  const runLockSmokeTest = opts.only === "all";

  let toolchainNode: ToolCheck = { found: true, version: null, inRange: true };
  let toolchainGit: ToolCheck = { found: true, version: null, inRange: true };
  let providerReports: readonly PreflightReport[] = [];
  let providerWarnings: readonly string[] = [];

  if (runProviders) {
    const summary = await runPreflight(repoRoot);
    toolchainNode = summary.node;
    toolchainGit = summary.git;
    providerReports = summary.providers;
    problems.push(...summary.problems);
    providerWarnings = summary.warnings ?? [];
  }

  let boundaryFilesScanned = 0;
  let boundaryViolations: readonly BoundaryViolation[] = [];
  if (runBoundary) {
    boundaryFilesScanned = (await listScannedSourceFiles(repoRoot)).length;
    const rawViolations = await scanBoundary(repoRoot);
    boundaryViolations = rawViolations.map((v) => ({ ...v, excerpt: redactExcerpt(v.excerpt) }));
    for (const v of boundaryViolations) {
      problems.push(`Boundary rule ${v.rule} violated in ${v.file}:${String(v.line)}: ${v.excerpt}`);
    }
  }

  const warnings: string[] = [];
  let build: BuildFreshness | undefined;
  if (runBoundary) {
    build = (deps.buildCheck ?? checkBuildFreshness)();
    if (build.status !== "fresh" && build.status !== "not-applicable") warnings.push(`Build is ${build.status}: ${build.detail}`);
  }

  warnings.push(...providerWarnings);
  const featureInfo = await featureReport(repoRoot, opts.features ?? {});
  warnings.push(...featureInfo.warnings);

  let lockAcquirable = true;
  let lockDetail = "not checked";
  if (runLockSmokeTest) {
    const smoke = await lockSmokeTest();
    lockAcquirable = smoke.acquirable;
    lockDetail = smoke.detail;
    if (!smoke.acquirable) {
      problems.push(`Run lock is not acquirable: ${smoke.detail}`);
    }
  }

  const exitCode = computeExitCode({
    boundaryViolations,
    providers: providerReports,
    toolchainNode,
    toolchainGit,
    lockAcquirable,
    mode: opts.only,
  });

  const report: DoctorReport = {
    schema_version: 1,
    generated_at: generatedAt,
    ok: problems.length === 0,
    exit_code: exitCode,
    toolchain: { node: toolchainNode, git: toolchainGit },
    providers: providerReports.map((p) => ({ ...p, problems: [...p.problems] })),
    boundary: { filesScanned: boundaryFilesScanned, violations: [...boundaryViolations] },
    lock: { acquirable: lockAcquirable, detail: lockDetail },
    ...(build !== undefined ? { build } : {}),
    ...(featureInfo.features !== null ? { features: featureInfo.features } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    problems,
  };

  return { report, exitCode };
}
