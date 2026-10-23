// Suite 7c -- the files the spec discipline depends on MUST be indexed and retrievable, even when .gitignore hides them, and the files that
// must never be indexed (secrets) must not be, even when they sit inside a spec directory. The prior CBM spike found spec artifacts were
// silently excluded through gitignore matching; the lexical index had the same hole plus a hard exclusion of .osa/ and .osa/.
// The artifact list below is taken from the path builders in the code (runDirRel, specDirRel, step14DirRel, researchDirRel, prdLockRecordPath,
// eventsPath, handoffPath, driverLogPath, MEMORY_DIR_REL), not guessed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tempGitRepo } from "../osa/fixtures.test.ts";
import { isSecretPath, isSpecArtifact, listSpecArtifacts } from "./spec-artifacts.ts";
import { updateIndex } from "./indexer.ts";
import { clearSearchCache, searchIndex } from "./search.ts";
import { readRawIndex } from "./store.ts";

const RUN = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const DISPATCH = "d1d2d3d4-d5d6-4d7d-8d9d-d0d1d2d3d4d5";

/** [repo-relative path, a unique token inside it, text]. Every kind of spec artifact the code writes. */
const ARTIFACTS: [string, string, string][] = [
  [`runs/${RUN}/baby-prd.md`, "zqprdalpha", "# Baby PRD\nThe locked requirement zqprdalpha: count words."],
  [`runs/${RUN}/research/outline.yaml`, "zqoutlinebeta", "topic: zqoutlinebeta\nitems: []\n"],
  [`runs/${RUN}/research/fields.yaml`, "zqfieldsgamma", "fields:\n  - name: zqfieldsgamma\n"],
  [`runs/${RUN}/research/report.md`, "zqreportdelta", "# Research report\nFinding zqreportdelta about tokenisation."],
  [`runs/${RUN}/research/results/docs-node.json`, "zqresultepsilon", '{"summary":"zqresultepsilon documented behaviour"}'],
  [`runs/${RUN}/spec/context.md`, "zqcontextzeta", "# Context\nStack choice zqcontextzeta."],
  [`runs/${RUN}/spec/PHASE_1_SPEC.md`, "zqspecphaseeta", "# Phase 1\nBuild zqspecphaseeta in Part A."],
  [`runs/${RUN}/step14/executor-context.md`, "zqexecctxtheta", "Turn rules and zqexecctxtheta."],
  [`runs/${RUN}/step14/phase-1-handoff.md`, "zqhandoffiota", "# Handoff\nWork done zqhandoffiota."],
  [`runs/${RUN}/step14/phase-1-summary.md`, "zqsummarykappa", "## What was built\nzqsummarykappa"],
  [`runs/${RUN}/application/report.md`, "zqapplambda", "# Application check\nzqapplambda passed."],
  [`runs/${RUN}/application/evidence.json`, "zqevidencemu", '{"criteria":[{"id":"AC1","summary":"zqevidencemu"}]}'],
  [`runs/${RUN}/summary.md`, "zqrunsummarynu", "# Run summary\nzqrunsummarynu"],
  [`.osa/runs/${RUN}/prd.lock.json`, "zqlockxi", '{"run_id":"zqlockxi","sha256":"abc"}'],
  [`.osa/runs/${RUN}/events.jsonl`, "zqeventsomicron", '{"event":"run_started","data":{"note":"zqeventsomicron"}}\n'],
  [`.osa/runs/${DISPATCH}/driver-log.jsonl`, "zqdriverpi", '{"phase":1,"note":"zqdriverpi"}\n'],
  [`.osa/runs/${DISPATCH}/handoff/1/000-executor-claude-code.json`, "zqrelayrho", '{"work_done":"zqrelayrho"}'],
  [`.osa/memory/decisions.md`, "zqmemorysigma", "- 2026-10-17: decision zqmemorysigma"],
  [`docs/osa/CONFLICTS.md`, "zqconflictstau", "# Conflicts\nC-99 zqconflictstau"],
  [`PHASE_2_SPEC.md`, "zqlegacyspecupsilon", "# Phase 2\nzqlegacyspecupsilon"],
  [`COMPREHENSION.md`, "zqcomprehphi", "# Comprehension\nzqcomprehphi"],
  [`BUILD_COMPLETE.md`, "zqbuilddonechi", "Build complete zqbuilddonechi"],
];

/** Files that must NEVER be indexed -- including ones placed inside spec directories. */
const SECRETS: [string, string][] = [
  [".env", "zqsecretenv1"],
  [".env.local", "zqsecretenv2"],
  [`runs/${RUN}/research/results/server.pem`, "zqsecretpem3"],
  [`.osa/runs/${RUN}/credentials.json`, "zqsecretcred4"],
  [`runs/${RUN}/spec/id_rsa`, "zqsecretrsa5"],
  [".npmrc", "zqsecretnpm6"],
  [`docs/osa/secrets.yaml`, "zqsecretyaml7"],
  [`.osa/memory/service-account.json`, "zqsecretsvc8"],
];

