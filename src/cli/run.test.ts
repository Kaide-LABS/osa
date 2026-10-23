// Implements PHASE_3_SPEC.md §1.2 -- run.test.ts
// CLI-level config-file validation errors, --json output shape, exit-code passthrough from
// runDispatch(). Covers §8 acceptance criteria #27, #28, #29, #31.
//
// The "dispatches a valid config" test below drives `runRunCommand` through an injected fake
// `deps: RunDispatchDeps` (threaded straight through to `runDispatch`, mirroring
// `run-loop.test.ts`'s own `fakeHealthyPreflight`/`RecordingFakeAdapter`/scripted `runProcessFn`
// pattern for `runDispatch`'s own tests) instead of real production deps, so its pass/fail no
// longer depends on this machine's Codex-CLI auth state and it never spawns a real `claude`/`codex`
// process. The CLI-level `--json emits...` subprocess test can't accept an injected `deps` object
// (it spawns a real `node src/cli/main.ts ...` process, and `main.ts`'s own call site intentionally
// never threads a `deps` override -- that is the point of the seam: production behaviour is
// untouched); instead it uses a `spec_path` that can never resolve to a readable file, which fails
// `runDispatch`'s own extended-preflight spec-readability check unconditionally, before the run
// lock or turn loop is ever reached -- deterministically true regardless of provider auth state.
// (`runPreflight()`'s own `<cli> --version`/`auth status` probes still run either way, same as the
// already-established `main.test.ts` "doctor" tests against this same real environment; the actual
// hazard this guards against -- and the only thing §8 acceptance criterion #30/PHASE_2_SPEC.md §9
// "never spawns a real turn" actually forbids -- is proceeding past preflight into the turn loop's
// real generation dispatch.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { UsageError } from "../domain/errors.ts";
import type { RunDispatchDeps } from "../dispatch/run-loop.ts";
import type { FileRef, HandoffRecord } from "../domain/relay.ts";
import { writeHandoffRecord } from "../domain/relay.ts";
import type { AdapterRegistry, Invocation, PreflightReport, ProviderAdapter } from "../ports/provider-adapter.ts";
import type { PreflightSummary } from "../verify/preflight.ts";
import { handoffPath } from "../util/paths.ts";
import { sha256File } from "../util/hash.ts";
import { runProcess } from "../util/exec.ts";
import type { ProviderId, TurnOutcome, TurnRequest } from "../domain/run.ts";
import { RunConfig } from "../domain/run.ts";
import { runRunCommand, RunReport } from "./run.ts";

const MAIN_TS_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));
const RUN_TIMEOUT_MS = 120_000;
const RUN_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

