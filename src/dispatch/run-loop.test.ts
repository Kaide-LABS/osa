// Implements PHASE_3_SPEC.md §1.1 -- run-loop.test.ts
// End-to-end dispatch scenarios against real temporary git repositories (continuity.test.ts's own
// established pattern, Phase 1) plus an injected fake AdapterRegistry/runProcessFn standing in for
// a real provider CLI -- no test in this file spawns a real `claude` or `codex` process.
// Covers §8 acceptance criteria #12, #13, #14, #19, #20, #21, #23, #24, #29.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BoundaryViolationError, InternalError, LooprArtifactBypassError, TurnTimeoutError } from "../domain/errors.ts";
import type { FileRef, HaltSignal, HandoffRecord } from "../domain/relay.ts";
import { readHandoffRecord, writeHandoffRecord } from "../domain/relay.ts";
import type { ProviderId, RawInvocationResult, RunConfig, TurnOutcome, TurnRequest } from "../domain/run.ts";
import { ChatLogEntry } from "../domain/chat-log.ts";
import type { AdapterRegistry, Invocation, PreflightReport, ProviderAdapter } from "../ports/provider-adapter.ts";
import { runProcess } from "../util/exec.ts";
import { acquireRunLock, readRunLock, releaseRunLock } from "../util/lock.ts";
import { chatLogPath, handoffPath } from "../util/paths.ts";
import { sha256File } from "../util/hash.ts";
import type { PreflightSummary } from "../verify/preflight.ts";
import { checkC5ArtifactAttestation, verifyContinuation } from "../verify/continuity.ts";
import { nextPhaseSpecPath } from "./artifacts.ts";
import { runDispatch } from "./run-loop.ts";

const GIT_TIMEOUT_MS = 120_000;
const RUN_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

/**
 * A synthetic, always-healthy `PreflightSummary`, injected via `RunDispatchDeps.preflightFn`
 * (an AUTONOMOUS CRITIQUE addition to `RunDispatchDeps` -- see run-loop.ts's own doc comment on
 * that interface). The real `runPreflight()` shells out to the actual `claude`/`codex` binaries
 * with no injection seam of its own; this repo's own dev machine has Codex CLI installed but not
 * authenticated (confirmed live: `node src/cli/main.ts doctor --providers --json`), which would
 * otherwise make every scenario below fail at PREFLIGHT_FAILED before ever reaching the turn loop
 * under test -- directly defeating §8 acceptance criterion #30's requirement that no test in this
 * phase spawn a real `claude` or `codex` process.
 */
function fakeHealthyPreflight(): Promise<PreflightSummary> {
  return Promise.resolve({
    node: { found: true, version: "24.15.0", inRange: true },
    git: { found: true, version: "2.54.0", inRange: true },
    providers: [
      { provider: "claude-code", cliFound: true, version: "2.1.211", versionInRange: true, authenticated: true, authState: "authenticated", problems: [] },
      { provider: "codex-cli", cliFound: true, version: "0.128.0", versionInRange: true, authenticated: true, authState: "authenticated", problems: [] },
      { provider: "antigravity-cli", cliFound: true, version: "1.1.20", versionInRange: true, authenticated: true, authState: "authenticated", problems: [] },
    ],
    ok: true,
    problems: [],
  });
}

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const result = await runProcess({ command: "git", args, cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${String(result.exitCode)}): ${result.stderr}`);
  }
  return result.stdout;
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "--quiet", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
}

async function commitFile(dir: string, relPath: string, content: string, message: string): Promise<string> {
  await writeFile(`${dir}/${relPath}`, content, "utf8");
  await git(dir, ["add", relPath]);
  await git(dir, ["commit", "--quiet", "-m", message]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

async function commitFiles(dir: string, files: Readonly<Record<string, string>>, message: string): Promise<string> {
  for (const [relPath, content] of Object.entries(files)) {
    await writeFile(`${dir}/${relPath}`, content, "utf8");
    await git(dir, ["add", relPath]);
  }
  await git(dir, ["commit", "--quiet", "-m", message]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

async function freshRepoWithSpec(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/osa-run-loop-test-`);
  await initRepo(dir);
  await commitFile(dir, "PHASE_1_SPEC.md", "spec content\n", "add spec");
  await commitFile(dir, "baby_prd.md", "baby prd content\n", "add baby_prd.md");
  await commitFile(dir, "context.md", "context content\n", "add context.md");
  // Pre-exists so a later "revert" scenario reverts to a real recorded blob (not to
  // non-existence, which C3_NO_REVERT does not treat as a revert target).
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

/**
 * `FileRef`s for `freshRepoWithSpec()`'s own `baby_prd.md`/`context.md`/`PHASE_1_SPEC.md`, computed
 * from the real files on disk -- required in every turn's `artifacts_read` since Phase 4's
 * `assertLooprArtifactsReferenced()` now runs unconditionally, for every turn (PHASE_4_SPEC.md
 * §6.3).
 */
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
    this.seenRequests.push(req);
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

/**
 * A schema-valid draft `HandoffRecord`. `run_id`/`phase`/`turn_index`/`role`/`provider`/
 * `model_tier`/`repo`/`spec_ref` values are placeholders -- `reconcileHandoffRecord` only ever
 * replaces `repo`/`spec_ref`/artifact hashes (§6.3), and none of Phase 3's own logic (continuity
 * checks, prompt assembly) ever reads the other bookkeeping fields, so any schema-valid placeholder
 * is sufficient for them.
 */