async function fixture() {
  const repoDir = await tempGitRepo();
  // gitignore hides everything the spec discipline depends on
  await writeFile(`${repoDir}/.gitignore`, [".osa/", ".osa/", "runs/", "docs/osa/", "PHASE_*_SPEC.md", "COMPREHENSION.md", "BUILD_COMPLETE.md", ".env*", ".npmrc"].join("\n") + "\n", "utf8");
  await writeFile(`${repoDir}/src.ts`, "export function ordinaryCode() { return 'zqordinary'; }\n", "utf8");
  for (const [path, , text] of ARTIFACTS) {
    await mkdir(`${repoDir}/${path.slice(0, path.lastIndexOf("/") === -1 ? 0 : path.lastIndexOf("/"))}`, { recursive: true });
    await writeFile(`${repoDir}/${path}`, text, "utf8");
  }
  for (const [path, token] of SECRETS) {
    await mkdir(`${repoDir}/${path.slice(0, path.lastIndexOf("/") === -1 ? 0 : path.lastIndexOf("/"))}`, { recursive: true });
    await writeFile(`${repoDir}/${path}`, `API_SECRET=${token}\n`, "utf8");
  }
  execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  return repoDir;
}

test("isSpecArtifact recognises every path the code writes; ordinary source and chat transcripts are not spec artifacts", () => {
  for (const [path] of ARTIFACTS) assert.equal(isSpecArtifact(path), true, path);
  for (const p of ["src/osa/pipeline.ts", "README.md", "package.json", ".osa/chat-log/abc.jsonl", ".osa/index/chunks.jsonl", ".osa/run.lock", "node_modules/x/README.md"]) {
    assert.equal(isSpecArtifact(p), false, p);
  }
});

test("isSecretPath refuses .env files, keys, certificates, credential stores and cloud config -- anywhere, including inside spec directories", () => {
  for (const [path] of SECRETS) assert.equal(isSecretPath(path), true, path);
  for (const p of [".env.production", "config/.env", "keys/server.key", "certs/ca.pfx", "~/.aws/credentials", ".ssh/id_ed25519", "deploy/terraform.tfstate", "gcp-service-account.json", "secrets.json", "db/secrets.toml", ".netrc", "docker/.dockercfg"]) {
    assert.equal(isSecretPath(p), true, p);
  }
  for (const p of ["src/secrets-filter.ts", "docs/osa/CONFLICTS.md", "src/memory/secrets.ts", "README.md", "runs/x/spec/PHASE_1_SPEC.md", "environment.md", "src/env.ts"]) assert.equal(isSecretPath(p), false, p);
});

test("listSpecArtifacts walks the real directories (even when gitignored) and never returns a secret or a chat transcript", async () => {
  const repoDir = await fixture();
  await mkdir(`${repoDir}/.osa/chat-log`, { recursive: true });
  await writeFile(`${repoDir}/.osa/chat-log/x.jsonl`, '{"role":"user"}\n', "utf8");
  const found = new Set(await listSpecArtifacts(repoDir));
  for (const [path] of ARTIFACTS) assert.ok(found.has(path), `missing from the list: ${path}`);
  for (const [path] of SECRETS) assert.ok(!found.has(path), `secret listed: ${path}`);
  assert.ok(![...found].some((p) => p.includes("chat-log")));
});

test("EVERY spec artifact is in the lexical index and retrievable by a word inside it -- although .gitignore hides it -- and no secret is", async () => {
  const repoDir = await fixture();
  clearSearchCache();
  const r = await updateIndex({ repoDir });
  assert.ok(r.files >= ARTIFACTS.length, `indexed ${String(r.files)} files`);
  const meta = (await readRawIndex(repoDir)).meta;
  const indexed = new Set(Object.keys(meta?.files ?? {}));
  for (const [path, token] of ARTIFACTS) {
    assert.ok(indexed.has(path), `not indexed: ${path}`);
    const hits = await searchIndex(repoDir, token, { k: 3 });
    assert.ok(hits.some((h) => h.path === path), `${path} not retrievable by "${token}"; got ${hits.map((h) => h.path).join(", ")}`);
  }
  for (const [path, token] of SECRETS) {
    assert.ok(!indexed.has(path), `secret indexed: ${path}`);
    assert.equal((await searchIndex(repoDir, token, { k: 3 })).length, 0, `secret token "${token}" is searchable`);
  }
  assert.ok(indexed.has("src.ts"), "ordinary source still indexed");
});

test("a spec artifact edited after indexing is re-indexed incrementally; a deleted one drops out", async () => {
  const repoDir = await fixture();
  clearSearchCache();
  await updateIndex({ repoDir });
  const path = `runs/${RUN}/spec/PHASE_1_SPEC.md`;
  await writeFile(`${repoDir}/${path}`, "# Phase 1\nNow it says zqeditedmarker instead.\n", "utf8");
  const r = await updateIndex({ repoDir });
  assert.equal(r.changed, 1);
  clearSearchCache();
  assert.ok((await searchIndex(repoDir, "zqeditedmarker", { k: 3 })).some((h) => h.path === path));
  assert.equal((await searchIndex(repoDir, "zqspecphaseeta", { k: 3 })).filter((h) => h.path === path).length, 0, "the old text is gone");
});
