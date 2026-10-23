import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { tempGitRepo } from "../../osa/fixtures.test.ts";
import { shadowDirOf, shadowId, shadowIncludes, staleAgainstManifest, syncShadow } from "./shadow.ts";

const RUN = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

async function fixture() {
  const repoDir = await tempGitRepo();
  await mkdir(`${repoDir}/src`, { recursive: true });
  await mkdir(`${repoDir}/runs/${RUN}/spec`, { recursive: true });
  await mkdir(`${repoDir}/.osa/runs/${RUN}`, { recursive: true });
  await writeFile(`${repoDir}/.gitignore`, "runs/\n.osa/\n.env\nbig.txt\n", "utf8");
  await writeFile(`${repoDir}/src/app.ts`, "export const app = 1;\n", "utf8");
  await writeFile(`${repoDir}/runs/${RUN}/spec/PHASE_1_SPEC.md`, "# Phase 1\n", "utf8");
  await writeFile(`${repoDir}/.osa/runs/${RUN}/prd.lock.json`, '{"run_id":"x"}', "utf8");
  await writeFile(`${repoDir}/.env`, "SECRET=1\n", "utf8");
  await writeFile(`${repoDir}/src/server.pem`, "-----BEGIN-----\n", "utf8");
  await writeFile(`${repoDir}/big.txt`, "x".repeat(10), "utf8");
  await writeFile(`${repoDir}/src/blob.ts`, "binary\0data", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  return repoDir;
}
const listAll = async (dir: string, rel = ""): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await readdir(`${dir}/${rel}`, { withFileTypes: true })) {
    const p = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listAll(dir, p)));
    else out.push(p);
  }
  return out.sort();
};

test("shadowId is stable per repository path and distinct between repositories", () => {
  const BS = String.fromCharCode(92);
  assert.equal(shadowId("C:/a/proj"), shadowId(`C:${BS}a${BS}proj${BS}`));
  assert.notEqual(shadowId("C:/a/proj"), shadowId("C:/b/proj"));
  assert.match(shadowId("C:/a/my proj!"), /^my_proj_-[0-9a-f]{8}$/);
});

test("shadowIncludes: code and spec artifacts yes; secrets, ignore files and unindexable types no", () => {
  for (const p of ["src/app.ts", "README.md", "runs/x/spec/PHASE_1_SPEC.md", ".osa/runs/x/prd.lock.json", ".osa/memory/decisions.md"]) assert.equal(shadowIncludes(p), true, p);
  for (const p of [".gitignore", "sub/.gitignore", ".cbmignore", ".env", "src/server.pem", "logo.png", "node_modules/x/index.js", ".osa/chat-log/a.jsonl", "package-lock.json"]) assert.equal(shadowIncludes(p), false, p);
});

test("the shadow mirrors code AND gitignored spec artifacts, and NEVER secrets, ignore files, binaries or the repository itself", async () => {
  const repoDir = await fixture();
  const work = await mkdtemp(`${tmpdir()}/osa-shadow-`);
  const r = await syncShadow(repoDir, work);
  // The shadow keeps its OWN private git history (snapshots, for CBM's detect_changes); that .git is not a mirrored file and is checked separately.
  const files = (await listAll(shadowDirOf(work, repoDir))).filter((f) => !f.startsWith(".git/"));
  assert.deepEqual(files, [`.osa/runs/${RUN}/prd.lock.json`, "README.md", `runs/${RUN}/spec/PHASE_1_SPEC.md`, "src/app.ts"]);
  const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: shadowDirOf(work, repoDir), encoding: "utf8" }).split(/\r?\n/).filter((l) => l !== "").sort();
  assert.deepEqual(tracked, files, "the snapshot repository holds exactly the mirrored files: no secret, no ignore file, nothing of the user's .git");
  assert.equal(typeof r.snapshot.head, "string");
  assert.equal(r.snapshot.previous, null, "the first sync is the first snapshot");
  assert.equal(r.copied, 4);
  assert.equal(r.files, 4);
  assert.equal(await readFile(`${shadowDirOf(work, repoDir)}/src/app.ts`, "utf8"), "export const app = 1;\n");
  // nothing was written into the repository
  assert.ok(!(await readdir(repoDir)).some((f) => f.includes("shadow")));
});

