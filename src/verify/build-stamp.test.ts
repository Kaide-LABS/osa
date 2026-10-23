import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runDoctor } from "../cli/doctor.ts";
import { checkBuildFreshness, computeSourceHash, packageRoot, readBuildStamp, writeBuildStamp } from "./build-stamp.ts";

async function fakePackage(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/osa-stamp-`);
  await mkdir(`${root}/src/a`, { recursive: true });
  await mkdir(`${root}/dist`, { recursive: true });
  await writeFile(`${root}/src/a/one.ts`, "export const one = 1;\n", "utf8");
  await writeFile(`${root}/src/two.ts`, "export const two = 2;\n", "utf8");
  await writeFile(`${root}/tsconfig.json`, "{}\n", "utf8");
  await writeFile(`${root}/tsconfig.build.json`, "{}\n", "utf8");
  return root;
}

test("a dist/ built from the current src/ is fresh", async () => {
  const root = await fakePackage();
  assert.equal(checkBuildFreshness({ root, startupStamp: null, runningFromDist: false }).status, "missing");
  writeBuildStamp(root);
  const f = checkBuildFreshness({ root, startupStamp: null, runningFromDist: false });
  assert.equal(f.status, "fresh");
  assert.equal(f.source_hash, f.dist_hash);
});

test("the staleness warning FIRES: editing, adding or removing a source file after the build makes dist/ stale", async () => {
  const root = await fakePackage();
  writeBuildStamp(root);
  const check = () => checkBuildFreshness({ root, startupStamp: null, runningFromDist: false });
  await writeFile(`${root}/src/two.ts`, "export const two = 22;\n", "utf8");
  assert.equal(check().status, "stale");
  assert.match(check().detail, /npm run build/);
  writeBuildStamp(root);
  assert.equal(check().status, "fresh");
  await writeFile(`${root}/src/three.ts`, "export const three = 3;\n", "utf8");
  assert.equal(check().status, "stale");
  writeBuildStamp(root);
  await writeFile(`${root}/tsconfig.build.json`, '{"changed":true}\n', "utf8");
  assert.equal(check().status, "stale", "a compiler-config change also invalidates the build");
});

test("tests and line endings do not affect the hash (tests are not compiled; CRLF checkouts are the same build)", async () => {
  const root = await fakePackage();
  const before = computeSourceHash(root);
  await writeFile(`${root}/src/two.test.ts`, "test('x')\n", "utf8");
  assert.equal(computeSourceHash(root).hash, before.hash);
  await writeFile(`${root}/src/two.ts`, "export const two = 2;\r\n", "utf8");
  assert.equal(computeSourceHash(root).hash, before.hash);
});

test("a RUNNING process that started from an older build is flagged even though dist/ now matches src/", async () => {
  const root = await fakePackage();
  const old = writeBuildStamp(root);
  await writeFile(`${root}/src/two.ts`, "export const two = 3;\n", "utf8");
  writeBuildStamp(root); // rebuilt, but the server process is still the old one
  const f = checkBuildFreshness({ root, startupStamp: old, runningFromDist: true });
  assert.equal(f.status, "process-stale");
  assert.match(f.detail, /restart/);
  assert.equal(checkBuildFreshness({ root, startupStamp: readBuildStamp(root), runningFromDist: true }).status, "fresh");
});

test("a packaged install (no src/) is not-applicable, never a warning", async () => {
  const root = await mkdtemp(`${tmpdir()}/osa-stamp-pkg-`);
  await mkdir(`${root}/dist`, { recursive: true });
  assert.equal(checkBuildFreshness({ root, startupStamp: null, runningFromDist: true }).status, "not-applicable");
});

test("doctor reports the build, surfaces a stale one as a WARNING, and a warning does not flip ok or the exit code", async () => {
  const root = await mkdtemp(`${tmpdir()}/osa-doctor-build-`);
  const stale = { status: "stale" as const, detail: "dist/ is older than src/", source_hash: "a", dist_hash: "b" };
  const r = await runDoctor(root, { json: true, only: "boundary" }, { buildCheck: () => stale });
  assert.equal(r.report.build?.status, "stale");
  assert.deepEqual(r.report.warnings, ["Build is stale: dist/ is older than src/"]);
  assert.equal(r.report.ok, true);
  assert.equal(r.exitCode, 0);
  const fresh = await runDoctor(root, { json: true, only: "boundary" }, { buildCheck: () => ({ status: "fresh", detail: "ok", source_hash: "a", dist_hash: "a" }) });
  assert.equal(fresh.report.warnings, undefined);
  const providersOnly = await runDoctor(root, { json: true, only: "providers" }, { buildCheck: () => stale });
  assert.equal(providersOnly.report.build, undefined, "the build check belongs to the boundary/all modes");
});

test("the real repository: the stamp, when present, parses and the checker never throws", () => {
  const f = checkBuildFreshness({ root: packageRoot(), startupStamp: null, runningFromDist: false });
  assert.ok(["fresh", "stale", "missing"].includes(f.status));
});
