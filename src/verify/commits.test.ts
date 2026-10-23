// Implements PHASE_1_SPEC.md §1.6 -- commits.test.ts
// Covers §8 acceptance criterion #27. Uses real git commits in a temp repo, built via the
// sanctioned `runProcess` (this file never imports node:child_process directly).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BoundaryViolationError } from "../domain/errors.ts";
import { runProcess } from "../util/exec.ts";
import { assertNeutralCommits, ATTRIBUTION_PATTERNS, checkCommitNeutrality } from "./commits.ts";

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

async function commitWithMessage(dir: string, message: string): Promise<string> {
  await writeFile(`${dir}/file-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`, "content\n", "utf8");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "--quiet", "-m", message]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/osa-commits-test-`);
  await initRepo(dir);
  return dir;
}

test("checkCommitNeutrality passes a clean commit message", async () => {
  const dir = await freshRepo();
  try {
    const oid = await commitWithMessage(dir, "feat: implement the relay schema");
    const result = await checkCommitNeutrality(dir, [oid]);
    assert.equal(result.clean, true);
    assert.deepStrictEqual(result.offenders, []);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("checkCommitNeutrality flags a commit carrying a Co-Authored-By: Claude trailer", async () => {
  const dir = await freshRepo();
  try {
    const trailer = ["", "Co-Authored-By: Claude <noreply@anthropic.com>"].join("\n");
    const oid = await commitWithMessage(dir, `feat: add a thing${trailer}`);
    const result = await checkCommitNeutrality(dir, [oid]);
    assert.equal(result.clean, false);
    assert.equal(result.offenders.length, 1);
    assert.equal(result.offenders[0]?.oid, oid);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("checkCommitNeutrality flags a Codex-style attribution trailer", async () => {
  const dir = await freshRepo();
  try {
    const trailer = ["", "Co-authored-by: Codex <codex@openai.com>"].join("\n");
    const oid = await commitWithMessage(dir, `fix: correct a bug${trailer}`);
    const result = await checkCommitNeutrality(dir, [oid]);
    assert.equal(result.clean, false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('checkCommitNeutrality flags the "Generated with" forms for both providers', async () => {
  const dir = await freshRepo();
  try {
    const oid1 = await commitWithMessage(dir, "feat: a\n\nGenerated with Claude Code");
    const oid2 = await commitWithMessage(dir, "feat: b\n\nGenerated with Codex");
    const result = await checkCommitNeutrality(dir, [oid1, oid2]);
    assert.equal(result.clean, false);
    assert.equal(result.offenders.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("checkCommitNeutrality evaluates a mixed range and reports only the offending oid", async () => {
  const dir = await freshRepo();
  try {
    const clean = await commitWithMessage(dir, "chore: tidy up");
    const dirty = await commitWithMessage(dir, "feat: c\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    const result = await checkCommitNeutrality(dir, [clean, dirty]);
    assert.equal(result.clean, false);
    assert.deepStrictEqual(
      result.offenders.map((o) => o.oid),
      [dirty],
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("assertNeutralCommits resolves for a clean commit and rejects (BoundaryViolationError, exit 7) for a dirty one", async () => {
  const dir = await freshRepo();
  try {
    const clean = await commitWithMessage(dir, "docs: update readme");
    await assert.doesNotReject(() => assertNeutralCommits(dir, [clean]));

    const dirty = await commitWithMessage(dir, "feat: d\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    await assert.rejects(
      () => assertNeutralCommits(dir, [dirty]),
      (err: unknown) => {
        assert.ok(err instanceof BoundaryViolationError);
        assert.equal(err.exitCode, 7);
        assert.ok(err.message.includes(dirty));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("ATTRIBUTION_PATTERNS covers at minimum the five documented forms", () => {
  const samples = [
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "Co-authored-by: Codex <codex@openai.com>",
    "Generated with Claude Code",
    "Generated with [Claude Code]",
    "Generated with Codex",
    "🤖 Generated with OSA",
  ];
  for (const sample of samples) {
    assert.ok(
      ATTRIBUTION_PATTERNS.some((p) => p.test(sample)),
      `expected some pattern to match "${sample}"`,
    );
  }
});
