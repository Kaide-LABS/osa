import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { defaultOsaConfig, OsaConfig } from "../domain/osa-config.ts";
import { samplePrd } from "../osa/fixtures.test.ts";
import { COMMON_FIELDS, buildFields, buildOutline, fieldsFor, readOutlineFiles, slugify, writeOutlineFiles } from "./outline.ts";

test("outline + fields are generated from a locked PRD alone: pure, deterministic, no prompts (WS3.5 test 1)", () => {
  const prd = samplePrd();
  const config = defaultOsaConfig();
  const a = buildOutline(prd, config);
  const b = buildOutline(prd, config);
  assert.deepEqual(a, b, "same PRD + config => identical outline");
  assert.equal(a.topic, "Word counting CLI");
  // Everything the original skills asked the human mid-run is settled here:
  assert.equal(a.execution.timeRange, "last 3 years");
  assert.equal(a.execution.batchSize, config.research.batchSize);
  assert.equal(a.execution.resume, true);
  assert.deepEqual(a.execution.academic, { enabled: true, queries: ["word segmentation algorithms"] });
  assert.deepEqual(a.execution.githubLookup, { enabled: true, queries: ["word count cli node"] });
});

test("a mandatory official-docs item is created for every docs target, before the PRD's own research items", () => {
  const prd = { ...samplePrd(), researchPlan: { ...samplePrd().researchPlan, docsTargets: ["Node.js", "Python 3 argparse module"] } };
  const o = buildOutline(prd, defaultOsaConfig());
  assert.deepEqual(o.items.slice(0, 2).map((i) => [i.slug, i.kind]), [["docs-node-js", "docs"], ["docs-python-3-argparse-module", "docs"]]);
  assert.match(o.items[0]?.question ?? "", /OFFICIAL documentation for "Node\.js"/);
  assert.equal(o.items.filter((i) => i.kind === "research").length, 2);
  const f = buildFields(o);
  assert.ok(fieldsFor(f, "docs-node-js").some((x) => x.name === "current_version"));
  assert.ok(!fieldsFor(f, "node-cli-conventions").some((x) => x.name === "current_version"));
  assert.deepEqual(f.common, [...COMMON_FIELDS]);
});

test("research.academic=false drops the academic module and its queries; githubLookup=false drops prior-art queries", () => {
  const config = OsaConfig.parse({ research: { academic: false, githubLookup: false } });
  const o = buildOutline(samplePrd(), config);
  assert.ok(o.items.every((i) => !i.modules.includes("academic-papers")));
  assert.deepEqual(o.execution.academic, { enabled: false, queries: [] });
  assert.deepEqual(o.execution.githubLookup, { enabled: false, queries: [] });
});

test("slugs are unique and never collide with the tool-written result files", () => {
  const base = samplePrd();
  const prd = {
    ...base,
    researchPlan: {
      ...base.researchPlan,
      docsTargets: ["Node.js", "node js"],
      items: [
        { slug: "prior-art", title: "x", question: "q", modules: ["general-web" as const] },
        { slug: "academic-papers", title: "y", question: "q", modules: ["general-web" as const] },
      ],
    },
  };
  const slugs = buildOutline(prd, defaultOsaConfig()).items.map((i) => i.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.ok(!slugs.includes("prior-art") && !slugs.includes("academic-papers"));
});

test("slugify", () => {
  assert.equal(slugify("Python 3 argparse module"), "python-3-argparse-module");
  assert.equal(slugify("  Ünïcode & Symbols!! "), "unicode-symbols");
  assert.equal(slugify("***"), "item");
});

test("outline.yaml and fields.yaml are written and read back identically", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-outline-`);
  const outline = buildOutline(samplePrd(), defaultOsaConfig());
  const fields = buildFields(outline);
  await writeOutlineFiles(`${dir}/research`, outline, fields);
  assert.match(await readFile(`${dir}/research/outline.yaml`, "utf8"), /^# OSA research outline/);
  const back = await readOutlineFiles(`${dir}/research`);
  assert.deepEqual(back.outline, outline);
  assert.deepEqual(back.fields, fields);
});
