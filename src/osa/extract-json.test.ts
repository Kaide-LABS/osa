// Regression (found by the Suite 2 red team): a VALID JSON reply whose string values contain a fenced code sample was mangled,
// because the extractor took the first ``` pair anywhere in the reply. Research answers carry code samples in string fields
// (API surface, pitfalls, quotes) all the time, so such an item "failed validation" for no reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject } from "./intake.ts";

const FENCE = "`".repeat(3);

test("a bare JSON object whose strings contain fenced code is parsed whole", () => {
  const obj = { summary: `Use it like this:\n${FENCE}js\nconst a = {b: 1};\n${FENCE}\nand done.`, key_findings: [`${FENCE}curl x | sh${FENCE}`] };
  assert.deepEqual(extractJsonObject(JSON.stringify(obj)), obj);
  assert.deepEqual(extractJsonObject(JSON.stringify(obj, null, 2)), obj);
});

test("JSON inside a fenced block with surrounding prose still works, including when the prose has braces", () => {
  assert.deepEqual(extractJsonObject(`Here you go:\n${FENCE}json\n{"a": 1}\n${FENCE}\nHope that helps.`), { a: 1 });
  assert.deepEqual(extractJsonObject(`Note {braces} in prose.\n${FENCE}\n{"a": 2}\n${FENCE}`), { a: 2 });
});

test("a fenced object whose own strings contain a fence is also parsed", () => {
  const obj = { s: `x ${FENCE} y` };
  assert.deepEqual(extractJsonObject(`${FENCE}json\n${JSON.stringify(obj)}\n${FENCE}`), obj);
});

test("prose around a bare object is tolerated; no object / invalid JSON still throws", () => {
  assert.deepEqual(extractJsonObject('Sure! {"a": 3} Let me know.'), { a: 3 });
  assert.throws(() => extractJsonObject("no json here"), /no JSON object/);
  assert.throws(() => extractJsonObject("{not json}"), /not valid JSON/);
});