async function runMain(args: readonly string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await runProcess({
    command: process.execPath,
    args: [MAIN_TS_PATH, ...args],
    cwd: process.cwd(),
    timeoutMs: RUN_TIMEOUT_MS,
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const result = await runProcess({ command: "git", args, cwd: repoDir, timeoutMs: RUN_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${String(result.exitCode)}): ${result.stderr}`);
  }
  return result.stdout;
}

async function freshRepoWithSpec(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/osa-run-cli-test-`);
  await git(dir, ["init", "--quiet", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await writeFile(`${dir}/PHASE_1_SPEC.md`, "spec content\n", "utf8");
  await writeFile(`${dir}/baby_prd.md`, "baby prd content\n", "utf8");
  await writeFile(`${dir}/context.md`, "context content\n", "utf8");
  await git(dir, ["add", "PHASE_1_SPEC.md", "baby_prd.md", "context.md"]);
  await git(dir, ["commit", "--quiet", "-m", "add spec"]);
  return dir;
}

function validConfigJson(dir: string): string {
  const config: RunConfig = {
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
  };
  return JSON.stringify(config);
}

/**
 * A schema-valid `RunConfig` whose `spec_path` can never resolve to a readable file in `dir`.
 * `runDispatch`'s own extended preflight (§6.5 step 1, `run-loop.ts`'s `runExtendedPreflight`)
 * checks `spec_path` readability unconditionally and ANDs it into overall preflight `ok` regardless
 * of `runPreflight()`'s own toolchain/provider-auth result -- so a dispatch against this config
 * deterministically fails preflight (`exitCode` `PREFLIGHT_FAILED`) and never reaches the run lock or
 * turn loop, on any machine, in any provider-auth state. `baby_prd_path`/`context_path` are still
 * given real, readable values so the resulting `problems` list is unambiguously about `spec_path`.
 */
function configJsonWithUnreadableSpecPath(dir: string): string {
  const config: RunConfig = {
    run_id: RUN_ID,
    repo_dir: dir,
    executor_providers: ["claude-code", "codex-cli"],
    reviewer_provider: null,
    turn_timeout_ms: 1_800_000,
    phase: 1,
    spec_path: "MISSING_SPEC_DOES_NOT_EXIST.md",
    baby_prd_path: "baby_prd.md",
    context_path: "context.md",
    is_final_phase: false,
    chat_log_gitignored: true,
  };
  return JSON.stringify(config);
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * `FileRef`s for `freshRepoWithSpec()`'s own `baby_prd.md`/`context.md`/`PHASE_1_SPEC.md`, computed
 * from the real files on disk -- required in every turn's `artifacts_read` since Phase 4's
 * `assertLooprArtifactsReferenced()` now runs unconditionally (PHASE_4_SPEC.md §6.3).
 */
async function looprArtifactRefs(dir: string): Promise<{ babyPrd: FileRef; context: FileRef; spec: FileRef }> {
  return {
    babyPrd: { path: "baby_prd.md", sha256: await sha256File(`${dir}/baby_prd.md`) },
    context: { path: "context.md", sha256: await sha256File(`${dir}/context.md`) },
    spec: { path: "PHASE_1_SPEC.md", sha256: await sha256File(`${dir}/PHASE_1_SPEC.md`) },
  };
}

async function commitFile(dir: string, relPath: string, content: string, message: string): Promise<void> {
  await writeFile(`${dir}/${relPath}`, content, "utf8");
  await git(dir, ["add", relPath]);
  await git(dir, ["commit", "--quiet", "-m", message]);
}

/**
 * A synthetic, always-healthy `PreflightSummary`, injected via `RunDispatchDeps.preflightFn`
 * exactly as `run-loop.test.ts`'s own `fakeHealthyPreflight` does for `runDispatch`'s own tests
 * (see that file's doc comment on the real `runPreflight()` shelling out to the actual
 * `claude`/`codex` binaries with no injection seam of its own).
 */
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

/** `run-loop.test.ts`'s own `RecordingFakeAdapter`, mirrored here for the same purpose: a fake `ProviderAdapter` standing in for a real provider CLI, never spawning one. */
class RecordingFakeAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  constructor(id: ProviderId) {
    this.id = id;
  }
  preflight(): Promise<PreflightReport> {
    return Promise.resolve({ provider: this.id, cliFound: true, version: "1.0.0", versionInRange: true, authenticated: true, authState: "authenticated", problems: [] });
  }
  resolveEffort(): string {
    return "low";
  }
  buildInvocation(req: TurnRequest): Invocation {
    return { command: "fake-cli", args: [], env: {}, cwd: req.repoDir, stdin: req.prompt };
  }
  interpretResult(): TurnOutcome {
    return { ok: true, record: null, failure: null };
  }
}

/** A schema-valid draft `HandoffRecord` (mirrors `run-loop.test.ts`'s own `draft` helper). */
function draft(overrides: {
  readonly role?: "executor" | "reviewer";
  readonly artifactsRead?: readonly FileRef[];
  readonly artifactsWritten?: readonly FileRef[];
} = {}): HandoffRecord {
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

test("runRunCommand throws UsageError (not RelaySchemaError) when the config file cannot be read", async () => {
  await assert.rejects(
    () => runRunCommand({ configPath: "/definitely/does/not/exist.json", json: false }),
    (err: unknown) => {
      assert.ok(err instanceof UsageError);
      assert.equal(err.exitCode, 2);
      return true;
    },
  );
});

test("runRunCommand throws UsageError when the config file is not valid JSON", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-run-cli-test-`);
  try {
    const configPath = `${dir}/config.json`;
    await writeFile(configPath, "not valid json{{{", "utf8");
    await assert.rejects(
      () => runRunCommand({ configPath, json: false }),
      (err: unknown) => {
        assert.ok(err instanceof UsageError);
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await cleanup(dir);
  }
});

test("runRunCommand throws UsageError (exit 2, not RELAY_SCHEMA_INVALID's exit 4) when the config fails RunConfig validation", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-run-cli-test-`);
  try {
    const configPath = `${dir}/config.json`;
    await writeFile(configPath, JSON.stringify({ run_id: "not-a-uuid" }), "utf8");
    await assert.rejects(
      () => runRunCommand({ configPath, json: false }),
      (err: unknown) => {
        assert.ok(err instanceof UsageError);
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await cleanup(dir);
  }
});

test("RunConfig rejects phase: 0 and phase: -1", () => {
  const base = {
    run_id: RUN_ID,
    repo_dir: "/tmp/repo",
    executor_providers: ["claude-code", "codex-cli"],
    spec_path: "PHASE_1_SPEC.md",
    baby_prd_path: "baby_prd.md",
    context_path: "context.md",
  };
  assert.equal(RunConfig.safeParse({ ...base, phase: 0 }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, phase: -1 }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, phase: 1 }).success, true);
});

test("RunConfig rejects an absolute spec_path and a spec_path containing a .. segment", () => {
  const base = {
    run_id: RUN_ID,
    repo_dir: "/tmp/repo",
    executor_providers: ["claude-code", "codex-cli"],
    phase: 1,
    baby_prd_path: "baby_prd.md",
    context_path: "context.md",
  };
  assert.equal(RunConfig.safeParse({ ...base, spec_path: "/etc/passwd" }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, spec_path: "C:/etc/passwd" }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, spec_path: "../outside.md" }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, spec_path: "PHASE_1_SPEC.md" }).success, true);
});

