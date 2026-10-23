// `osa evidence` / the MCP `evidence` tool must be able to independently verify AC3 for an OSA-built project, whose
// locked PRD lives at runs/<id>/baby-prd.md (not beside the spec as baby_prd.md). Found by running the MCP evidence tool
// against the first complete live run: AC1, AC2 and production passed, but AC3's reference check reported a false failure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { HandoffRecord } from "../domain/relay.ts";
import { writeHandoffRecord } from "../domain/relay.ts";
import { tempGitRepo } from "../osa/fixtures.test.ts";
import { assessAcceptanceEvidence, resolveOsaPrdPath } from "./acceptance.ts";

const OSA_RUN = "776a3355-c5d5-4422-b86a-08694164695e";
const DISPATCH_RUN = "d9d74da4-2cd3-48ad-acb2-5554a047de2b";
const sha = (c: string): string => c.repeat(64);

async function osaBuiltRepo(): Promise<{ repoDir: string; prd: string; ctx: string; spec: string }> {
  const repoDir = await tempGitRepo();
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: repoDir }).toString().trim();
  const prd = `runs/${OSA_RUN}/baby-prd.md`;
  const ctx = `runs/${OSA_RUN}/spec/context.md`;
  const spec = `runs/${OSA_RUN}/spec/PHASE_1_SPEC.md`;
  await mkdir(`${repoDir}/runs/${OSA_RUN}/spec`, { recursive: true });
  for (const p of [prd, ctx, spec]) await writeFile(`${repoDir}/${p}`, `content of ${p}\n`, "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "plan");
  const c1 = git("rev-parse", "HEAD");
  await writeFile(`${repoDir}/code.js`, "x\n", "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "code");
  const c2 = git("rev-parse", "HEAD");
  await writeFile(`${repoDir}/BUILD_COMPLETE.md`, "done\n", "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "done");
  const c3 = git("rev-parse", "HEAD");

  const dir = `${repoDir}/.osa/runs/${DISPATCH_RUN}/handoff/1`;
  const base = (over: Partial<HandoffRecord>): HandoffRecord => ({
    schema_version: 1,
    run_id: DISPATCH_RUN,
    phase: 1,
    turn_index: 0,
    role: "executor",
    provider: "claude-code",
    model_tier: "high-volume-low-effort",
    started_at: "2026-10-17T10:00:00Z",
    completed_at: "2026-10-17T10:05:00Z",
    repo: { branch: "main", head_before: c1, head_after: c2, commits: [c2] },
    spec_ref: { path: spec, sha256: sha("a") },
    artifacts_read: [prd, ctx, spec].map((path) => ({ path, sha256: sha("b") })),
    artifacts_written: [],
    status: "completed",
    work_done: "did work",
    next_steps: [],
    open_questions: [],
    halt: null,
    ...over,
  });
  await writeHandoffRecord(`${dir}/000-executor-claude-code.json`, base({}));
  await writeHandoffRecord(`${dir}/001-executor-codex-cli.json`, base({ turn_index: 1, provider: "codex-cli", repo: { branch: "main", head_before: c2, head_after: c2, commits: [c2] } }));
  await writeHandoffRecord(
    `${dir}/002-reviewer-claude-code.json`,
    base({ turn_index: 2, role: "reviewer", repo: { branch: "main", head_before: c2, head_after: c3, commits: [c3] }, artifacts_written: [{ path: "BUILD_COMPLETE.md", sha256: sha("c") }] }),
  );
  return { repoDir, prd, ctx, spec };
}

test("resolveOsaPrdPath: reads the locked PRD path from the OSA lock record; null for non-OSA specs or a missing record", async () => {
  const { repoDir, prd, spec } = await osaBuiltRepo();
  assert.equal(await resolveOsaPrdPath(repoDir, spec), null, "no lock record yet");
  await mkdir(`${repoDir}/.osa/runs/${OSA_RUN}`, { recursive: true });
  await writeFile(`${repoDir}/.osa/runs/${OSA_RUN}/prd.lock.json`, JSON.stringify({ schema_version: 1, run_id: OSA_RUN, prd_path: prd, sha256: sha("d"), locked_at: "x" }), "utf8");
  assert.equal(await resolveOsaPrdPath(repoDir, spec), prd);
  assert.equal(await resolveOsaPrdPath(repoDir, "PHASE_1_SPEC.md"), null);
  assert.equal(await resolveOsaPrdPath(repoDir, "docs/specs/PHASE_1_SPEC.md"), null);
  await writeFile(`${repoDir}/.osa/runs/${OSA_RUN}/prd.lock.json`, "{ not json", "utf8");
  assert.equal(await resolveOsaPrdPath(repoDir, spec), null, "a corrupt record falls back instead of throwing");
});

test("AC3 for an OSA-built project: with the lock record the locked PRD is found and the references check passes", async () => {
  const { repoDir, prd } = await osaBuiltRepo();
  await mkdir(`${repoDir}/.osa/runs/${OSA_RUN}`, { recursive: true });
  await writeFile(`${repoDir}/.osa/runs/${OSA_RUN}/prd.lock.json`, JSON.stringify({ schema_version: 1, run_id: OSA_RUN, prd_path: prd, sha256: sha("d"), locked_at: "x" }), "utf8");
  const ev = await assessAcceptanceEvidence(repoDir, DISPATCH_RUN, true);
  assert.equal(ev.turnsFound, 3);
  assert.equal(ev.ac3.satisfied, true, ev.ac3.detail);
  assert.ok(ev.ac3.references.every((r) => r.artifactsReferenced));
  assert.equal(ev.ac3.production?.satisfied, true);
});

test("without a lock record the old loopr convention still applies (and still reports the missing baby_prd.md) -- non-OSA behaviour is unchanged", async () => {
  const { repoDir } = await osaBuiltRepo();
  const ev = await assessAcceptanceEvidence(repoDir, DISPATCH_RUN, true);
  assert.equal(ev.ac3.satisfied, false);
  assert.deepEqual(ev.ac3.references[0]?.missingArtifactPaths, [`runs/${OSA_RUN}/spec/baby_prd.md`]);
  await rm(repoDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
