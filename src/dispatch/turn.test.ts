// Implements PHASE_3_SPEC.md §1.1 -- turn.test.ts
// Full turn lifecycle against a real temp git repo, with an injectable runProcessFn fixture
// standing in for a real provider CLI. Covers §8 acceptance criteria #18, #22, #23.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BoundaryViolationError, InternalError, IsolationLeakError, LooprArtifactBypassError, RelaySchemaError } from "../domain/errors.ts";
import type { FileRef, HandoffRecord } from "../domain/relay.ts";
import { writeHandoffRecord } from "../domain/relay.ts";
import type { RawInvocationResult, TurnOutcome, TurnRequest } from "../domain/run.ts";
import type { Invocation, PreflightReport, ProviderAdapter } from "../ports/provider-adapter.ts";
import { runProcess } from "../util/exec.ts";
import { sha256File } from "../util/hash.ts";
import { handoffPath } from "../util/paths.ts";
import { ATTRIBUTION_PATTERNS, checkCommitNeutrality } from "../verify/commits.ts";
import { changedPaths, commitMessages } from "../verify/git.ts";
import { chatLogPath } from "../util/paths.ts";
import { ChatLogEntry } from "../domain/chat-log.ts";
import { buildFallbackCommitMessage, runTurn } from "./turn.ts";

