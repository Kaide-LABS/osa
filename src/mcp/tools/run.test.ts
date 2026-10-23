// Implements PHASE_8_SPEC.md §1.2, §8 criteria 1/3
//
// Pure-function cases for runReportToCallToolResult()/errorToCallToolResult(), plus an integration
// case (reusing run-loop.test.ts's own fake-adapter fixture pattern, not its exported symbols --
// nothing in that file is exported) asserting the `run` MCP tool's own CallToolResult.
// structuredContent deep-equals the equivalent `runRunCommand` file-based invocation's own
// RunReport for an identical RunConfig, minus run_id/generated_at, and that role pinning resolves
// identically through the MCP path (baby_prd AC1/AC3).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InternalError, TurnTimeoutError, UsageError } from "../../domain/errors.ts";
import type { FileRef, HandoffRecord } from "../../domain/relay.ts";
import { writeHandoffRecord } from "../../domain/relay.ts";
import type { ProviderId, RawInvocationResult, RunConfig, TurnOutcome, TurnRequest } from "../../domain/run.ts";
import type { AdapterRegistry, Invocation, PreflightReport, ProviderAdapter } from "../../ports/provider-adapter.ts";
import { runProcess } from "../../util/exec.ts";
import { handoffPath } from "../../util/paths.ts";
import { sha256File } from "../../util/hash.ts";
import type { PreflightSummary } from "../../verify/preflight.ts";
import type { RunDispatchDeps } from "../../dispatch/run-loop.ts";
import { runRunCommand, type RunReport } from "../../cli/run.ts";
import { errorToCallToolResult, registerRunTool, runReportToCallToolResult } from "./run.ts";

const GIT_TIMEOUT_MS = 120_000;
const RUN_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

// ---- Pure-function cases ------------------------------------------------------------------

function syntheticReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    schema_version: 1,
    generated_at: "2026-08-18T00:00:00.000Z",
    run_id: RUN_ID,
    phase: 1,
    ok: true,
    exit_code: 0,
    turns: [],
    halt: null,
    problems: [],
    warnings: [],
    ...overrides,
  };
}

test("runReportToCallToolResult: an ok report is a non-error result carrying the report verbatim as structuredContent", () => {
  const report = syntheticReport();
  const result = runReportToCallToolResult(report);
  assert.equal(result.isError, undefined);
  assert.deepStrictEqual(result.structuredContent, report);
  assert.deepStrictEqual(JSON.parse((result.content[0] as { text: string }).text), report);
});

test("runReportToCallToolResult: a blocked/halted report (ok:false) is still a non-error CallToolResult -- domain outcome, not tool failure", () => {
  const report = syntheticReport({ ok: false, exit_code: 11 });
  const result = runReportToCallToolResult(report);
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as RunReport).ok, false);
});

test("errorToCallToolResult: a OsaError surfaces its own message as isError:true", () => {
  const result = errorToCallToolResult(new UsageError("bad config"));
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /bad config/);
});

test("errorToCallToolResult: a thrown UsageError from a malformed config path never emits structuredContent", () => {
  const result = errorToCallToolResult(new InternalError("boom"));
  assert.equal(result.isError, true);
  assert.equal((result as CallToolResult).structuredContent, undefined);
});

// ---- Integration: MCP tool <-> CLI equivalence, and role-pin resolution -------------------

