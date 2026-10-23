// Implements PHASE_8_SPEC.md §7 FM-M5
// Tests writeTempConfigFile()'s round-trip and cleanup guarantees.

import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { writeTempConfigFile } from "./temp-config.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("writeTempConfigFile writes valid JSON a reader can re-parse byte-for-byte", async () => {
  const config = { foo: "bar", nested: { n: 1 }, arr: [1, 2, 3] };
  const { configPath, cleanup } = await writeTempConfigFile(config);
  try {
    assert.equal(await exists(configPath), true);
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(configPath, "utf8");
    assert.deepStrictEqual(JSON.parse(raw), config);
  } finally {
    await cleanup();
  }
});

test("cleanup removes the whole temp directory", async () => {
  const { configPath, cleanup } = await writeTempConfigFile({ a: 1 });
  const tempDir = dirname(configPath);
  assert.equal(await exists(tempDir), true);
  await cleanup();
  assert.equal(await exists(tempDir), false);
  assert.equal(await exists(configPath), false);
});

test("cleanup is safe to call even if the caller's own subsequent step throws first", async () => {
  const { configPath, cleanup } = await writeTempConfigFile({ a: 1 });
  const tempDir = dirname(configPath);
  try {
    try {
      throw new Error("simulated downstream failure");
    } finally {
      await cleanup();
    }
  } catch (err) {
    assert.match((err as Error).message, /simulated downstream failure/);
  }
  assert.equal(await exists(tempDir), false);
});
