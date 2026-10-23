import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { TextCall } from "../ports/text-provider.ts";
import { mergeRewrite, queryTerms } from "./query-terms.ts";
import { buildRewritePrompt, makeRewriter, parseRewrite, tableRewriter } from "./rewrite.ts";

const reply = (text: string): TextCall => () => Promise.resolve({ provider: "claude-code", outcome: { ok: true, text, failure: null }, durationMs: 1 });

test("parseRewrite: keeps safe identifiers and keywords, drops unsafe or oversized terms, caps the lists, and returns null when nothing usable remains", () => {
  const r = parseRewrite(`Here you go: ${JSON.stringify({ identifiers: ["realpathSync", "isEntryPoint", "bad term", "x", "ok_name", "../etc/passwd;rm", "a".repeat(80)], keywords: ["symlink", "Symlink", "argv", 5, "link"] })}`);
  assert.deepEqual(r?.identifiers, ["realpathSync", "isEntryPoint", "ok_name"], "spaces, one-character terms, shell-ish text and long terms are dropped");
  assert.deepEqual(r?.keywords, ["symlink", "argv", "link"], "case-insensitive duplicates and non-strings are dropped");
  const many = parseRewrite(JSON.stringify({ identifiers: Array.from({ length: 20 }, (_, i) => `name${String(i)}`), keywords: [] }));
  assert.equal(many?.identifiers.length, 8);
  assert.equal(parseRewrite('{"identifiers": [], "keywords": []}'), null);
  assert.equal(parseRewrite("no json here"), null);
  assert.equal(parseRewrite('{"identifiers": "notalist"}'), null);
});

test("buildRewritePrompt: asks for JSON identifiers and keywords, includes the language and the file paths when given, and the question last", () => {
  const p = buildRewritePrompt("where is the cache?", { language: "Python", paths: ["app/cache.py", "tests/test_cache.py"] });
  assert.match(p, /ONE JSON object/);
  assert.match(p, /mostly Python/);
  assert.match(p, /app\/cache\.py\ntests\/test_cache\.py/);
  assert.ok(p.trimEnd().endsWith("where is the cache?"));
  assert.doesNotMatch(buildRewritePrompt("q"), /File paths in the project/);
});

test("mergeRewrite: the rewrite's terms come first and the question's own terms stay behind them; fragments are the question's", () => {
  const base = queryTerms("which function stops a command from silently doing nothing through a symbolic link");
  const m = mergeRewrite(base, { identifiers: ["isEntryPoint", "realpathSync"], keywords: ["Symlink", "argv"] });
  assert.deepEqual(m.identifiers.slice(0, 2), ["isEntryPoint", "realpathSync"]);
  assert.deepEqual(m.words.slice(0, 2), ["symlink", "argv"]);
  assert.ok(m.words.includes("silently"), "the question's own words are still searched");
  assert.equal(m.fragments, base.fragments);
});

test("makeRewriter: one model call per question, cached in memory and on disk; a failed call is not cached; a useless reply is cached as nothing", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-rewrite-`);
  const cacheFile = `${dir}/rw.json`;
  let calls = 0;
  const models: (string | null)[] = [];
  const textCall: TextCall = (_p, req) => {
    calls++;
    models.push(req.modelOverride);
    return reply('{"identifiers": ["fooBar"], "keywords": ["foo"]}')(_p, req, "query-rewrite");
  };
  const mk = (tc: TextCall) => makeRewriter({ textCall: tc, provider: "claude-code", model: "small-model", cwd: ".", timeoutMs: 1000, cacheFile });
  const rw = mk(textCall);
  assert.deepEqual(await rw("how does foo work?"), { identifiers: ["fooBar"], keywords: ["foo"] });
  await rw("how does foo work?");
  assert.equal(calls, 1, "the second ask is served from memory");
  assert.deepEqual(models, ["small-model"]);
  const again = mk(textCall);
  await again("how does foo work?");
  assert.equal(calls, 1, "a new rewriter reads the disk cache");
  assert.match(await readFile(cacheFile, "utf8"), /fooBar/);
  const down: TextCall = () => Promise.resolve({ provider: "claude-code", outcome: { ok: false, text: null, failure: null }, durationMs: 1 });
  assert.equal(await mk(down)("question one"), null, "an unavailable model means the search runs unchanged");
  assert.deepEqual(await mk(textCall)("question one"), { identifiers: ["fooBar"], keywords: ["foo"] }, "the failed ask was not cached, so it is tried again");
  assert.equal(await mk(reply("sorry, no json"))("question two"), null, "a reply with no usable term gives no rewrite");
  const before = calls;
  assert.equal(await mk(textCall)("question two"), null, "and that is remembered: the model is not asked again");
  assert.equal(calls, before);
  const throws: TextCall = () => Promise.reject(new Error("boom"));
  assert.equal(await mk(throws)("yet another"), null, "never throws");
});

test("tableRewriter: a precomputed table answers known questions and returns null for unknown ones", async () => {
  const rw = tableRewriter({ q1: { identifiers: ["a1"], keywords: [] } });
  assert.deepEqual(await rw("q1"), { identifiers: ["a1"], keywords: [] });
  assert.equal(await rw("q2"), null);
});