test("RunConfig rejects an absolute baby_prd_path and a baby_prd_path containing a .. segment", () => {
  const base = {
    run_id: RUN_ID,
    repo_dir: "/tmp/repo",
    executor_providers: ["claude-code", "codex-cli"],
    phase: 1,
    spec_path: "PHASE_1_SPEC.md",
    context_path: "context.md",
  };
  assert.equal(RunConfig.safeParse({ ...base, baby_prd_path: "/etc/passwd" }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, baby_prd_path: "C:/etc/passwd" }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, baby_prd_path: "../outside.md" }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, baby_prd_path: "baby_prd.md" }).success, true);
});

test("RunConfig rejects an absolute context_path and a context_path containing a .. segment", () => {
  const base = {
    run_id: RUN_ID,
    repo_dir: "/tmp/repo",
    executor_providers: ["claude-code", "codex-cli"],
    phase: 1,
    spec_path: "PHASE_1_SPEC.md",
    baby_prd_path: "baby_prd.md",
  };
  assert.equal(RunConfig.safeParse({ ...base, context_path: "/etc/passwd" }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, context_path: "C:/etc/passwd" }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, context_path: "../outside.md" }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, context_path: "context.md" }).success, true);
});

test("RunConfig.executor_prompt_path/reviewer_prompt_path are optional, path-safe, and independent of each other", () => {
  const base = {
    run_id: RUN_ID,
    repo_dir: "/tmp/repo",
    executor_providers: ["claude-code", "codex-cli"],
    phase: 1,
    spec_path: "PHASE_1_SPEC.md",
    baby_prd_path: "baby_prd.md",
    context_path: "context.md",
  };

  // Both entirely absent -- every run before this pair of fields existed keeps parsing.
  const omitted = RunConfig.safeParse(base);
  assert.equal(omitted.success, true);
  assert.equal(omitted.success ? omitted.data.executor_prompt_path : undefined, undefined);
  assert.equal(omitted.success ? omitted.data.reviewer_prompt_path : undefined, undefined);

  // Either may be supplied without the other -- they are independent, not a linked pair.
  const executorOnly = RunConfig.safeParse({ ...base, executor_prompt_path: ".claude/agents/loopr-step11.md" });
  assert.equal(executorOnly.success, true);
  assert.equal(executorOnly.success ? executorOnly.data.executor_prompt_path : undefined, ".claude/agents/loopr-step11.md");
  assert.equal(executorOnly.success ? executorOnly.data.reviewer_prompt_path : undefined, undefined);

  const reviewerOnly = RunConfig.safeParse({ ...base, reviewer_prompt_path: ".claude/agents/loopr-step12.md" });
  assert.equal(reviewerOnly.success, true);
  assert.equal(reviewerOnly.success ? reviewerOnly.data.reviewer_prompt_path : undefined, ".claude/agents/loopr-step12.md");

  // Same repo-relative-path-safety rule as spec_path/baby_prd_path/context_path -- one shared
  // schema value (RepoRelPathLike), so no separate traversal/absolute-path check is needed per
  // field, but each is verified here to confirm it is actually wired to that shared schema.
  assert.equal(RunConfig.safeParse({ ...base, executor_prompt_path: "/etc/passwd" }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, executor_prompt_path: "../outside.md" }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, reviewer_prompt_path: "/etc/passwd" }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, reviewer_prompt_path: "../outside.md" }).success, false);
});