function draft(overrides: {
  readonly role?: "executor" | "reviewer";
  readonly artifactsRead?: readonly FileRef[];
  readonly artifactsWritten?: readonly FileRef[];
  readonly status?: "completed" | "blocked" | "halted";
  readonly halt?: HaltSignal | null;
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
    status: overrides.status ?? "completed",
    work_done: "did work",
    next_steps: [],
    open_questions: [],
    halt: overrides.halt ?? null,
  };
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Reads and parses every line of the chat log at `chatLogPath(dir, chatLogId)`, or `[]` if it does not exist yet. */
async function readChatLogEntriesForTest(dir: string, chatLogId: string): Promise<ChatLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(chatLogPath(dir, chatLogId), "utf8");
  } catch {
    return [];
  }
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => ChatLogEntry.parse(JSON.parse(line) as unknown));
}

test("runDispatch: clean 3-turn run completes ok, honours model_overrides/timeoutMs/tier per turn, releases the lock", async () => {
  const dir = await freshRepoWithSpec();
  try {
    // z.record over a closed-enum key schema requires every enum member when the object is
    // present at all (verified live: a partial object fails RunConfig validation) -- so "one
    // provider overridden, the other not" isn't an expressible RunConfig; this instead proves each
    // provider is attributed its own distinct value, not the other's or a constant.
    const config = baseConfig(dir, {
      turn_timeout_ms: 60_000,
      model_overrides: { "claude-code": "operator-chosen-claude-override", "codex-cli": "operator-chosen-codex-override" }
    });
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
        // The reviewer turn's Phase 4 responsibility: genuinely produce PHASE_2_SPEC.md (phase: 1,
        // is_final_phase: false) as part of this turn's own commit.
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

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.turns.length, 3);
    assert.deepStrictEqual(
      result.turns.map((t) => [t.archetype, t.provider, t.status, t.continuityVerdict, t.retried]),
      [
        ["executor", "claude-code", "completed", null, false],
        ["executor", "codex-cli", "completed", "CONTINUED", false],
        ["reviewer", "claude-code", "completed", "CONTINUED", false],
      ],
    );

    // model_overrides/timeoutMs/tier passthrough (§8 #23, #24).
    assert.equal(claude.seenRequests[0]?.modelOverride, "operator-chosen-claude-override");
    assert.equal(codex.seenRequests[0]?.modelOverride, "operator-chosen-codex-override");
    for (const req of [...claude.seenRequests, ...codex.seenRequests]) {
      assert.equal(req.timeoutMs, 60_000);
    }
    assert.equal(claude.seenRequests[0]?.tier, "high-volume-low-effort");
    assert.equal(claude.seenRequests[1]?.tier, "verification-grade");

    assert.equal(await readRunLock(dir), null);
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch (PHASE_10_SPEC.md §8.2 AC2-a) the chat log is appended incrementally: at the exact moment turn N is spawned, the log already contains 2N+1 entries", async () => {
  // Falsified by any implementation that buffers entries and flushes at the end -- this reads the
  // log FROM INSIDE the fake runProcessFn, at the moment each turn's process would be spawned,
  // which is strictly after capture point 1 (the prompt append) but strictly before capture point 2
  // (the response append) for that same turn. Proves incremental, ordered, before-the-end writing.
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir);
    const claude = new RecordingFakeAdapter("claude-code");
    const codex = new RecordingFakeAdapter("codex-cli");
    const adapters: Partial<AdapterRegistry> = { "claude-code": claude, "codex-cli": codex };
    const artifacts = await looprArtifactRefs(dir);

    const observedCountsAtSpawn: number[] = [];
    let call = 0;
    const runProcessFn: typeof runProcess = async () => {
      const step = call;
      call += 1;
      observedCountsAtSpawn.push((await readChatLogEntriesForTest(dir, RUN_ID)).length);
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

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, true);
    // Turn 0 is spawned with the log empty except its own just-written prompt entry (1); turn 1 is
    // spawned once turn 0's complete pair (2) plus turn 1's own prompt entry (1) exist (3); turn 2
    // similarly sees 5.
    assert.deepStrictEqual(observedCountsAtSpawn, [1, 3, 5]);

    // And by the end, every turn's complete pair is present -- nothing was lost or double-written.
    const finalEntries = await readChatLogEntriesForTest(dir, RUN_ID);
    assert.equal(finalEntries.length, 6);
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: a continuity failure retries exactly once and succeeds", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir);
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
        // Bad attempt: reverts foo.txt entirely -> C3_NO_REVERT fails all-reverted -> REDO.
        await commitFile(dir, "foo.txt", "v0\n", "turn1 (bad, reverts turn0)");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 1, "executor", "codex-cli"),
          draft({ artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "foo.txt", sha256: "a".repeat(64) }] }),
        );
      } else if (step === 2) {
        // Retry (turnIndex 2): restores foo.txt to turn0's content (undoing the bad revert) and
        // adds bar.txt -- genuinely does not revert any path turn0 touched.
        await commitFiles(dir, { "foo.txt": "v1\n", "bar.txt": "v1\n" }, "turn1 retry (good)");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 2, "executor", "codex-cli"),
          draft({
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "foo.txt", sha256: "a".repeat(64) }],
            artifactsWritten: [{ path: "bar.txt", sha256: "a".repeat(64) }],
          }),
        );
      } else {
        await commitFile(dir, "PHASE_2_SPEC.md", "phase 2 spec content\n", "turn2 (reviewer, turnIndex 3)");
        const nextSpecSha256 = await sha256File(`${dir}/PHASE_2_SPEC.md`);
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 3, "reviewer", "claude-code"),
          draft({
            role: "reviewer",
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "bar.txt", sha256: "a".repeat(64) }],
            artifactsWritten: [{ path: "PHASE_2_SPEC.md", sha256: nextSpecSha256 }],
          }),
        );
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    // With RunConfig.model_overrides entirely omitted, every turn falls back to null (§8 #24).
    assert.equal(claude.seenRequests[0]?.modelOverride, null);
    assert.equal(codex.seenRequests[0]?.modelOverride, null);

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    // §8 #29: "one extra" turn on a single successful retry.
    assert.equal(result.turns.length, 4);
    assert.deepStrictEqual(
      result.turns.map((t) => [t.turnIndex, t.status, t.continuityVerdict, t.retried]),
      [
        [0, "completed", null, false],
        [1, "completed", "REDO", false],
        [2, "completed", "CONTINUED", true],
        [3, "completed", "CONTINUED", false],
      ],
    );
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch (PHASE_10_SPEC.md §8.3 AC3) a rejected continuity attempt's own real exchange survives resetHard under its own turn_index, and the retry gets a distinct turn_index carrying the RETRY NOTICE", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir);
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
        // Bad attempt: reverts foo.txt entirely -> C3_NO_REVERT fails all-reverted -> REDO.
        await commitFile(dir, "foo.txt", "v0\n", "turn1 (bad, reverts turn0)");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 1, "executor", "codex-cli"),
          draft({ artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "foo.txt", sha256: "a".repeat(64) }] }),
        );
      } else if (step === 2) {
        await commitFiles(dir, { "foo.txt": "v1\n", "bar.txt": "v1\n" }, "turn1 retry (good)");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 2, "executor", "codex-cli"),
          draft({
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "foo.txt", sha256: "a".repeat(64) }],
            artifactsWritten: [{ path: "bar.txt", sha256: "a".repeat(64) }],
          }),
        );
      } else {
        await commitFile(dir, "PHASE_2_SPEC.md", "phase 2 spec content\n", "turn2 (reviewer, turnIndex 3)");
        const nextSpecSha256 = await sha256File(`${dir}/PHASE_2_SPEC.md`);
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 3, "reviewer", "claude-code"),
          draft({
            role: "reviewer",
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "bar.txt", sha256: "a".repeat(64) }],
            artifactsWritten: [{ path: "PHASE_2_SPEC.md", sha256: nextSpecSha256 }],
          }),
        );
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, true);
    assert.deepStrictEqual(
      result.turns.map((t) => [t.turnIndex, t.continuityVerdict, t.retried]),
      [
        [0, null, false],
        [1, "REDO", false],
        [2, "CONTINUED", true],
        [3, "CONTINUED", false],
      ],
    );

    // `resetHard` genuinely discarded the rejected attempt's own commit from git history...
    const log = await git(dir, ["log", "--oneline", "--all"]);
    assert.ok(!log.includes("turn1 (bad, reverts turn0)"));

    // ...yet the chat log -- living in an untracked, gitignored directory `resetHard` never
    // touches -- is the only remaining record of that attempt's real exchange, and it survived.
    const entries = await readChatLogEntriesForTest(dir, RUN_ID);
    assert.equal(entries.length, 8); // 4 turn attempts (0, 1 rejected, 2 retry, 3) x 2

    const byTurnIndex = (idx: number): ChatLogEntry[] => entries.filter((e) => e.turn_index === idx);

    const rejected = byTurnIndex(1);
    assert.equal(rejected.length, 2);
    const rejectedPrompt = rejected.find((e) => e.entry_kind === "prompt");
    const rejectedResponse = rejected.find((e) => e.entry_kind === "response");
    assert.ok(rejectedPrompt !== undefined && rejectedPrompt.transcript.prompt !== null && rejectedPrompt.transcript.prompt.length > 0);
    assert.ok(rejectedResponse !== undefined && rejectedResponse.outcome !== null && rejectedResponse.outcome.ok === true);

    const retry = byTurnIndex(2);
    assert.equal(retry.length, 2);
    const retryPrompt = retry.find((e) => e.entry_kind === "prompt");
    assert.ok(retryPrompt !== undefined && retryPrompt.transcript.prompt !== null);
    assert.ok(retryPrompt?.transcript.prompt?.includes("RETRY NOTICE:"));
    assert.notEqual(retryPrompt?.turn_index, rejectedPrompt?.turn_index);
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch (PHASE_10_SPEC.md §8.3 AC3) a halted turn's own real exchange is present in the chat log", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir);
    const claude = new RecordingFakeAdapter("claude-code");
    const codex = new RecordingFakeAdapter("codex-cli");
    const adapters: Partial<AdapterRegistry> = { "claude-code": claude, "codex-cli": codex };
    const haltSignal: HaltSignal = { code: "BLOCKED_ON_HUMAN", message: "need operator input" };
    const artifacts = await looprArtifactRefs(dir);

    const runProcessFn: typeof runProcess = async () => {
      await commitFile(dir, "foo.txt", "v1\n", "turn0 (halted)");
      await writeHandoffRecord(
        handoffPath(dir, RUN_ID, 1, 0, "executor", "claude-code"),
        draft({ status: "halted", halt: haltSignal, artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec] }),
      );
      return { exitCode: 0, signal: null, stdout: "halted stdout", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });
    assert.equal(result.ok, false);
    assert.equal(result.turns[0]?.status, "halted");

    const entries = await readChatLogEntriesForTest(dir, RUN_ID);
    assert.equal(entries.length, 2);
    const response = entries.find((e) => e.entry_kind === "response");
    assert.equal(response?.transcript.stdout, "halted stdout");
    assert.equal(response?.outcome?.ok, true); // runTurn's own adapter-level outcome; halted is a record-status decision one layer up.
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch (PHASE_10_SPEC.md §8.3 AC3) a failed (timed-out) turn's own real exchange is present in the chat log", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir);
    const claude = new RecordingFakeAdapter("claude-code");
    const codex = new RecordingFakeAdapter("codex-cli");
    const adapters: Partial<AdapterRegistry> = { "claude-code": claude, "codex-cli": codex };

    const runProcessFn: typeof runProcess = async () => ({
      exitCode: null,
      signal: null,
      stdout: "partial output before the timeout",
      stderr: "",
      durationMs: 1,
      timedOut: true,
    });

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });
    assert.equal(result.ok, false);
    assert.equal(result.turns[0]?.status, "failed");

    const entries = await readChatLogEntriesForTest(dir, RUN_ID);
    assert.equal(entries.length, 2);
    const response = entries.find((e) => e.entry_kind === "response");
    assert.equal(response?.outcome?.ok, false);
    assert.equal(response?.outcome?.timed_out, true);
    assert.equal(response?.transcript.stdout, "partial output before the timeout");
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: before a retry is dispatched the repo is hard-reset to the last known-good commit, so a retry that re-reads AND modifies the prior turn's artifact still passes C5", async () => {
  // The third and final layer of today's live-run bug chain, and the one shape that was
  // *structurally* impossible to pass before the reset existed.
  //
  // `reconcileHandoffRecord()` reconciles `artifacts_read` against `ground.headBefore` -- the real
  // commit the turn started from -- while `verifyContinuation()` compares the retry against
  // `prevRecord`, the last *genuinely good* record. For a normal turn those are the same commit.
  // For a retry they were not: the failed attempt's commits were never undone, so the retry's real
  // `headBefore` was the failed attempt's `head_after`, and `artifacts_read` got hashed against the
  // bad content while C5 expected the last-good content. No retry agent behaviour could fix that.
  //
  // The fixture below is deliberately the read-then-modify shape (the retry reads `foo.txt` as
  // turn 0 wrote it and then appends to it), because that is what makes the two baselines produce
  // provably different hashes rather than coincidentally equal ones. Falsified by deleting the
  // `resetHard(config.repo_dir, prevRecord.repo.head_after)` call in `runTurnLoop`: this test then
  // fails with exitCode 6 (CONTINUITY_FAILED) and a retry verdict of IGNORED on C5.
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir);
    const claude = new RecordingFakeAdapter("claude-code");
    const codex = new RecordingFakeAdapter("codex-cli");
    const adapters: Partial<AdapterRegistry> = { "claude-code": claude, "codex-cli": codex };
    const artifacts = await looprArtifactRefs(dir);

    const FOO_V1 = "v1\n";
    const FOO_RETRY = "v1\nappended by the retry\n";

    // Held on an object rather than in three `let`s: TypeScript's flow analysis narrows a `let`
    // that is only ever reassigned inside a callback back to its initialiser's type at the
    // assertion sites below, which would make every comparison here vacuous.
    const observed = { turn0HeadAfter: "", badAttemptHeadAfter: "", headSeenAtRetryDispatch: "" };

    let call = 0;
    const runProcessFn: typeof runProcess = async () => {
      const step = call;
      call += 1;
      if (step === 0) {
        observed.turn0HeadAfter = await commitFile(dir, "foo.txt", FOO_V1, "turn0");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 0, "executor", "claude-code"),
          draft({
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec],
            artifactsWritten: [{ path: "foo.txt", sha256: "a".repeat(64) }],
          }),
        );
      } else if (step === 1) {
        // Bad attempt: reverts foo.txt entirely -> C3_NO_REVERT all-reverted -> REDO.
        observed.badAttemptHeadAfter = await commitFile(dir, "foo.txt", "v0\n", "turn1 (bad, reverts turn0)");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 1, "executor", "codex-cli"),
          draft({ artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "foo.txt", sha256: "a".repeat(64) }] }),
        );
      } else if (step === 2) {
        // The retry. Observed *inside* the spawn seam, i.e. at exactly the moment the retry agent's
        // own process would start -- this is the real git state the retry runs against, and the
        // same state `captureGroundTruthBefore()` has just recorded as its `headBefore`.
        observed.headSeenAtRetryDispatch = (await git(dir, ["rev-parse", "HEAD"])).trim();
        // Reads foo.txt as turn 0 left it and *modifies* it -- entirely legitimate work, and the
        // exact case the end-of-turn-disk reconciliation used to make unattestable.
        await commitFile(dir, "foo.txt", FOO_RETRY, "turn1 retry (good: extends turn0's file)");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 2, "executor", "codex-cli"),
          draft({
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "foo.txt", sha256: "a".repeat(64) }],
            artifactsWritten: [{ path: "foo.txt", sha256: "a".repeat(64) }],
          }),
        );
      } else {
        await commitFile(dir, "PHASE_2_SPEC.md", "phase 2 spec content\n", "turn2 (reviewer, turnIndex 3)");
        const nextSpecSha256 = await sha256File(`${dir}/PHASE_2_SPEC.md`);
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 3, "reviewer", "claude-code"),
          draft({
            role: "reviewer",
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "foo.txt", sha256: "a".repeat(64) }],
            artifactsWritten: [{ path: "PHASE_2_SPEC.md", sha256: nextSpecSha256 }],
          }),
        );
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.deepStrictEqual(
      result.turns.map((t) => [t.turnIndex, t.continuityVerdict, t.retried]),
      [
        [0, null, false],
        [1, "REDO", false],
        [2, "CONTINUED", true],
        [3, "CONTINUED", false],
      ],
    );

    // (1) The real git state the retry started from. Not the failed attempt's commit -- the last
    // known-good one, which is precisely the record continuity compares the retry against.
    assert.notEqual(observed.badAttemptHeadAfter, observed.turn0HeadAfter);
    assert.equal(observed.headSeenAtRetryDispatch, observed.turn0HeadAfter);
    assert.notEqual(observed.headSeenAtRetryDispatch, observed.badAttemptHeadAfter);

    // (2) The same fact as the retry's own reconciled record sees it.
    const turn0Record = await readHandoffRecord(handoffPath(dir, RUN_ID, 1, 0, "executor", "claude-code"));
    const retryRecord = await readHandoffRecord(handoffPath(dir, RUN_ID, 1, 2, "executor", "codex-cli"));
    assert.equal(retryRecord.repo.head_before, turn0Record.repo.head_after);

    // (3) The retry genuinely read turn 0's version of foo.txt and wrote a different one -- the
    // read-then-modify shape. If these two hashes were equal the test would prove nothing.
    const readFoo = retryRecord.artifacts_read.find((r) => r.path === "foo.txt");
    const writtenFoo = retryRecord.artifacts_written.find((r) => r.path === "foo.txt");
    assert.equal(readFoo?.sha256, turn0Record.artifacts_written.find((r) => r.path === "foo.txt")?.sha256);
    assert.notEqual(writtenFoo?.sha256, readFoo?.sha256);

    // (4) And C5/the full verdict pass on their own, re-run directly against the persisted records.
    assert.equal(checkC5ArtifactAttestation(turn0Record, retryRecord).passed, true);
    assert.equal((await verifyContinuation(dir, turn0Record, retryRecord)).verdict, "CONTINUED");

    // (5) The failed attempt's commit really is gone from the branch it was made on.
    const log = await git(dir, ["log", "--format=%H"]);
    assert.ok(log.includes(observed.turn0HeadAfter));
    assert.ok(!log.includes(observed.badAttemptHeadAfter));
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: a continuity failure on both the original and the retry halts at CONTINUITY_FAILED (6)", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir);
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
        // Original attempt (turnIndex 1) reverts foo.txt back to turn0's own pre-turn content.
        await commitFile(dir, "foo.txt", "v0\n", "turn1 attempt 1 (bad, reverts turn0)");
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, step, "executor", "codex-cli"),
          draft({ artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "foo.txt", sha256: "a".repeat(64) }] }),
        );
      } else {
        // Retry (turnIndex 2): reverts foo.txt to its pre-turn0 content *again*, which is what it
        // now takes to stay a REDO. Merely not touching foo.txt is no longer enough: `runTurnLoop`
        // hard-resets the repository to turn0's own commit before dispatching the retry, so the
        // original attempt's revert has already been undone and the retry starts from a repo where
        // foo.txt is v1. It also commits an unrelated file, preserving this fixture's original
        // point that the attempt makes a real commit (R3) rather than an empty git operation.
        await commitFiles(
          dir,
          { "foo.txt": "v0\n", [`noise-${String(step)}.txt`]: "noise\n" },
          `turn1 attempt ${String(step)} (bad, reverts turn0 again)`,
        );
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, step, "executor", "codex-cli"),
          draft({ artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "foo.txt", sha256: "a".repeat(64) }] }),
        );
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 6);
    assert.equal(result.turns.length, 3);
    assert.deepStrictEqual(
      result.turns.map((t) => [t.turnIndex, t.continuityVerdict, t.retried]),
      [
        [0, null, false],
        [1, "REDO", false],
        [2, "REDO", true],
      ],
    );
    assert.equal(await readRunLock(dir), null);
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: a HandoffRecord.status of \"halted\" stops the run immediately, before any continuity check, exitCode RUN_HALTED (11)", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir);
    const claude = new RecordingFakeAdapter("claude-code");
    const codex = new RecordingFakeAdapter("codex-cli");
    const adapters: Partial<AdapterRegistry> = { "claude-code": claude, "codex-cli": codex };
    const haltSignal: HaltSignal = { code: "BLOCKED_ON_HUMAN", message: "need operator input" };
    const artifacts = await looprArtifactRefs(dir);

    const runProcessFn: typeof runProcess = async () => {
      await commitFile(dir, "foo.txt", "v1\n", "turn0 (halted)");
      await writeHandoffRecord(
        handoffPath(dir, RUN_ID, 1, 0, "executor", "claude-code"),
        draft({
          status: "halted",
          halt: haltSignal,
          artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec],
        }),
      );
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 11);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0]?.status, "halted");
    assert.equal(result.turns[0]?.continuityVerdict, null);
    assert.deepStrictEqual(result.halt, haltSignal);
    assert.equal(await readRunLock(dir), null);
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: an adapter-reported failure (e.g. a timeout) on the first turn halts with zero retry", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir);
    const claude = new RecordingFakeAdapter("claude-code");
    const codex = new RecordingFakeAdapter("codex-cli");
    const adapters: Partial<AdapterRegistry> = { "claude-code": claude, "codex-cli": codex };

    const runProcessFn: typeof runProcess = async () => ({
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: true,
    });

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 10);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0]?.status, "failed");
    assert.equal(result.turns[0]?.retried, false);
    assert.equal(await readRunLock(dir), null);
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: an unexpected throw (BoundaryViolationError from assertNeutralCommits) still releases the lock", async () => {
  // §8 acceptance criterion #12 explicitly requires lock release to be verified for "an
  // unexpected throw", not only for the modelled RunResult-returning exit paths. run-loop.ts's own
  // top-of-file comment states a `BoundaryViolationError` from `assertNeutralCommits` inside
  // `runTurn` is "deliberately never caught anywhere in this module" and is left to propagate out
  // of `runDispatch` itself -- so this is the one exit path where `runDispatch` throws rather than
  // returning a `RunResult`. FM6/I4 both depend on the lock still being released here: a leaked
  // lock on a boundary violation would deadlock every subsequent run against this repo.
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir);
    const claude = new RecordingFakeAdapter("claude-code");
    const codex = new RecordingFakeAdapter("codex-cli");
    const adapters: Partial<AdapterRegistry> = { "claude-code": claude, "codex-cli": codex };
    const artifacts = await looprArtifactRefs(dir);

    const runProcessFn: typeof runProcess = async () => {
      // A commit carrying an AI-attribution trailer -- assertNeutralCommits (called inside
      // runTurn, after ground-truth reconciliation and after both new Phase 4 artifact guards)
      // must reject this with BoundaryViolationError. artifacts_read references all three loopr
      // artifacts so this turn clears the new guards and reaches assertNeutralCommits at all.
      await commitFile(dir, "foo.txt", "v1\n", "turn0 (dirty)\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
      await writeHandoffRecord(
        handoffPath(dir, RUN_ID, 1, 0, "executor", "claude-code"),
        draft({
          artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec],
          artifactsWritten: [{ path: "foo.txt", sha256: "a".repeat(64) }],
        }),
      );
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    await assert.rejects(
      runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight }),
      (err: unknown) => {
        assert.ok(err instanceof BoundaryViolationError);
        return true;
      },
    );

    // The lock must be released even though runDispatch threw rather than returning a RunResult.
    assert.equal(await readRunLock(dir), null);
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: lock contention returns LOCK_HELD (8) without dispatching any turn", async () => {
  const dir = await freshRepoWithSpec();
  try {
    await acquireRunLock(dir, "11111111-1111-1111-1111-111111111111");
    const config = baseConfig(dir);
    const claude = new RecordingFakeAdapter("claude-code");
    const codex = new RecordingFakeAdapter("codex-cli");
    const adapters: Partial<AdapterRegistry> = { "claude-code": claude, "codex-cli": codex };

    let calls = 0;
    const runProcessFn: typeof runProcess = async () => {
      calls += 1;
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 8);
    assert.deepStrictEqual(result.turns, []);
    assert.equal(calls, 0);
  } finally {
    await releaseRunLock(dir, "11111111-1111-1111-1111-111111111111");
    await cleanup(dir);
  }
});