async function chatLogEntriesOnDisk(dir: string, chatLogId: string): Promise<ChatLogEntry[]> {
  let text: string;
  try {
    text = await readFile(chatLogPath(dir, chatLogId), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => ChatLogEntry.parse(JSON.parse(l)));
}

const GIT_TIMEOUT_MS = 120_000;

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

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/osa-turn-test-`);
  await initRepo(dir);
  return dir;
}

/**
 * Writes **and commits** OSA's three canonical loopr artifacts (`baby_prd.md`,
 * `context.md`, and a spec file matching `baseReq()`'s own `specRef.path`/`babyPrdPath`/
 * `contextPath` defaults), returning their `FileRef`s plus the resulting HEAD, so a test can
 * populate a draft's `artifacts_read` with entries that survive ground-truth reconciliation
 * (PHASE_4_SPEC.md §6.1: `assertLooprArtifactsReferenced()` only accepts a *reconciled* record's
 * `artifacts_read`, and a reconciled entry only survives if its path resolves).
 *
 * The commit is load-bearing, and was not always: `artifacts_read` is now reconciled against the
 * turn's *starting commit* rather than end-of-turn disk (`src/dispatch/record.ts`), so a loopr
 * artifact merely present as an uncommitted working-tree file does not resolve at `headBefore` and
 * is dropped. Committing them is also what a real run always looks like -- the loopr artifacts are
 * tracked repository files the operator points the run at, produced by earlier phases.
 */
async function writeLooprArtifacts(
  dir: string,
): Promise<{ babyPrd: FileRef; context: FileRef; spec: FileRef; head: string }> {
  await writeFile(`${dir}/baby_prd.md`, "baby prd content\n", "utf8");
  await writeFile(`${dir}/context.md`, "context content\n", "utf8");
  await writeFile(`${dir}/PHASE_1_SPEC.md`, "spec content\n", "utf8");
  await git(dir, ["add", "baby_prd.md", "context.md", "PHASE_1_SPEC.md"]);
  await git(dir, ["commit", "--quiet", "-m", "add the run's loopr artifacts"]);
  return {
    babyPrd: { path: "baby_prd.md", sha256: await sha256File(`${dir}/baby_prd.md`) },
    context: { path: "context.md", sha256: await sha256File(`${dir}/context.md`) },
    spec: { path: "PHASE_1_SPEC.md", sha256: await sha256File(`${dir}/PHASE_1_SPEC.md`) },
    head: (await git(dir, ["rev-parse", "HEAD"])).trim(),
  };
}

class FakeAdapter implements ProviderAdapter {
  readonly id = "claude-code" as const;
  preflight(): Promise<PreflightReport> {
    throw new Error("not used in this test");
  }
  resolveEffort(): string {
    return "low";
  }
  buildInvocation(req: TurnRequest): Invocation {
    return { command: "fake-cli", args: ["--noop"], env: {}, cwd: req.repoDir, stdin: req.prompt };
  }
  interpretResult(raw: RawInvocationResult): TurnOutcome {
    if (raw.exitCode !== 0) {
      return { ok: false, record: null, failure: new InternalError("fake-cli failed") };
    }
    return { ok: true, record: null, failure: null };
  }
}

function baseReq(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    runId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    phase: 1,
    turnIndex: 0,
    archetype: "executor",
    provider: "claude-code",
    tier: "high-volume-low-effort",
    modelOverride: null,
    repoDir: "unused",
    specRef: { path: "PHASE_1_SPEC.md", sha256: "9".repeat(64) },
    priorRecord: null,
    prompt: "do the work",
    timeoutMs: 30_000,
    babyPrdPath: "baby_prd.md",
    contextPath: "context.md",
    expectedArtifactPath: null,
    chatLogId: "run-1",
    chatLogGitignored: true,
    ...overrides,
  };
}

function draftFor(
  req: TurnRequest,
  repo: HandoffRecord["repo"],
  overrides: { readonly artifactsRead?: readonly FileRef[]; readonly artifactsWritten?: readonly FileRef[] } = {},
): HandoffRecord {
  return {
    schema_version: 1,
    run_id: req.runId,
    phase: req.phase,
    turn_index: req.turnIndex,
    role: "executor",
    provider: "claude-code",
    model_tier: req.tier,
    started_at: "2026-08-16T10:00:00Z",
    completed_at: "2026-08-16T10:05:00Z",
    repo,
    spec_ref: { path: "WRONG.md", sha256: "0".repeat(64) },
    artifacts_read: overrides.artifactsRead ? [...overrides.artifactsRead] : [],
    artifacts_written: overrides.artifactsWritten ? [...overrides.artifactsWritten] : [],
    status: "completed",
    work_done: "did work",
    next_steps: [],
    open_questions: [],
    halt: null,
  };
}

test("runTurn: happy path reconciles and persists the record, overwriting the agent's own (wrong) draft", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const artifacts = await writeLooprArtifacts(dir);
    const req = baseReq({ repoDir: dir });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      // Simulate the dispatched agent: make a real commit, then write a deliberately-wrong draft.
      await commitFile(dir, "foo.txt", "v1\n", "agent's turn");
      await writeHandoffRecord(
        path,
        draftFor(
          req,
          { branch: "wrong-branch", head_before: "1".repeat(40), head_after: "2".repeat(40), commits: ["2".repeat(40)] },
          { artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec] },
        ),
      );
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });

    assert.equal(result.outcome.ok, true);
    assert.ok(result.record !== null);
    assert.equal(result.record?.repo.branch, "main");
    // The turn starts from the loopr-artifacts commit, which is the real HEAD by the time runTurn
    // captures ground truth (the artifacts must be committed to be attestable as read at all).
    assert.notEqual(artifacts.head, commit0);
    assert.equal(result.record?.repo.head_before, artifacts.head);
    assert.notEqual(result.record?.repo.head_after, "2".repeat(40));
    assert.deepStrictEqual(result.record?.spec_ref, req.specRef);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: an adapter-reported failure short-circuits before reading any on-disk record", async () => {
  const dir = await freshRepo();
  try {
    await commitFile(dir, "foo.txt", "v0\n", "initial");
    const req = baseReq({ repoDir: dir });
    const fakeRunProcess: typeof runProcess = async () => ({
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "boom",
      durationMs: 1,
      timedOut: false,
    });

    const result = await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });

    assert.equal(result.outcome.ok, false);
    assert.equal(result.record, null);
    assert.ok(result.outcome.failure instanceof InternalError);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: a malformed on-disk record is converted into a modelled failure (RelaySchemaError), not thrown", async () => {
  const dir = await freshRepo();
  try {
    await commitFile(dir, "foo.txt", "v0\n", "initial");
    const req = baseReq({ repoDir: dir });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      await mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true });
      await writeFile(path, "not valid json{{{", "utf8");
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });

    assert.equal(result.outcome.ok, false);
    assert.equal(result.outcome.failure?.code, "RELAY_SCHEMA_INVALID");
    assert.equal(result.record, null);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: an on-disk record carrying a transcript-shaped key is converted into a modelled failure (IsolationLeakError), not thrown", async () => {
  // §8 acceptance criterion #21 requires a dedicated test proving IsolationLeakError (like
  // RelaySchemaError) never triggers a retry -- both are caught in the same runTurn branch (step
  // 6) and converted into an `outcome.ok: false` result, the uniform shape run-loop.ts's own
  // single "no retry on !outcome.ok" branch handles identically regardless of error subtype.
  const dir = await freshRepo();
  try {
    await commitFile(dir, "foo.txt", "v0\n", "initial");
    const req = baseReq({ repoDir: dir });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      await mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true });
      // A minimal object carrying a forbidden (transcript-shaped) key -- assertNoTranscriptFields
      // rejects this before schema_version/shape are ever checked.
      await writeFile(path, JSON.stringify({ schema_version: 1, reasoning: "leaked chain of thought" }), "utf8");
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });

    assert.equal(result.outcome.ok, false);
    assert.ok(result.outcome.failure instanceof IsolationLeakError);
    assert.equal(result.record, null);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: ground-truth reconciliation rejecting the record (R3: completed with zero real commits) is converted into a modelled failure (RelaySchemaError), not thrown", async () => {
  // The reconciliation-time counterpart to the read-time RelaySchemaError test above -- §6.4 step
  // 7's own catch clause, distinct from step 6's. §8 acceptance criterion #21 groups both under
  // "a RelaySchemaError/IsolationLeakError from record read or reconciliation".
  const dir = await freshRepo();
  try {
    await commitFile(dir, "foo.txt", "v0\n", "initial");
    const req = baseReq({ repoDir: dir });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      // The agent claims status: "completed" but makes no real commit -- ground truth will show
      // zero commits between headBefore and HEAD, violating R3 once reconciliation applies it.
      await writeHandoffRecord(
        path,
        draftFor(req, { branch: "main", head_before: "0".repeat(40), head_after: "1".repeat(40), commits: ["1".repeat(40)] }),
      );
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });

    assert.equal(result.outcome.ok, false);
    assert.ok(result.outcome.failure instanceof RelaySchemaError);
    assert.equal(result.record, null);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: a commit carrying an AI-attribution trailer propagates BoundaryViolationError unmodified, uncaught, with zero retry attempted internally", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const artifacts = await writeLooprArtifacts(dir);
    const req = baseReq({ repoDir: dir });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      await writeFile(`${dir}/bar.txt`, "bar\n", "utf8");
      await git(dir, ["add", "bar.txt"]);
      await git(dir, ["commit", "--quiet", "-m", "dirty commit\n\nCo-Authored-By: Claude <noreply@anthropic.com>"]);
      const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
      await writeHandoffRecord(
        path,
        draftFor(
          req,
          { branch: "main", head_before: commit0, head_after: head, commits: [head] },
          { artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec] },
        ),
      );
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    await assert.rejects(
      () => runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess }),
      (err: unknown) => {
        assert.ok(err instanceof BoundaryViolationError);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: the environment passed to runProcessFn is {...process.env-with-undefined-dropped, ...invocation.env}", async () => {
  const dir = await freshRepo();
  try {
    await commitFile(dir, "foo.txt", "v0\n", "initial");
    process.env["OSA_TEST_AMBIENT"] = "ambient-value";
    let capturedEnv: Readonly<Record<string, string>> | undefined;
    const req = baseReq({ repoDir: dir });
    const fakeRunProcess: typeof runProcess = async (o) => {
      capturedEnv = o.env;
      return { exitCode: 1, signal: null, stdout: "", stderr: "boom", durationMs: 1, timedOut: false };
    };

    await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });

    assert.equal(capturedEnv?.["OSA_TEST_AMBIENT"], "ambient-value");
  } finally {
    delete process.env["OSA_TEST_AMBIENT"];
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: timeoutMs passes straight through to runProcessFn, unmodified", async () => {
  const dir = await freshRepo();
  try {
    await commitFile(dir, "foo.txt", "v0\n", "initial");
    let capturedTimeout: number | undefined;
    const req = baseReq({ repoDir: dir, timeoutMs: 123456 });
    const fakeRunProcess: typeof runProcess = async (o) => {
      capturedTimeout = o.timeoutMs;
      return { exitCode: 1, signal: null, stdout: "", stderr: "boom", durationMs: 1, timedOut: false };
    };

    await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });

    assert.equal(capturedTimeout, 123456);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// -------------------------------------------------------------------------------------------
// PHASE_4_SPEC.md §6.3 -- the two new artifact guards (§8 acceptance criteria #13-15, #19, #21, #22)
// -------------------------------------------------------------------------------------------

test("runTurn: an executor turn whose reconciled artifacts_read never references baby_prd_path/context_path/spec_path propagates LooprArtifactBypassError unmodified, uncaught -- the guard is not skipped for an executor slot", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    // Deliberately do NOT call writeLooprArtifacts/populate artifacts_read -- the agent worked the
    // repo but never genuinely referenced loopr's own canonical artifacts.
    const req = baseReq({ repoDir: dir, archetype: "executor" });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      await commitFile(dir, "foo.txt", "v1\n", "agent's turn");
      const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
      await writeHandoffRecord(path, draftFor(req, { branch: "main", head_before: commit0, head_after: head, commits: [head] }));
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    await assert.rejects(
      () => runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess }),
      (err: unknown) => {
        assert.ok(err instanceof LooprArtifactBypassError);
        assert.equal(err.exitCode, 12);
        assert.ok(err.message.includes("baby_prd_path"));
        assert.ok(err.message.includes("context_path"));
        assert.ok(err.message.includes("spec_path"));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: the same bypass on a reviewer turn also propagates LooprArtifactBypassError -- the guard is archetype-agnostic, not skipped for the reviewer slot either", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const req = baseReq({ repoDir: dir, archetype: "reviewer", expectedArtifactPath: null });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      await commitFile(dir, "foo.txt", "v1\n", "reviewer's turn");
      const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
      await writeHandoffRecord(path, draftFor(req, { branch: "main", head_before: commit0, head_after: head, commits: [head] }));
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    await assert.rejects(
      () => runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess }),
      (err: unknown) => {
        assert.ok(err instanceof LooprArtifactBypassError);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: assertNextPhaseSpecProduced is never invoked for an executor request (expectedArtifactPath === null) -- a reviewer-only next-artifact path is never even checked to exist", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const artifacts = await writeLooprArtifacts(dir);
    // expectedArtifactPath stays null (baseReq's default) -- an executor slot never has one.
    const req = baseReq({ repoDir: dir, archetype: "executor" });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      // This turn's commits never touch "PHASE_2_SPEC.md" -- if assertNextPhaseSpecProduced were
      // (incorrectly) invoked for this executor request, it would throw. It must not be.
      await commitFile(dir, "foo.txt", "v1\n", "executor's turn");
      const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
      await writeHandoffRecord(
        path,
        draftFor(
          req,
          { branch: "main", head_before: commit0, head_after: head, commits: [head] },
          { artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec] },
        ),
      );
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });

    assert.equal(result.outcome.ok, true);
    assert.ok(result.record !== null);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: when either new guard throws, writeHandoffRecord is never called for that turn -- the would-be-bypassed record is not persisted at handoffPath()", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const req = baseReq({ repoDir: dir });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      await commitFile(dir, "foo.txt", "v1\n", "agent's turn");
      const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
      // Deliberately omits artifacts_read entirely -- assertLooprArtifactsReferenced must throw
      // before the reconciled record (which the agent's own draft here is a stand-in for, since
      // reconciliation only replaces repo/spec_ref/artifact hashes) is ever persisted again.
      await writeHandoffRecord(path, draftFor(req, { branch: "main", head_before: commit0, head_after: head, commits: [head] }));
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    await assert.rejects(() => runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess }));

    // The on-disk record still holds the agent's own pre-reconciliation draft (never overwritten),
    // proving writeHandoffRecord (step 9) never re-ran after the guard's throw at step 7.5.
    const onDisk = await readFile(path, "utf8");
    const parsed = JSON.parse(onDisk) as { readonly spec_ref: { readonly path: string } };
    assert.equal(parsed.spec_ref.path, "WRONG.md");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// -------------------------------------------------------------------------------------------
// Step 5.5 -- OSA's own fallback commit for a turn whose agent could not commit itself.
// Empirically motivated: codex-cli under `--sandbox workspace-write` on Windows cannot write to
// `.git/` at all (`fatal: Unable to create '<repo>/.git/index.lock': Permission denied`), so the
// fixture below models exactly that -- a turn that writes real files and never commits.
// -------------------------------------------------------------------------------------------

test("runTurn: a turn that leaves uncommitted changes gets them committed by OSA, and reconciles to commits.length >= 1", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const artifacts = await writeLooprArtifacts(dir);
    const req = baseReq({ repoDir: dir });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      // The sandboxed-agent shape: real work lands on disk across all three change kinds, and not
      // a single `git` write happens -- no add, no commit.
      await writeFile(`${dir}/foo.txt`, "v1 modified by the agent\n", "utf8"); // tracked, unstaged
      await writeFile(`${dir}/brand-new.txt`, "created by the agent\n", "utf8"); // untracked
      await writeHandoffRecord(
        path,
        draftFor(
          req,
          // The agent honestly reports no commits, because it genuinely made none.
          { branch: "main", head_before: commit0, head_after: commit0, commits: [] },
          { artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec] },
        ),
      );
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });

    assert.equal(result.outcome.ok, true);
    assert.ok(result.record !== null);
    // R3 is now genuinely satisfiable: reconciliation, which reads HEAD itself at call time, sees
    // the fallback commit because step 5.5 ran before it.
    assert.equal(result.record?.repo.commits.length, 1);
    assert.equal(result.record?.repo.head_before, artifacts.head);
    assert.notEqual(result.record?.repo.head_after, artifacts.head);
    assert.equal(result.record?.status, "completed");

    // Both kinds of leftover really made it into that one commit.
    const touched = [...(await changedPaths(dir, commit0, result.record?.repo.head_after ?? ""))].sort();
    assert.deepStrictEqual(touched, ["baby_prd.md", "brand-new.txt", "context.md", "foo.txt", "PHASE_1_SPEC.md"].sort());

    // And the tree it left behind is clean apart from OSA's own bookkeeping.
    assert.equal((await git(dir, ["status", "--short", "--", ":(top)", ":(exclude,top).osa"])).trim(), "");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: the fallback commit's message is neutral and carries the turn's identifying metadata", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const artifacts = await writeLooprArtifacts(dir);
    const req = baseReq({ repoDir: dir, provider: "codex-cli", archetype: "reviewer", phase: 3, turnIndex: 2 });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      await writeFile(`${dir}/work.txt`, "uncommitted work\n", "utf8");
      await writeHandoffRecord(
        path,
        draftFor(
          req,
          { branch: "main", head_before: commit0, head_after: commit0, commits: [] },
          { artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec] },
        ),
      );
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });
    const oids = [...(result.record?.repo.commits ?? [])];
    assert.equal(oids.length, 1);

    // Neutral by the very check step 8 applies (assertNeutralCommits already ran without throwing
    // inside runTurn; this asserts the underlying verdict explicitly rather than by absence).
    const neutrality = await checkCommitNeutrality(dir, oids);
    assert.equal(neutrality.clean, true, JSON.stringify(neutrality.offenders));

    const [message] = await commitMessages(dir, oids);
    assert.ok(message !== undefined);
    assert.match(message, /^chore: capture a dispatched turn's uncommitted working-tree changes\n/);
    assert.ok(message.includes(`run-id: ${req.runId}`));
    assert.ok(message.includes("phase: 3"));
    assert.ok(message.includes("turn-index: 2"));
    assert.ok(message.includes("provider: codex-cli"));
    assert.ok(message.includes("archetype: reviewer"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("buildFallbackCommitMessage is neutral by construction, for every provider/archetype combination", () => {
  // The message never passes through a model, so its neutrality is a property of the source. This
  // asserts that directly against the same ATTRIBUTION_PATTERNS assertNeutralCommits enforces,
  // rather than relying on one sampled commit in the integration tests above.
  for (const provider of ["claude-code", "codex-cli"] as const) {
    for (const archetype of ["executor", "reviewer"] as const) {
      const message = buildFallbackCommitMessage(baseReq({ provider, archetype }));
      for (const pattern of ATTRIBUTION_PATTERNS) {
        assert.equal(pattern.test(message), false, `${provider}/${archetype} matched ${pattern.source}`);
      }
    }
  }
});

test("runTurn: a turn that genuinely changes nothing still reconciles to commits.length === 0 -- the fallback does not manufacture a commit", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    // Loopr's three artifacts are committed by the helper (not merely written), so that writing the
    // handoff record is the *only* thing that touches the tree during the turn -- and that lives
    // under .osa/, which step 5.5 excludes. A genuinely idle turn must stay at zero commits.
    const base = (await writeLooprArtifacts(dir)).head;
    assert.notEqual(base, commit0);

    const req = baseReq({ repoDir: dir });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      await writeHandoffRecord(
        path,
        draftFor(req, { branch: "main", head_before: base, head_after: base, commits: [] }),
      );
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    // Zero commits + status "completed" is still an R3 violation, and must still be refused --
    // proof no commit was fabricated to paper over an idle turn.
    const result = await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });
    assert.equal(result.outcome.ok, false);
    assert.ok(result.outcome.failure instanceof RelaySchemaError);
    assert.equal((await git(dir, ["rev-parse", "HEAD"])).trim(), base);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

let chatLogIdCounter = 0;
function nextChatLogId(): string {
  chatLogIdCounter += 1;
  return `3fa85f64-5717-4562-b3fc-2c963f66a${String(chatLogIdCounter).padStart(3, "0")}`;
}

// Implements PHASE_10_SPEC.md §7.2 FM15, §1.2 (M7) -- a halted/failed/rejected turn's chat-log
// entry pair is still written, with its real content, above every return in runTurn.

test("runTurn: a failed (adapter-reported) turn still logs a complete prompt+response entry pair with real content", async () => {
  const dir = await freshRepo();
  try {
    await commitFile(dir, "foo.txt", "v0\n", "initial");
    const req = baseReq({ repoDir: dir, chatLogId: nextChatLogId() });
    const fakeRunProcess: typeof runProcess = async () => ({
      exitCode: 1,
      signal: null,
      stdout: "real stdout for the failed turn",
      stderr: "real stderr for the failed turn",
      durationMs: 7,
      timedOut: false,
    });

    const result = await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });
    assert.equal(result.outcome.ok, false);

    const entries = await chatLogEntriesOnDisk(dir, req.chatLogId);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.entry_kind, "prompt");
    assert.equal(entries[0]?.transcript.prompt, req.prompt);
    assert.equal(entries[1]?.entry_kind, "response");
    assert.equal(entries[1]?.transcript.stdout, "real stdout for the failed turn");
    assert.equal(entries[1]?.transcript.stderr, "real stderr for the failed turn");
    assert.equal(entries[1]?.outcome?.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: a timed-out turn still logs a complete pair with outcome.timed_out === true", async () => {
  const dir = await freshRepo();
  try {
    await commitFile(dir, "foo.txt", "v0\n", "initial");
    const req = baseReq({ repoDir: dir, chatLogId: nextChatLogId() });
    const fakeRunProcess: typeof runProcess = async () => ({
      exitCode: null,
      signal: "SIGTERM",
      stdout: "partial output before timeout",
      stderr: "",
      durationMs: req.timeoutMs,
      timedOut: true,
    });

    await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });

    const entries = await chatLogEntriesOnDisk(dir, req.chatLogId);
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.outcome?.timed_out, true);
    assert.equal(entries[1]?.transcript.stdout, "partial output before timeout");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: a halted turn's chat-log pair is written with its real content, above the return", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const artifacts = await writeLooprArtifacts(dir);
    const req = baseReq({ repoDir: dir, chatLogId: nextChatLogId() });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      await commitFile(dir, "foo.txt", "v1\n", "agent's turn");
      const draft = draftFor(
        req,
        { branch: "main", head_before: commit0, head_after: commit0, commits: [] },
        { artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec] },
      );
      await writeHandoffRecord(path, {
        ...draft,
        status: "halted",
        halt: { code: "SOME_HALT_CODE", message: "the agent halted itself" },
      });
      return { exitCode: 0, signal: null, stdout: "halted-turn stdout", stderr: "", durationMs: 3, timedOut: false };
    };

    const result = await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });
    assert.equal(result.outcome.ok, true);
    assert.equal(result.record?.status, "halted");

    const entries = await chatLogEntriesOnDisk(dir, req.chatLogId);
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.transcript.stdout, "halted-turn stdout");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: every return path carries chatLogWarnings ([] when nothing went wrong)", async () => {
  const dir = await freshRepo();
  try {
    await commitFile(dir, "foo.txt", "v0\n", "initial");
    const req = baseReq({ repoDir: dir, chatLogId: nextChatLogId() });
    const fakeRunProcess: typeof runProcess = async () => ({
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "boom",
      durationMs: 1,
      timedOut: false,
    });
    const result = await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });
    assert.deepEqual(result.chatLogWarnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runTurn: the fallback runs unconditionally -- a turn reporting status blocked still has its working-tree work captured", async () => {
  const dir = await freshRepo();
  try {
    const commit0 = await commitFile(dir, "foo.txt", "v0\n", "initial");
    const artifacts = await writeLooprArtifacts(dir);
    const req = baseReq({ repoDir: dir });
    const path = handoffPath(dir, req.runId, req.phase, req.turnIndex, req.archetype, req.provider);

    const fakeRunProcess: typeof runProcess = async () => {
      await writeFile(`${dir}/partial.txt`, "half-finished but real\n", "utf8");
      const draft = draftFor(
        req,
        { branch: "main", head_before: commit0, head_after: commit0, commits: [] },
        { artifactsRead: [artifacts.babyPrd, artifacts.context, artifacts.spec] },
      );
      // status "blocked": R3 does not apply, so nothing forces a commit -- yet the work must not
      // be silently dropped either. Step 5.5 runs before the record is even read, so the record's
      // own claimed status cannot influence whether the capture happens.
      await writeHandoffRecord(path, { ...draft, status: "blocked" });
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const result = await runTurn(req, { adapter: new FakeAdapter(), runProcessFn: fakeRunProcess });

    assert.equal(result.outcome.ok, true);
    assert.equal(result.record?.status, "blocked");
    assert.equal(result.record?.repo.commits.length, 1);
    assert.ok((await changedPaths(dir, commit0, result.record?.repo.head_after ?? "")).includes("partial.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