test("RunConfig.is_final_phase defaults to false when omitted, and accepts an explicit true", () => {
  const base = {
    run_id: RUN_ID,
    repo_dir: "/tmp/repo",
    executor_providers: ["claude-code", "codex-cli"],
    phase: 1,
    spec_path: "PHASE_1_SPEC.md",
    baby_prd_path: "baby_prd.md",
    context_path: "context.md",
  };
  const omitted = RunConfig.safeParse(base);
  assert.equal(omitted.success, true);
  assert.equal(omitted.success ? omitted.data.is_final_phase : undefined, false);

  const explicitTrue = RunConfig.safeParse({ ...base, is_final_phase: true });
  assert.equal(explicitTrue.success, true);
  assert.equal(explicitTrue.success ? explicitTrue.data.is_final_phase : undefined, true);
});

test("RunConfig.model_overrides accepts a sparse record (one provider key set, the other omitted)", () => {
  const base = {
    run_id: RUN_ID,
    repo_dir: "/tmp/repo",
    executor_providers: ["claude-code", "codex-cli"],
    phase: 1,
    spec_path: "PHASE_1_SPEC.md",
    baby_prd_path: "baby_prd.md",
    context_path: "context.md",
  };
  const omitted = RunConfig.safeParse(base);
  assert.equal(omitted.success, true);
  assert.equal(omitted.success ? omitted.data.model_overrides : undefined, undefined);

  const oneKey = RunConfig.safeParse({ ...base, model_overrides: { "claude-code": "opus" } });
  assert.equal(oneKey.success, true);
  assert.deepEqual(oneKey.success ? oneKey.data.model_overrides : undefined, { "claude-code": "opus" });

  const bothKeys = RunConfig.safeParse({ ...base, model_overrides: { "claude-code": "opus", "codex-cli": "gpt-5.6-terra" } });
  assert.equal(bothKeys.success, true);
  assert.deepEqual(bothKeys.success ? bothKeys.data.model_overrides : undefined, { "claude-code": "opus", "codex-cli": "gpt-5.6-terra" });

  assert.equal(RunConfig.safeParse({ ...base, model_overrides: { "claude-code": "" } }).success, false);
  assert.equal(RunConfig.safeParse({ ...base, model_overrides: { "not-a-real-provider": "opus" } }).success, false);
});

// -------------------------------------------------------------------------------------------
// PHASE_7_SPEC.md §3.1/§3.3 -- role_pins round-trip and RP1-RP4 rejections. Colocated here
// (rather than a separate src/domain/run.test.ts, which does not exist in this codebase) matching
// this file's own established convention of testing every RunConfig field's own validator inline.
// -------------------------------------------------------------------------------------------

function rolePinBase(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    run_id: RUN_ID,
    repo_dir: "/tmp/repo",
    executor_providers: ["claude-code", "codex-cli"],
    phase: 1,
    spec_path: "PHASE_1_SPEC.md",
    baby_prd_path: "baby_prd.md",
    context_path: "context.md",
    ...overrides,
  };
}

test("RunConfig.role_pins round-trips every valid pin combination and is absent by default", () => {
  const omitted = RunConfig.safeParse(rolePinBase());
  assert.equal(omitted.success, true);
  assert.equal(omitted.success ? omitted.data.role_pins : undefined, undefined);

  const executorOnly = RunConfig.safeParse(rolePinBase({ role_pins: { "claude-code": "executor" } }));
  assert.equal(executorOnly.success, true);
  assert.deepEqual(executorOnly.success ? executorOnly.data.role_pins : undefined, { "claude-code": "executor" });

  const reviewerOnly = RunConfig.safeParse(rolePinBase({ role_pins: { "codex-cli": "reviewer" } }));
  assert.equal(reviewerOnly.success, true);
  assert.deepEqual(reviewerOnly.success ? reviewerOnly.data.role_pins : undefined, { "codex-cli": "reviewer" });

  const bothOpposite = RunConfig.safeParse(
    rolePinBase({ role_pins: { "claude-code": "executor", "codex-cli": "reviewer" } })
  );
  assert.equal(bothOpposite.success, true);
});