test("runDispatch: a missing spec_path fails preflight (exitCode 3) before acquiring the lock or touching .osa/runs/**", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir, { spec_path: "DOES_NOT_EXIST.md" });
    const adapters: Partial<AdapterRegistry> = {
      "claude-code": new RecordingFakeAdapter("claude-code"),
      "codex-cli": new RecordingFakeAdapter("codex-cli")
    };

    let calls = 0;
    const runProcessFn: typeof runProcess = async () => {
      calls += 1;
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.deepStrictEqual(result.turns, []);
    assert.equal(calls, 0);
    assert.equal(await readRunLock(dir), null);
    assert.ok(result.problems.some((p) => p.includes("DOES_NOT_EXIST.md")));
  } finally {
    await cleanup(dir);
  }
});

// -------------------------------------------------------------------------------------------
// PHASE_4_SPEC.md §6.4 -- extended preflight for baby_prd_path/context_path, and the two new
// loopr-artifact guards' end-to-end wiring through runDispatch (§8 acceptance criteria #20, #21, #23)
// -------------------------------------------------------------------------------------------

test("runDispatch: a missing baby_prd_path fails preflight (exitCode 3) before acquiring the lock or dispatching any turn", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir, { baby_prd_path: "DOES_NOT_EXIST_BABY_PRD.md" });
    const adapters: Partial<AdapterRegistry> = {
      "claude-code": new RecordingFakeAdapter("claude-code"),
      "codex-cli": new RecordingFakeAdapter("codex-cli")
    };

    let calls = 0;
    const runProcessFn: typeof runProcess = async () => {
      calls += 1;
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.deepStrictEqual(result.turns, []);
    assert.equal(calls, 0);
    assert.equal(await readRunLock(dir), null);
    assert.ok(result.problems.some((p) => p.includes("DOES_NOT_EXIST_BABY_PRD.md")));
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: a missing context_path fails preflight (exitCode 3) before acquiring the lock or dispatching any turn", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir, { context_path: "DOES_NOT_EXIST_CONTEXT.md" });
    const adapters: Partial<AdapterRegistry> = {
      "claude-code": new RecordingFakeAdapter("claude-code"),
      "codex-cli": new RecordingFakeAdapter("codex-cli")
    };

    let calls = 0;
    const runProcessFn: typeof runProcess = async () => {
      calls += 1;
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.deepStrictEqual(result.turns, []);
    assert.equal(calls, 0);
    assert.equal(await readRunLock(dir), null);
    assert.ok(result.problems.some((p) => p.includes("DOES_NOT_EXIST_CONTEXT.md")));
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: a missing executor_prompt_path fails preflight (exitCode 3) before acquiring the lock or dispatching any turn", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir, { executor_prompt_path: "DOES_NOT_EXIST_STEP11.md" });
    const adapters: Partial<AdapterRegistry> = {
      "claude-code": new RecordingFakeAdapter("claude-code"),
      "codex-cli": new RecordingFakeAdapter("codex-cli")
    };

    let calls = 0;
    const runProcessFn: typeof runProcess = async () => {
      calls += 1;
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.deepStrictEqual(result.turns, []);
    assert.equal(calls, 0);
    assert.equal(await readRunLock(dir), null);
    assert.ok(result.problems.some((p) => p.includes("DOES_NOT_EXIST_STEP11.md")));
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: a missing reviewer_prompt_path fails preflight (exitCode 3) before acquiring the lock or dispatching any turn; reviewer_prompt_path alone is checked without requiring executor_prompt_path", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir, { reviewer_prompt_path: "DOES_NOT_EXIST_STEP12.md" });
    const adapters: Partial<AdapterRegistry> = {
      "claude-code": new RecordingFakeAdapter("claude-code"),
      "codex-cli": new RecordingFakeAdapter("codex-cli")
    };

    let calls = 0;
    const runProcessFn: typeof runProcess = async () => {
      calls += 1;
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.deepStrictEqual(result.turns, []);
    assert.equal(calls, 0);
    assert.equal(await readRunLock(dir), null);
    assert.ok(result.problems.some((p) => p.includes("DOES_NOT_EXIST_STEP12.md")));
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: executor_prompt_path/reviewer_prompt_path content, sanitized, reaches the actual executor/reviewer turns' prompts -- and only those turns", async () => {
  const dir = await freshRepoWithSpec();
  try {
    await commitFile(
      dir,
      "STEP11.md",
      ["---", "name: loopr-step11", "model: sonnet", "---", "", "STEP11 REAL METHODOLOGY MARKER"].join("\n"),
      "add STEP11.md",
    );
    await commitFile(
      dir,
      "STEP12.md",
      ["---", "name: loopr-step12", "model: sonnet", "---", "", "STEP12 REAL METHODOLOGY MARKER"].join("\n"),
      "add STEP12.md",
    );
    const config = baseConfig(dir, { executor_prompt_path: "STEP11.md", reviewer_prompt_path: "STEP12.md" });
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

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });
    assert.equal(result.ok, true);

    // Both executor turns (claude-code turn 0, codex-cli turn 1) receive the sanitized Step 11
    // content, frontmatter stripped -- proving the content reaches whichever provider actually
    // executes the slot, not just the provider the file happens to be customized "for".
    assert.ok(claude.seenRequests[0]?.prompt.includes("STEP11 REAL METHODOLOGY MARKER"));
    assert.ok(codex.seenRequests[0]?.prompt.includes("STEP11 REAL METHODOLOGY MARKER"));
    for (const req of [claude.seenRequests[0], codex.seenRequests[0]]) {
      assert.ok(!req?.prompt.includes("name: loopr-step11"));
    }

    // The reviewer turn (claude-code turn 2) receives Step 12 content, never Step 11's.
    assert.ok(claude.seenRequests[1]?.prompt.includes("STEP12 REAL METHODOLOGY MARKER"));
    assert.ok(!claude.seenRequests[1]?.prompt.includes("STEP11 REAL METHODOLOGY MARKER"));
    assert.ok(!claude.seenRequests[1]?.prompt.includes("name: loopr-step12"));

    // And Step 12 content never leaks into an executor turn's prompt.
    assert.ok(!claude.seenRequests[0]?.prompt.includes("STEP12 REAL METHODOLOGY MARKER"));
    assert.ok(!codex.seenRequests[0]?.prompt.includes("STEP12 REAL METHODOLOGY MARKER"));
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: is_final_phase: true computes and enforces BUILD_COMPLETE.md as the reviewer's expected artifact path, instead of a PHASE_N_SPEC.md pattern", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir, { is_final_phase: true });
    assert.equal(nextPhaseSpecPath(config.spec_path, config.phase, config.is_final_phase), "BUILD_COMPLETE.md");

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
        // The reviewer turn's own final-phase responsibility: genuinely produce BUILD_COMPLETE.md,
        // never a PHASE_N_SPEC.md-shaped path.
        await commitFile(dir, "BUILD_COMPLETE.md", "build complete\n", "turn2 (final-phase reviewer)");
        const completeSha256 = await sha256File(`${dir}/BUILD_COMPLETE.md`);
        await writeHandoffRecord(
          handoffPath(dir, RUN_ID, 1, 2, "reviewer", "claude-code"),
          draft({
            role: "reviewer",
            artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec, { path: "bar.txt", sha256: "a".repeat(64) }],
            artifactsWritten: [{ path: "BUILD_COMPLETE.md", sha256: completeSha256 }],
          }),
        );
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.turns.length, 3);
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: a LooprArtifactBypassError on the first turn propagates uncaught with zero retry -- the run halts at exit 12 on the very first occurrence, still releasing the lock", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir);
    const claude = new RecordingFakeAdapter("claude-code");
    const codex = new RecordingFakeAdapter("codex-cli");
    const adapters: Partial<AdapterRegistry> = { "claude-code": claude, "codex-cli": codex };

    let calls = 0;
    const runProcessFn: typeof runProcess = async () => {
      calls += 1;
      // Real commit, but the draft never references any loopr artifact in artifacts_read.
      await commitFile(dir, "foo.txt", "v1\n", "turn0");
      await writeHandoffRecord(
        handoffPath(dir, RUN_ID, 1, 0, "executor", "claude-code"),
        draft({ artifactsWritten: [{ path: "foo.txt", sha256: "a".repeat(64) }] }),
      );
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    await assert.rejects(
      runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight }),
      (err: unknown) => {
        assert.ok(err instanceof LooprArtifactBypassError);
        assert.equal(err.exitCode, 12);
        return true;
      },
    );

    // Zero retry: runProcessFn was invoked exactly once, joining the same zero-retry bucket as
    // BoundaryViolationError/PreflightError/LockHeldError (PHASE_4_SPEC.md §7).
    assert.equal(calls, 1);
    assert.equal(await readRunLock(dir), null);
  } finally {
    await cleanup(dir);
  }
});

