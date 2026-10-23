import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { UsageError } from "../domain/errors.ts";
import { parseArgs } from "./main.ts";

const argv = (...a: string[]): string[] => ["node", "osa", ...a];

test("osa \"<prompt>\" parses as the one-shot command with defaults", () => {
  const c = parseArgs(argv("build me a word counter"));
  assert.equal(c.kind, "osa");
  if (c.kind !== "osa") return;
  assert.equal(c.prompt, "build me a word counter");
  assert.equal(c.yes, false);
  assert.equal(c.json, false);
  assert.deepEqual(c.files, []);
  assert.equal(c.repoDir, resolve(process.cwd()));
});

test("unquoted multi-word prompts are joined; flags may appear anywhere", () => {
  const c = parseArgs(argv("--yes", "build", "a", "thing", "--file", "a.md", "--file", "b.md", "--repo-dir", ".", "--json"));
  assert.equal(c.kind, "osa");
  if (c.kind !== "osa") return;
  assert.equal(c.prompt, "build a thing");
  assert.equal(c.yes, true);
  assert.equal(c.json, true);
  assert.deepEqual(c.files, ["a.md", "b.md"]);
});

test("a single whitespace-free token stays an unknown-command usage error (a mistyped command must not become a prompt)", () => {
  assert.throws(() => parseArgs(argv("doctr")), (e: unknown) => e instanceof UsageError && /Unknown command/.test(e.message));
  assert.throws(() => parseArgs(argv("bogus", "--yes")), UsageError);
});

test("an unknown flag, or a flag missing its value, is a usage error", () => {
  assert.throws(() => parseArgs(argv("build a thing", "--bogus")), (e: unknown) => e instanceof UsageError && /Unknown flag/.test(e.message));
  assert.throws(() => parseArgs(argv("build a thing", "--file")), UsageError);
});

test("existing commands still win over the prompt form", () => {
  assert.equal(parseArgs(argv("doctor")).kind, "doctor");
  assert.equal(parseArgs(argv("--version")).kind, "version");
  assert.equal(parseArgs(argv()).kind, "help");
});

test("--spec-only turns the build off; the default builds", () => {
  const spec = parseArgs(argv("build a thing", "--spec-only"));
  const full = parseArgs(argv("build a thing"));
  assert.equal(spec.kind === "osa" && spec.build, false);
  assert.equal(full.kind === "osa" && full.build, true);
});
