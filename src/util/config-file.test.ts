import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { UsageError } from "../domain/errors.ts";
import { loadOsaConfig } from "./config-file.ts";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(`${tmpdir()}/osa-config-test-`);
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadOsaConfig: no file -> defaults, source null, no warnings", async () => {
  await withDir(async (dir) => {
    const r = await loadOsaConfig(dir);
    assert.equal(r.source, null);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.config.research.academic, true);
  });
});

test("loadOsaConfig: osa.config.json is read", async () => {
  await withDir(async (dir) => {
    await writeFile(`${dir}/osa.config.json`, JSON.stringify({ research: { academic: false } }));
    const r = await loadOsaConfig(dir);
    assert.equal(r.source, "osa.config.json");
    assert.equal(r.config.research.academic, false);
    assert.deepEqual(r.warnings, []);
  });
});

test("loadOsaConfig: invalid JSON and invalid shape are UsageErrors", async () => {
  await withDir(async (dir) => {
    await writeFile(`${dir}/osa.config.json`, "{ not json");
    await assert.rejects(loadOsaConfig(dir), UsageError);
    await writeFile(`${dir}/osa.config.json`, JSON.stringify({ trim: { engine: "gzip" } }));
    await assert.rejects(loadOsaConfig(dir), UsageError);
  });
});