test("RunConfig.role_pins (z.enum) rejects a value outside {executor, reviewer}", () => {
  const result = RunConfig.safeParse(rolePinBase({ role_pins: { "claude-code": "both" } }));
  assert.equal(result.success, false);
});

test("RunConfig (RP1) rejects role_pins pinning every provider to reviewer -- no provider left eligible for the executor role", () => {
  const result = RunConfig.safeParse(rolePinBase({ role_pins: { "claude-code": "reviewer", "codex-cli": "reviewer" } }));
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.message.includes("RP1")));
  }
});

test("RunConfig (RP2) rejects role_pins pinning every provider to executor -- no provider left eligible for the reviewer role", () => {
  const result = RunConfig.safeParse(rolePinBase({ role_pins: { "claude-code": "executor", "codex-cli": "executor" } }));
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.message.includes("RP2")));
  }
});

test("RunConfig (RP3) rejects an explicit reviewer_provider naming a provider role_pins has pinned to executor", () => {
  const result = RunConfig.safeParse(
    rolePinBase({ reviewer_provider: "claude-code", role_pins: { "claude-code": "executor" } }),
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.message.includes("RP3")));
  }
});

test("RunConfig (RP4) rejects an explicit reviewer_provider disagreeing with the provider role_pins has pinned to reviewer", () => {
  const result = RunConfig.safeParse(
    rolePinBase({ reviewer_provider: "claude-code", role_pins: { "codex-cli": "reviewer" } })
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.message.includes("RP4")));
  }
});

test("RunConfig accepts an explicit reviewer_provider that agrees with role_pins (RP3/RP4 both satisfied)", () => {
  const result = RunConfig.safeParse(
    rolePinBase({ reviewer_provider: "codex-cli", role_pins: { "codex-cli": "reviewer" } })
  );
  assert.equal(result.success, true);
});

test("RunConfig (FM-P4/AC4) an RP1-triggering config never reaches runDispatch: safeParse fails before any turn or lock file", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const configPath = `${dir}/config.json`;
    const config = rolePinBase({
      run_id: RUN_ID,
      repo_dir: dir,
      role_pins: { "claude-code": "reviewer", "codex-cli": "reviewer" }
    });
    await writeFile(configPath, JSON.stringify(config), "utf8");
    await assert.rejects(
      () => runRunCommand({ configPath, json: false }),
      (err: unknown) => {
        assert.ok(err instanceof UsageError);
        assert.equal(err.exitCode, 2);
        assert.ok(err.message.includes("RP1"));
        return true;
      },
    );
  } finally {
    await cleanup(dir);
  }
});

test("RunConfig (FM-P4/AC5) an RP2-triggering config never reaches runDispatch: safeParse fails before any turn or lock file", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const configPath = `${dir}/config.json`;
    const config = rolePinBase({
      run_id: RUN_ID,
      repo_dir: dir,
      role_pins: { "claude-code": "executor", "codex-cli": "executor" }
    });
    await writeFile(configPath, JSON.stringify(config), "utf8");
    await assert.rejects(
      () => runRunCommand({ configPath, json: false }),
      (err: unknown) => {
        assert.ok(err instanceof UsageError);
        assert.equal(err.exitCode, 2);
        assert.ok(err.message.includes("RP2"));
        return true;
      },
    );
  } finally {
    await cleanup(dir);
  }
});

