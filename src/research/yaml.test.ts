import { test } from "node:test";
import assert from "node:assert/strict";
import { fromYaml, toYaml } from "./yaml.ts";

const roundTrip = (v: unknown): unknown => fromYaml(toYaml(v));

test("yaml: scalars, nested maps and lists round-trip", () => {
  const v = {
    topic: "Word counting: a \"quoted\" topic\nwith a newline",
    n: 3,
    f: 1.5,
    yes: true,
    no: false,
    nothing: null,
    empty_list: [],
    empty_map: {},
    items: [
      { slug: "a-b", title: "A", modules: ["general-web", "academic-papers"], nested: { x: 1, y: ["p", "q"] } },
      { slug: "c", title: "C: with colon", modules: [] },
    ],
    plain: ["x", "y z", "- looks like a dash"],
    "odd key": "v",
  };
  assert.deepEqual(roundTrip(v), v);
});

test("yaml: lists of lists and lists at top level round-trip", () => {
  assert.deepEqual(roundTrip([[1, 2], ["a"], []]), [[1, 2], ["a"], []]);
  assert.deepEqual(roundTrip([{ a: 1 }, { b: [1, 2] }]), [{ a: 1 }, { b: [1, 2] }]);
});

test("yaml: output is block style and human-readable", () => {
  const out = toYaml({ topic: "T", items: [{ slug: "a", modules: ["m"] }] });
  assert.equal(out, 'topic: "T"\nitems:\n  - slug: "a"\n    modules:\n      - "m"\n');
});

test("yaml: accepts comments, blank lines and unquoted scalars (hand edits)", () => {
  const parsed = fromYaml('# a comment\ntopic: hello world\n\nbatchSize: 4\nflag: true\nlist:\n  - one\n  - two\n');
  assert.deepEqual(parsed, { topic: "hello world", batchSize: 4, flag: true, list: ["one", "two"] });
});

test("yaml: a list at the same indent as its key is accepted", () => {
  assert.deepEqual(fromYaml("items:\n- a\n- b\nafter: 1\n"), { items: ["a", "b"], after: 1 });
});

test("yaml: malformed input is a loud error, not a guess", () => {
  assert.throws(() => fromYaml("a: 1\n\tb: 2\n"), /tabs/);
  assert.throws(() => fromYaml('a: "unterminated\n'), /bad quoted string/);
  assert.throws(() => fromYaml("a: 1\n   b: 2\n"), /unexpected indentation/);
});
