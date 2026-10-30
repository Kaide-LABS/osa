import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { projectDependencyWarnings } from "./project-deps.ts";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(`${tmpdir()}/osa-deps-test-`);
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("projectDependencyWarnings: no package.json -> no warning", async () => {
  await withDir(async (dir) => {
    assert.deepEqual(projectDependencyWarnings(dir), []);
  });
});

test("projectDependencyWarnings: package.json with no dependencies -> no warning", async () => {
  await withDir(async (dir) => {
    await writeFile(`${dir}/package.json`, JSON.stringify({ name: "x", dependencies: {} }), "utf8");
    assert.deepEqual(projectDependencyWarnings(dir), []);
  });
});

test("projectDependencyWarnings: dependencies listed and node_modules missing -> one warning naming the directory", async () => {
  await withDir(async (dir) => {
    await writeFile(`${dir}/package.json`, JSON.stringify({ name: "x", devDependencies: { vitest: "^1.0.0" } }), "utf8");
    const warnings = projectDependencyWarnings(dir);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]?.includes("node_modules is missing"));
    assert.ok(warnings[0]?.includes(dir));
  });
});

test("projectDependencyWarnings: dependencies listed and node_modules present -> no warning", async () => {
  await withDir(async (dir) => {
    await writeFile(`${dir}/package.json`, JSON.stringify({ name: "x", dependencies: { zod: "^4.0.0" } }), "utf8");
    await mkdir(`${dir}/node_modules`);
    assert.deepEqual(projectDependencyWarnings(dir), []);
  });
});

test("projectDependencyWarnings: an unreadable package.json -> no warning (doctor must not crash on it)", async () => {
  await withDir(async (dir) => {
    await writeFile(`${dir}/package.json`, "{ not json", "utf8");
    assert.deepEqual(projectDependencyWarnings(dir), []);
  });
});
