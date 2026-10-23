import { test } from "node:test";
import assert from "node:assert/strict";
import { loose, queryTerms } from "./query-terms.ts";

test("identifiers are kept as written; words are lowercase content words, longest first, stop words gone", () => {
  const t = queryTerms("what calls assertPrdUnchanged in src/osa/lock.ts and sha256_file?");
  assert.deepEqual([...t.identifiers].sort(), ["assertPrdUnchanged", "src/osa/lock.ts", "sha256_file"].sort());
  assert.ok(t.words.includes("assert") && t.words.includes("unchanged") && t.words.includes("lock"));
  assert.ok(!t.words.includes("what") && !t.words.includes("the") && !t.words.includes("calls"));
  assert.deepEqual([...t.words].sort(), [...new Set(t.words)].sort(), "no duplicates");
  assert.ok(t.words.indexOf("unchanged") < t.words.indexOf("lock"), "longest first");
});

test("a paraphrase has no identifiers and keeps its content words", () => {
  const t = queryTerms("make sure the AI coding assistant is actually signed in before we start work");
  assert.deepEqual(t.identifiers, []);
  for (const w of ["assistant", "signed", "coding"]) assert.ok(t.words.includes(w), w);
  assert.ok(!t.words.includes("sure") && !t.words.includes("actually"));
});

test("camelCase and snake_case pieces become fragments for symbol/path agreement", () => {
  const t = queryTerms("checkProviderAuth and parse_codex_result");
  for (const f of ["check", "provider", "auth", "parse", "codex", "result"]) assert.ok(t.fragments.has(f), f);
});

test("empty and punctuation-only queries yield nothing; quotes and brackets are stripped", () => {
  assert.deepEqual(queryTerms("  ?!  ").words, []);
  assert.deepEqual(queryTerms('"lockNow" (the function)').identifiers, ["lockNow"]);
});

test("loose() merges plural, -ing and -ed forms", () => {
  assert.equal(loose("hashing"), loose("hash"));
  assert.equal(loose("assumptions"), loose("assumption"));
  assert.equal(loose("locked"), loose("lock"));
  assert.notEqual(loose("pass"), loose("pas"));
});
