import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { isEntryPoint } from "./entry.ts";

test("isEntryPoint: the file itself, the same file reached through a link, another file and no argv are told apart", () => {
  const dir = mkdtempSync(join(tmpdir(), "osa-entry-"));
  try {
    const real = join(dir, "real");
    const link = join(dir, "link");
    mkdirSync(real);
    writeFileSync(join(real, "main.js"), "");
    writeFileSync(join(real, "other.js"), "");
    symlinkSync(real, link, "junction"); // a junction needs no privilege on Windows
    const url = pathToFileURL(join(real, "main.js")).href;
    assert.equal(isEntryPoint(url, join(real, "main.js")), true, "the real path");
    assert.equal(isEntryPoint(url, join(link, "main.js")), true, "through a link (npm link): the case that used to exit silently");
    assert.equal(isEntryPoint(url, join(link, "other.js")), false, "another file");
    assert.equal(isEntryPoint(url, undefined), false, "no argv[1]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