test("incremental: an unchanged tree copies nothing; an edit copies one file; a deletion removes it and prunes empty directories", async () => {
  const repoDir = await fixture();
  const work = await mkdtemp(`${tmpdir()}/osa-shadow-`);
  await syncShadow(repoDir, work);
  const again = await syncShadow(repoDir, work);
  assert.deepEqual([again.copied, again.removed, again.unchanged], [0, 0, 4]);

  await writeFile(`${repoDir}/src/app.ts`, "export const app = 2;\n", "utf8");
  const edit = await syncShadow(repoDir, work);
  assert.deepEqual([edit.copied, edit.removed], [1, 0]);
  assert.deepEqual(edit.changedPaths, ["src/app.ts"]);
  assert.equal(await readFile(`${shadowDirOf(work, repoDir)}/src/app.ts`, "utf8"), "export const app = 2;\n");

  await rm(`${repoDir}/runs/${RUN}`, { recursive: true });
  const del = await syncShadow(repoDir, work);
  assert.equal(del.removed, 1);
  await assert.rejects(stat(`${shadowDirOf(work, repoDir)}/runs`), "the emptied runs/ directory was pruned");
});

test("staleAgainstManifest: a live edit is stale, a touch without a content change is not, a file the shadow never held is stale, a deletion is stale", async () => {
  const repoDir = await fixture();
  const work = await mkdtemp(`${tmpdir()}/osa-shadow-`);
  const r = await syncShadow(repoDir, work);
  assert.deepEqual(await staleAgainstManifest(repoDir, r.manifest, ["src/app.ts"]), []);
  const later = new Date(Date.now() + 5000);
  await utimes(`${repoDir}/src/app.ts`, later, later);
  assert.deepEqual(await staleAgainstManifest(repoDir, r.manifest, ["src/app.ts"]), [], "same content, new mtime: not stale");
  await writeFile(`${repoDir}/src/app.ts`, "export const app = 3;\n", "utf8");
  assert.deepEqual(await staleAgainstManifest(repoDir, r.manifest, ["src/app.ts"]), ["src/app.ts"]);
  assert.deepEqual(await staleAgainstManifest(repoDir, r.manifest, ["src/never-mirrored.ts"]), ["src/never-mirrored.ts"]);
  await rm(`${repoDir}/runs/${RUN}/spec/PHASE_1_SPEC.md`);
  assert.deepEqual(await staleAgainstManifest(repoDir, r.manifest, [`runs/${RUN}/spec/PHASE_1_SPEC.md`]), [`runs/${RUN}/spec/PHASE_1_SPEC.md`]);
});

test("snapshots: an unchanged sync adds no commit; an edit adds one and reports the previous snapshot; a git failure means null snapshots, never an error", async () => {
  const repoDir = await fixture();
  const work = await mkdtemp(`${tmpdir()}/osa-shadow-`);
  const first = await syncShadow(repoDir, work);
  const same = await syncShadow(repoDir, work);
  assert.equal(same.snapshot.head, first.snapshot.head, "nothing changed: no new commit");
  await writeFile(`${repoDir}/src/app.ts`, "export const app = 3;\n", "utf8");
  const edit = await syncShadow(repoDir, work);
  assert.notEqual(edit.snapshot.head, first.snapshot.head);
  assert.equal(edit.snapshot.previous, first.snapshot.head, "the previous snapshot is the one before the edit");
  const none = await syncShadow(repoDir, `${work}-nogit`, { spawn: () => Promise.resolve({ exitCode: 1, signal: null, stdout: "", stderr: "git: not found", durationMs: 1, timedOut: false }) });
  assert.deepEqual(none.snapshot, { head: null, previous: null });
});