// -------------------------------------------------------------------------------------------
// PHASE_7_SPEC.md §8 acceptance criteria 1 and 3 -- role pinning, end-to-end through runDispatch.
// -------------------------------------------------------------------------------------------

test("runDispatch (AC1): role_pins: {A: executor, B: reviewer} produces clean role separation -- no turn has reviewer/A or executor/B, and warnings stays empty", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir, { role_pins: { "claude-code": "executor", "codex-cli": "reviewer" } });
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
          handoffPath(dir, RUN_ID, 1, 1, "executor", "claude-code"),
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

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, true);
    assert.equal(result.turns.length, 3);
    assert.deepStrictEqual(
      result.turns.map((t) => [t.archetype, t.provider]),
      [
        ["executor", "claude-code"],
        ["executor", "claude-code"],
        ["reviewer", "codex-cli"],
      ],
    );
    assert.ok(!result.turns.some((t) => t.archetype === "reviewer" && t.provider === "claude-code"));
    assert.ok(!result.turns.some((t) => t.archetype === "executor" && t.provider === "codex-cli"));
    assert.deepStrictEqual(result.warnings, []);
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch (AC3): a role_pins state that collapses the reviewer onto the diff-writer produces exactly one non-empty warning naming the provider", async () => {
  const dir = await freshRepoWithSpec();
  try {
    // §6.1 worked table row 2: {A: executor} only, A === executor_providers[0] -- the naive
    // reviewer default (otherProviderId(executor_providers[1]) === A) is banned, so the reviewer
    // slot falls back to executor_providers[1] itself: it reviews the diff it just wrote.
    const config = baseConfig(dir, { role_pins: { "claude-code": "executor" } });
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

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, true);
    assert.deepStrictEqual(
      result.turns.map((t) => [t.archetype, t.provider]),
      [
        ["executor", "claude-code"],
        ["executor", "codex-cli"],
        ["reviewer", "codex-cli"],
      ],
    );
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0]?.includes("codex-cli"));
    assert.ok(result.warnings[0]?.toLowerCase().includes("own prior work"));
  } finally {
    await cleanup(dir);
  }
});

test("runDispatch: RunResult.warnings is [] for a config with no role_pins (pre-Phase-7 fixture shape, unaffected by this phase)", async () => {
  const dir = await freshRepoWithSpec();
  try {
    const config = baseConfig(dir);
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

    const result = await runDispatch(config, { adapters, runProcessFn, preflightFn: fakeHealthyPreflight });

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.warnings, []);
  } finally {
    await cleanup(dir);
  }
});