test("runRunCommand dispatches a valid config and returns a RunReport whose exit_code passes through runDispatch's own result", async () => {
  // Drives runRunCommand through an injected fake `deps: RunDispatchDeps` -- a fake, always-healthy
  // preflight plus a fake AdapterRegistry/runProcessFn standing in for a real provider CLI, mirroring
  // run-loop.test.ts's own "clean 3-turn run" scenario -- so this test's pass/fail depends only on
  // runRunCommand's own code (file read, JSON parse, RunConfig validation, dispatchResult -> RunReport
  // field mapping), never on this machine's Codex-CLI auth state, and it never spawns a real
  // `claude`/`codex` process regardless of auth state on any machine.
  const dir = await freshRepoWithSpec();
  try {
    const configPath = `${dir}/config.json`;
    await writeFile(configPath, validConfigJson(dir), "utf8");

    const claude = new RecordingFakeAdapter("claude-code");
    const codex = new RecordingFakeAdapter("codex-cli");
    const adapters: Partial<AdapterRegistry> = { "claude-code": claude, "codex-cli": codex };
    const artifacts = await looprArtifactRefs(dir);

    let call = 0;
    const runProcessFn: typeof runProcess = async () => {
      const step = call;
      call += 1;
      if (step === 0) {
        await commitFile(dir, "foo.txt", "v1\n", "turn0");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 0, "executor", "claude-code"),
          draft({
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec],
            artifactsWritten: [{ path: "foo.txt", sha256: "a".repeat(64) }],
          }),
        );
      } else if (step === 1) {
        await commitFile(dir, "bar.txt", "v1\n", "turn1");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 1, "executor", "codex-cli"),
          draft({
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "foo.txt", sha256: "a".repeat(64) }],
            artifactsWritten: [{ path: "bar.txt", sha256: "a".repeat(64) }],
          }),
        );
      } else {
        // The reviewer turn's own Phase 4 responsibility: genuinely produce the next loopr
        // artifact (PHASE_2_SPEC.md, since phase: 1 and is_final_phase: false) for real, as part
        // of this turn's own commit -- assertNextPhaseSpecProduced() requires both a declared
        // artifacts_written entry AND a commit that actually touches the path.
        await commitFile(dir, "PHASE_2_SPEC.md", "phase 2 spec content\n", "turn2");
        const nextSpecSha256 = await sha256File(`${dir}/PHASE_2_SPEC.md`);
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 2, "reviewer", "claude-code"),
          draft({
            role: "reviewer",
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "bar.txt", sha256: "a".repeat(64) }],
            artifactsWritten: [{ path: "PHASE_2_SPEC.md", sha256: nextSpecSha256 }],
          }),
        );
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const deps: RunDispatchDeps = { adapters, runProcessFn, preflightFn: fakeHealthyPreflight };
    const { report, exitCode } = await runRunCommand({ configPath, json: false }, deps);

    assert.equal(exitCode, report.exit_code);
    assert.equal(report.exit_code, 0);
    assert.equal(report.ok, true);
    assert.equal(report.run_id, RUN_ID);
    assert.equal(report.phase, 1);
    assert.deepStrictEqual(
      report.turns.map((t) => [t.turn_index, t.archetype, t.provider, t.status, t.continuity_verdict, t.retried]),
      [
        [0, "executor", "claude-code", "completed", null, false],
        [1, "executor", "codex-cli", "completed", "CONTINUED", false],
        [2, "reviewer", "claude-code", "completed", "CONTINUED", false],
      ],
    );
    // §9 non-goal-adjacent guarantee (PHASE_7_SPEC.md §1.1): a config with no role_pins produces
    // an empty warnings array in the JSON report, unaffected by this phase.
    assert.deepStrictEqual(report.warnings, []);
    RunReport.parse(report);
  } finally {
    await cleanup(dir);
  }
});