function fakeHealthyPreflight(): Promise<PreflightSummary> {
  return Promise.resolve({
    node: { found: true, version: "24.15.0", inRange: true },
    git: { found: true, version: "2.54.0", inRange: true },
    providers: [
      { provider: "claude-code", cliFound: true, version: "2.1.211", versionInRange: true, authenticated: true, authState: "authenticated", problems: [] },
      { provider: "codex-cli", cliFound: true, version: "0.128.0", versionInRange: true, authenticated: true, authState: "authenticated", problems: [] },
    ],
    ok: true,
    problems: [],
  });
}

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const result = await runProcess({ command: "git", args, cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

async function commitFile(dir: string, relPath: string, content: string, message: string): Promise<void> {
  await writeFile(`${dir}/${relPath}`, content, "utf8");
  await git(dir, ["add", relPath]);
  await git(dir, ["commit", "--quiet", "-m", message]);
}

async function freshRepoWithSpec(prefix: string): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/osa-mcp-run-${prefix}-`);
  await git(dir, ["init", "--quiet", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await commitFile(dir, "PHASE_1_SPEC.md", "spec content\n", "add spec");
  await commitFile(dir, "baby_prd.md", "baby prd content\n", "add baby_prd.md");
  await commitFile(dir, "context.md", "context content\n", "add context.md");
  await commitFile(dir, "foo.txt", "v0\n", "add foo.txt");
  return dir;
}

function baseConfig(dir: string, overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    run_id: RUN_ID,
    repo_dir: dir,
    executor_providers: ["claude-code", "codex-cli"],
    reviewer_provider: null,
    turn_timeout_ms: 1_800_000,
    phase: 1,
    spec_path: "PHASE_1_SPEC.md",
    baby_prd_path: "baby_prd.md",
    context_path: "context.md",
    is_final_phase: false,
    chat_log_gitignored: true,
    ...overrides,
  };
}

async function looprArtifactRefs(dir: string): Promise<{ babyPrd: FileRef; context: FileRef; spec: FileRef }> {
  return {
    babyPrd: { path: "baby_prd.md", sha256: await sha256File(`${dir}/baby_prd.md`) },
    context: { path: "context.md", sha256: await sha256File(`${dir}/context.md`) },
    spec: { path: "PHASE_1_SPEC.md", sha256: await sha256File(`${dir}/PHASE_1_SPEC.md`) },
  };
}

class RecordingFakeAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly seenRequests: TurnRequest[] = [];
  /** Shared across both adapter instances so a test can recover real dispatch order (archetype +
   * provider per turn), independent of any hardcoded turn-index assumption -- needed once
   * role_pins can reassign which provider fills which slot (§8 criterion 3). */
  private readonly sharedLog: TurnRequest[];
  constructor(id: ProviderId, sharedLog: TurnRequest[]) {
    this.id = id;
    this.sharedLog = sharedLog;
  }
  preflight(): Promise<PreflightReport> {
    return Promise.resolve({ provider: this.id, cliFound: true, version: "1.0.0", versionInRange: true, authenticated: true, authState: "authenticated", problems: [] });
  }
  resolveEffort(): string {
    return "low";
  }
  buildInvocation(req: TurnRequest): Invocation {
    this.seenRequests.push(req);
    this.sharedLog.push(req);
    return { command: "fake-cli", args: [], env: {}, cwd: req.repoDir, stdin: req.prompt };
  }
  interpretResult(raw: RawInvocationResult): TurnOutcome {
    if (raw.timedOut) {
      return { ok: false, record: null, failure: new TurnTimeoutError("fake-cli timed out") };
    }
    if (raw.exitCode !== 0) {
      return { ok: false, record: null, failure: new InternalError(raw.stderr || "fake-cli failed") };
    }
    return { ok: true, record: null, failure: null };
  }
}

function draft(overrides: {
  readonly role?: "executor" | "reviewer";
  readonly artifactsRead?: readonly FileRef[];
  readonly artifactsWritten?: readonly FileRef[];
}): HandoffRecord {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    phase: 1,
    turn_index: 0,
    role: overrides.role ?? "executor",
    provider: "claude-code",
    model_tier: "high-volume-low-effort",
    started_at: "2026-08-16T10:00:00Z",
    completed_at: "2026-08-16T10:05:00Z",
    repo: { branch: "placeholder", head_before: "0".repeat(40), head_after: "1".repeat(40), commits: ["1".repeat(40)] },
    spec_ref: { path: "PLACEHOLDER.md", sha256: "0".repeat(64) },
    artifacts_read: overrides.artifactsRead ? [...overrides.artifactsRead] : [],
    artifacts_written: overrides.artifactsWritten ? [...overrides.artifactsWritten] : [],
    status: "completed",
    work_done: "did work",
    next_steps: [],
    open_questions: [],
    halt: null,
  };
}

/** Builds a fresh repo + deps producing a clean, deterministic 3-turn run. */
function buildFixture(prefix: string, configOverrides: Partial<RunConfig> = {}): Promise<{ dir: string; config: RunConfig; deps: RunDispatchDeps }> {
  return (async () => {
    const dir = await freshRepoWithSpec(prefix);
    const invocationLog: TurnRequest[] = [];
    const claude = new RecordingFakeAdapter("claude-code", invocationLog);
    const codex = new RecordingFakeAdapter("codex-cli", invocationLog);
    const adapters: Partial<AdapterRegistry> = { "claude-code": claude, "codex-cli": codex };
    const artifacts = await looprArtifactRefs(dir);

    let call = 0;
    const runProcessFn: typeof runProcess = async () => {
      const step = call;
      call += 1;
      const req = invocationLog[step];
      if (req === undefined) {
        throw new Error(`fixture runProcessFn: no invocation logged for step ${String(step)}`);
      }
      if (step === 0) {
        await commitFile(dir, "foo.txt", "v1\n", "turn0");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 0, narrowArchetype(req.archetype), req.provider),
          draft({ role: narrowArchetype(req.archetype), artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec], artifactsWritten: [{ path: "foo.txt", sha256: "a".repeat(64) }] }),
        );
      } else if (step === 1) {
        await commitFile(dir, "bar.txt", "v1\n", "turn1");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 1, narrowArchetype(req.archetype), req.provider),
          draft({ role: narrowArchetype(req.archetype), artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "foo.txt", sha256: "a".repeat(64) }], artifactsWritten: [{ path: "bar.txt", sha256: "a".repeat(64) }] }),
        );
      } else {
        await commitFile(dir, "PHASE_2_SPEC.md", "phase 2 spec content\n", "turn2");
        const nextSpecSha256 = await sha256File(`${dir}/PHASE_2_SPEC.md`);
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 2, narrowArchetype(req.archetype), req.provider),
          draft({ role: narrowArchetype(req.archetype), artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "bar.txt", sha256: "a".repeat(64) }], artifactsWritten: [{ path: "PHASE_2_SPEC.md", sha256: nextSpecSha256 }] }),
        );
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    return { dir, config: baseConfig(dir, configOverrides), deps: { adapters, runProcessFn, preflightFn: fakeHealthyPreflight } };
  })();
}

/** V1 `planTurnSequence` only ever dispatches `executor`/`reviewer` turns (PRD §6.3) -- narrows the
 * five-member `Archetype` union down for this fixture's own `HandoffRecord`/`handoffPath` calls. */
function narrowArchetype(archetype: TurnRequest["archetype"]): "executor" | "reviewer" {
  if (archetype === "executor" || archetype === "reviewer") {
    return archetype;
  }
  throw new Error(`fixture: unexpected archetype "${archetype}" dispatched in a V1 run`);
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Captures the handler registerRunTool wires up, without a real transport/SDK validation pass. */
function captureRunHandler(deps?: RunDispatchDeps): (config: Record<string, unknown>) => Promise<CallToolResult> {
  let handler: ((config: Record<string, unknown>) => Promise<CallToolResult>) | null = null;
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, cb: (config: Record<string, unknown>) => Promise<CallToolResult>) => {
      handler = cb;
    },
  };
  registerRunTool(fakeServer as unknown as Parameters<typeof registerRunTool>[0], deps);
  if (handler === null) {
    throw new Error("registerRunTool never called server.registerTool");
  }
  return handler;
}

test("run MCP tool <-> CLI `run --config <path> --json` equivalence (baby_prd AC1)", async () => {
  const mcpFixture = await buildFixture("mcp");
  const cliFixture = await buildFixture("cli");
  try {
    const handler = captureRunHandler(mcpFixture.deps);
    const mcpResult = await handler(mcpFixture.config as unknown as Record<string, unknown>);
    assert.equal(mcpResult.isError, undefined);
    const mcpReport = mcpResult.structuredContent as RunReport;

    const cliConfigPath = `${cliFixture.dir}/run-config.json`;
    await writeFile(cliConfigPath, JSON.stringify(cliFixture.config, null, 2), "utf8");
    const { report: cliReport } = await runRunCommand({ configPath: cliConfigPath, json: true }, cliFixture.deps);

    const strip = (r: RunReport): Omit<RunReport, "run_id" | "generated_at"> => {
      const { run_id: _run_id, generated_at: _generated_at, ...rest } = r;
      return rest;
    };
    assert.deepStrictEqual(strip(mcpReport), strip(cliReport));
    assert.equal(mcpReport.ok, true);
    assert.equal(mcpReport.exit_code, 0);
  } finally {
    await cleanup(mcpFixture.dir);
    await cleanup(cliFixture.dir);
  }
});

test("run MCP tool: role pinning resolves identically to the CLI (baby_prd AC3)", async () => {
  const fixture = await buildFixture("rolepin", { role_pins: { "codex-cli": "reviewer" } });
  try {
    const handler = captureRunHandler(fixture.deps);
    const result = await handler(fixture.config as unknown as Record<string, unknown>);
    assert.equal(result.isError, undefined);
    const report = result.structuredContent as RunReport;
    assert.deepStrictEqual(
      report.turns.map((t) => [t.archetype, t.provider]),
      [
        ["executor", "claude-code"],
        ["executor", "claude-code"],
        ["reviewer", "codex-cli"],
      ],
    );
  } finally {
    await cleanup(fixture.dir);
  }
});

test("run MCP tool: a thrown UsageError (malformed downstream state) becomes isError:true and never leaks a temp file (§7 FM-M5)", async () => {
  const handler = captureRunHandler(undefined);
  const result = await handler({ this_is_not_a_valid: "config" });
  assert.equal(result.isError, true);
});



