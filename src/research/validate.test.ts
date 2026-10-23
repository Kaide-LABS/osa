import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMON_FIELDS, DOCS_FIELDS } from "./outline.ts";
import { validateItemResult } from "./validate.ts";

const good = () => ({
  summary: "It works like this.",
  key_findings: ["finding one"],
  recommendations: ["do this"],
  as_of: "2026-10-01",
  sources: [{ title: "Docs", url: "https://example.org/docs", type: "official-docs", quote: "q" }],
  uncertain: [] as string[],
});

test("a complete result validates", () => {
  const v = validateItemResult(good(), COMMON_FIELDS);
  assert.deepEqual(v, { valid: true, missing: [], problems: [] });
});

test("validator rejects incomplete JSON: every missing required field is named (WS3.5 test 2)", () => {
  const { summary, sources, ...rest } = good();
  void summary;
  void sources;
  const v = validateItemResult(rest, COMMON_FIELDS);
  assert.equal(v.valid, false);
  assert.deepEqual([...v.missing].sort(), ["sources", "summary"]);
  assert.ok(v.problems.some((p) => p.includes('"summary"')));
});

test("empty strings, empty required arrays and a non-object are all rejected", () => {
  assert.equal(validateItemResult({ ...good(), summary: "   " }, COMMON_FIELDS).valid, false);
  assert.equal(validateItemResult({ ...good(), key_findings: [] }, COMMON_FIELDS).valid, false);
  assert.equal(validateItemResult({ ...good(), sources: [] }, COMMON_FIELDS).valid, false);
  assert.equal(validateItemResult("nope", COMMON_FIELDS).valid, false);
  assert.equal(validateItemResult([], COMMON_FIELDS).valid, false);
  assert.equal(validateItemResult({ ...good(), sources: [{ title: "x", url: "ftp://nope", type: "other" }] }, COMMON_FIELDS).valid, false);
});

test("the uncertain array is required, and [uncertain] markers must be listed in it (and only real fields listed)", () => {
  const { uncertain, ...noUncertain } = good();
  void uncertain;
  const missing = validateItemResult(noUncertain, COMMON_FIELDS);
  assert.equal(missing.valid, false);
  assert.ok(missing.missing.includes("uncertain"));

  const marked = { ...good(), summary: "Probably 5.2 [uncertain]" };
  const unlisted = validateItemResult(marked, COMMON_FIELDS);
  assert.equal(unlisted.valid, false);
  assert.ok(unlisted.problems.some((p) => /contains \[uncertain\] but is not listed/.test(p)));

  assert.equal(validateItemResult({ ...marked, uncertain: ["summary"] }, COMMON_FIELDS).valid, true);
  assert.equal(validateItemResult({ ...good(), uncertain: ["no_such_field"] }, COMMON_FIELDS).valid, false);

  const inArray = { ...good(), key_findings: ["fine", "unclear [uncertain]"] };
  assert.equal(validateItemResult(inArray, COMMON_FIELDS).valid, false);
  assert.equal(validateItemResult({ ...inArray, uncertain: ["key_findings"] }, COMMON_FIELDS).valid, true);
});

test("a documentation item needs its extra fields AND an official-docs source", () => {
  const fields = [...COMMON_FIELDS, ...DOCS_FIELDS];
  const docs = { ...good(), current_version: "1.2.3", api_surface: ["fn()"], pitfalls: ["none known"] };
  assert.equal(validateItemResult(docs, fields, { requireOfficialDocs: true }).valid, true);
  const blog = { ...docs, sources: [{ title: "Blog", url: "https://example.org/blog", type: "article" }] };
  const v = validateItemResult(blog, fields, { requireOfficialDocs: true });
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => /official-docs/.test(p)));
  assert.equal(validateItemResult(blog, fields, {}).valid, true, "the rule applies only to documentation items");
  assert.equal(validateItemResult(good(), fields, { requireOfficialDocs: true }).valid, false, "missing docs-specific fields");
});