test("runRunCommand (AC3) surfaces reviewerReviewedOwnWork as a non-empty RunReport.warnings entry in the JSON report", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const configPath = `${dir}/config.json`;
    const config = {
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
      // §6.1 worked table row 2: the naive reviewer default collapses onto executor_providers[1],
      // which then reviews the diff it just wrote.
      role_pins: { "claude-code": "executor" },
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");

    const claude = new RecordingFakeAdapter("claude-code");
    const codex = new RecordingFakeAdapter("codex-cli");
    const adapters: Partial<AdapterRegistry> = { "claude-code": claude, "codex-cli": codex };
    const artifacts = await looprArtifactRefs(dir);

    let call = 0;
    const runProcessFn: typeof runProcess = async () => {
      const step = call;
      call += 1;
      if (step === 0) {
        await commitFile(dir, "foo.txt", "v1\n", "turn0");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 0, "executor", "claude-code"),
          draft({
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec],
            artifactsWritten: [{ path: "foo.txt", sha256: "a".repeat(64) }],
          }),
        );
      } else if (step === 1) {
        await commitFile(dir, "bar.txt", "v1\n", "turn1");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 1, "executor", "codex-cli"),
          draft({
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "foo.txt", sha256: "a".repeat(64) }],
            artifactsWritten: [{ path: "bar.txt", sha256: "a".repeat(64) }],
          }),
        );
      } else {
        await commitFile(dir, "PHASE_2_SPEC.md", "phase 2 spec content\n", "turn2");
        const nextSpecSha256 = await sha256File(`${dir}/PHASE_2_SPEC.md`);
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 2, "reviewer", "codex-cli"),
          draft({
            role: "reviewer",
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "bar.txt", sha256: "a".repeat(64) }],
            artifactsWritten: [{ path: "PHASE_2_SPEC.md", sha256: nextSpecSha256 }],
          }),
        );
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const deps: RunDispatchDeps = { adapters, runProcessFn, preflightFn: fakeHealthyPreflight };
    const { report } = await runRunCommand({ configPath, json: true }, deps);

    assert.equal(report.ok, true);
    assert.equal(report.warnings.length, 1);
    assert.ok(report.warnings[0]?.includes("codex-cli"));
    RunReport.parse(report);
  } finally {
    await cleanup(dir);
  }
});

test("CLI: OSA run with no --config exits 2 before touching any file", async () => {
  const { exitCode, stdout, stderr } = await runMain(["run"]);
  assert.equal(exitCode, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /--config/);
});

test("CLI: OSA run --config <path> <unknown-flag> is a usage error (exit 2)", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-run-cli-test-`);
  try {
    const { exitCode, stderr } = await runMain(["run", "--config", `${dir}/does-not-matter.json`, "--not-a-real-flag"]);
    assert.equal(exitCode, 2);
    assert.match(stderr, /Unknown flag/);
  } finally {
    await cleanup(dir);
  }
});

test("CLI: OSA run --config <path> where the JSON fails RunConfig validation exits 2", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-run-cli-test-`);
  try {
    const configPath = `${dir}/config.json`;
    await writeFile(configPath, JSON.stringify({ not: "a valid config" }), "utf8");
    const { exitCode, stdout, stderr } = await runMain(["run", "--config", configPath]);
    assert.equal(exitCode, 2);
    assert.equal(stdout, "");
    assert.notEqual(stderr, "");
  } finally {
    await cleanup(dir);
  }
});

test("CLI: OSA run --config <path> --json emits a single RunReport-shaped JSON object on stdout", async () => {
  // Spawns a real `node src/cli/main.ts ...` process (this is the CLI-level, argv-parsing/`--json`
  // plumbing test), so it can't accept an injected `deps` object the way the direct
  // `runRunCommand` test above does -- `main.ts`'s own call site intentionally never threads a
  // `deps` override (that is the seam's whole point: production behaviour stays untouched). Instead
  // this uses a config whose `spec_path` deterministically fails runDispatch's own extended
  // preflight (see `configJsonWithUnreadableSpecPath`'s own doc comment) regardless of provider auth
  // state, so the real subprocess can never proceed into the turn loop's real generation dispatch --
  // the actual hazard §8 acceptance criterion #30 / PHASE_2_SPEC.md §9 "never spawns a real turn"
  // forbids -- on any machine. It still exercises the real CLI end-to-end: argv parsing, config file
  // read, RunConfig validation, dispatch, and RunReport JSON emission on stdout with exit-code
  // passthrough (§8 #29's literal requirement: "shaped" JSON with `turns.length` reflecting however
  // many turns actually ran -- zero, here, on an early preflight failure).
  const dir = await freshRepoWithSpec();
  try {
    const configPath = `${dir}/config.json`;
    await writeFile(configPath, configJsonWithUnreadableSpecPath(dir), "utf8");

    const { exitCode, stdout } = await runMain(["run", "--config", configPath, "--json"]);

    const parsed: unknown = JSON.parse(stdout);
    const report = RunReport.parse(parsed);
    assert.equal(exitCode, report.exit_code);
    assert.equal(report.run_id, RUN_ID);
    assert.equal(report.exit_code, 3);
    assert.equal(report.ok, false);
    assert.deepStrictEqual(report.turns, []);
  } finally {
    await cleanup(dir);
  }
});



