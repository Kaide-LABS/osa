import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseGrepCounts, probeTerms } from "./grep-probe.ts";

test("parseGrepCounts reads path:count lines, including paths with colons and drive letters, and ignores junk", () => {
  assert.deepEqual(parseGrepCounts("src/a.ts:3\nsrc/b.ts:1\n\nnot a row\nC:/x/y.ts:2\n"), [{ file: "src/a.ts", count: 3 }, { file: "src/b.ts", count: 1 }, { file: "C:/x/y.ts", count: 2 }]);
});

async function tree() {
  const dir = await mkdtemp(`${tmpdir()}/osa-probe-`);
  await mkdir(`${dir}/src`, { recursive: true });
  await writeFile(`${dir}/src/lock.ts`, "export function lockNow() { return hashPrd(); }\nfunction hashPrd() {}\n", "utf8");
  await writeFile(`${dir}/src/hash.ts`, "// hash helpers\nexport function sha256String() {}\n", "utf8");
  await writeFile(`${dir}/README.md`, "Locking and hashing notes.\n", "utf8");
  return dir;
}

test("probeTerms ranks files by distinct terms matched, then match count, case-insensitively and on substrings, in a directory that is not a repository", async () => {
  const dir = await tree();
  const r = await probeTerms(dir, ["hash", "prd", "lock", "nonexistentzzz"]);
  assert.equal(r.available, true);
  assert.equal(r.files[0]?.file, "src/lock.ts");
  assert.deepEqual([...(r.files[0]?.terms ?? [])].sort(), ["hash", "lock", "prd"]);
  assert.equal(r.files[0]?.distinct, 3);
  assert.ok(r.files.some((f) => f.file === "src/hash.ts"));
  assert.equal(r.coverage, 0.75, "three of the four terms occur somewhere");
});

test("a query whose words occur nowhere has coverage 0 -- the signal that an engine's confident hit is a coincidence", async () => {
  const dir = await tree();
  const r = await probeTerms(dir, ["zzzzqqqq", "wwwwxxxx"]);
  assert.equal(r.coverage, 0);
  assert.deepEqual(r.files, []);
  assert.equal(r.available, true);
});

test("no terms means an empty, available result; a git failure is reported as unavailable, not as a disagreement", async () => {
  const dir = await tree();
  assert.deepEqual(await probeTerms(dir, []), { files: [], coverage: 0, termsTried: 0, available: true });
  const broken = await probeTerms(dir, ["lock"], { spawn: () => Promise.resolve({ exitCode: 128, signal: null, stdout: "", stderr: "fatal", durationMs: 1, timedOut: false }) });
  assert.equal(broken.available, false);
  assert.equal(broken.coverage, 0);
});

test("only the first maxTerms (default 6) distinct terms are probed", async () => {
  const dir = await tree();
  const seen: string[] = [];
  await probeTerms(dir, ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a7"], { spawn: (o) => { seen.push(o.args[o.args.indexOf("-e") + 1] as string); return Promise.resolve({ exitCode: 1, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false }); } });
  assert.deepEqual(seen.sort(), ["a1", "a2", "a3", "a4", "a5", "a6"]);
});

test("REGRESSION (first eval run): the index's own storage, dependency/build output and chat transcripts are never probed -- the index file contains every word of the codebase and used to be the top 'match' for every query", async () => {
  const dir = await tree();
  await mkdir(`${dir}/.osa/index`, { recursive: true });
  await mkdir(`${dir}/node_modules/dep`, { recursive: true });
  await mkdir(`${dir}/.osa/chat-log`, { recursive: true });
  const everything = "lockNow hashPrd sha256String lock hash prd\n".repeat(50);
  await writeFile(`${dir}/.osa/index/chunks.jsonl`, everything, "utf8");
  await writeFile(`${dir}/node_modules/dep/index.js`, everything, "utf8");
  await writeFile(`${dir}/.osa/chat-log/a.jsonl`, everything, "utf8");
  const r = await probeTerms(dir, ["hash", "prd", "lock"]);
  assert.equal(r.files[0]?.file, "src/lock.ts");
  assert.ok(!r.files.some((f) => /^(?:\.osa|node_modules|\.osa)\//.test(f.file)), r.files.map((f) => f.file).join(", "));
});
