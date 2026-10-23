// WS10: CBM, trim-1 and the quoted-stated-rules criteria are plug-ins with ONE switch each. These tests prove, for each:
//   OFF  -> none of its code runs: the modules are not even imported (static import graph), nothing is spawned or opened (spies on the seams),
//           nothing breaks (step 14 still writes the plain summary, doctor neither fails nor warns), token instrumentation stays on;
//   ON   -> it runs, exactly as before (the existing CBM / trim suites still pass);
//   the precedence is flag > config > default, and every feature logs a `feature_state` event with its source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { ExitCode } from "../domain/errors.ts";
import { OsaConfig, defaultOsaConfig } from "../domain/osa-config.ts";
import type { RunConfig } from "../domain/run.ts";
import type { RunResult } from "../dispatch/run-loop.ts";
import type { CodeSearchEngine, EngineAnswer } from "../code-index/engine.ts";
import { createCodeSearcher } from "../code-index/searcher.ts";
import { featureReport, runDoctor } from "../cli/doctor.ts";
import { parseArgs } from "../cli/main.ts";
import { UsageError } from "../domain/errors.ts";
import { applyFeatureFlags, describeFeatures, parseFeatureFlag } from "../features/features.ts";
import { MinIntervalLimiter } from "../research/net/http.ts";
import { NoopTrimmer } from "../trim/trimmer.ts";
import { resolveTrimmerLazily } from "../trim/resolve.ts";
import type { RawInvocationResult } from "../domain/run.ts";
import { MemoryEventSink } from "./events.ts";
import { buildIntakePrompt, runIntake } from "./intake.ts";
import { fakeModel, researchFetch, samplePrd, scriptedTextCall, tempGitRepo } from "./fixtures.test.ts";
import { runOsaCommand } from "./pipeline.ts";
import type { OsaDeps } from "./pipeline.ts";
import type { LockIO } from "./lock.ts";

const RUN_ID = "efefefef-efef-4fef-8fef-efefefefefef";
const io: LockIO = { show: () => undefined, choose: () => Promise.resolve("lock"), edit: () => Promise.resolve() };
const ok: RunResult = { ok: true, exitCode: 0, turns: [], halt: null, problems: [], warnings: [] };
const ROOT = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

// ---- 1. the static import graph: with everything off, no entry point can even load the plug-ins ---------------------------------------

/** The modules `src` imports at load time: `import … from`, `export … from` and bare `import "x"`; NOT `import type`, NOT dynamic `import(…)`. Pure. */
export function staticImports(src: string): string[] {
  const out: string[] = [];
  const re = /^(?:import|export)\s+(?!type\b)(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (const m of src.matchAll(re)) if (m[1] !== undefined) out.push(m[1]);
  return out;
}

/** Every file reachable from `entry` through static relative imports (the entry included). */
async function staticClosure(entry: string): Promise<string[]> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of staticImports(text)) if (spec.startsWith(".")) stack.push(resolve(dirname(file), spec));
  }
  return [...seen];
}

const PLUGIN_FILES = (rel: string): boolean => rel === "src/trim/trim1.ts" || rel.startsWith("src/code-index/cbm/") || rel === "src/code-index/fusion.ts";

test("staticImports sees runtime imports and re-exports only: not `import type`, not dynamic import()", () => {
  const src = [
    'import { a } from "./a.ts";',
    'import type { T } from "./types-only.ts";',
    'import {\n  b,\n  c,\n} from "./multi-line.ts";',
    'export { d } from "./reexport.ts";',
    'export type { E } from "./type-reexport.ts";',
    'import "./side-effect.ts";',
    'const lazy = await import("./dynamic.ts");',
  ].join("\n");
  assert.deepEqual(staticImports(src), ["./a.ts", "./multi-line.ts", "./reexport.ts", "./side-effect.ts"]);
});

test("NO IMPORTS WITH SIDE EFFECTS: from every entry point (CLI, MCP server, pipeline, searcher, trimmer resolver) the static import graph never reaches trim-1 or any CBM/fusion module", async () => {
  for (const entry of ["src/cli/main.ts", "src/mcp/server.ts", "src/osa/pipeline.ts", "src/code-index/searcher.ts", "src/trim/resolve.ts", "src/features/features.ts", "src/cli/doctor.ts", "src/cli/index-cmd.ts"]) {
    const reached = (await staticClosure(resolve(ROOT, entry))).map((f) => relative(ROOT, f).split("\\").join("/"));
    assert.ok(reached.length > 1, `${entry}: the walker found its imports`);
    assert.deepEqual(reached.filter(PLUGIN_FILES), [], `${entry} statically imports a plug-in module`);
  }
});

test("...and the walker does catch a planted static import (mutation check)", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-graph-`);
  await mkdir(`${dir}/src/trim`, { recursive: true });
  await writeFile(`${dir}/src/a.ts`, 'import { b } from "./b.ts";\n');
  await writeFile(`${dir}/src/b.ts`, 'import { t } from "./trim/trim1.ts";\n');
  await writeFile(`${dir}/src/trim/trim1.ts`, "export const t = 1;\n");
  const reached = (await staticClosure(`${dir}/src/a.ts`)).map((f) => relative(dir, f).split("\\").join("/"));
  assert.deepEqual(reached.filter(PLUGIN_FILES), ["src/trim/trim1.ts"]);
  await writeFile(`${dir}/src/b.ts`, 'const t = await import("./trim/trim1.ts");\nimport type { X } from "./trim/trim1.ts";\n');
  assert.deepEqual((await staticClosure(`${dir}/src/a.ts`)).map((f) => relative(dir, f).split("\\").join("/")).filter(PLUGIN_FILES), [], "a lazy import() and a type import are not load-time edges");
});

// ---- 2. precedence: flag > config > default ---------------------------------------------------------------------------------------

test("precedence flag > config > default, and the reported source says which won", () => {
  const dflt = defaultOsaConfig();
  assert.deepEqual(describeFeatures(dflt).map((f) => [f.id, f.value, f.enabled, f.source]), [
    ["index.engine", "lexical", false, "default"],
    ["trim.enabled", "off", false, "default"],
    ["intake.quoteStatedRules", "off", false, "default"],
  ]);
  const file = OsaConfig.parse({ index: { engine: "cbm" }, trim: { enabled: true }, intake: { quoteStatedRules: true } });
  const explicit = { indexEngine: true, trim: true, quoteStatedRules: true };
  assert.deepEqual(describeFeatures(file, explicit).map((f) => [f.value, f.source]), [["cbm", "config"], ["on", "config"], ["on", "config"]]);
  const flags = { indexEngine: "lexical", trim: false } as const;
  const eff = applyFeatureFlags(file, flags);
  assert.deepEqual(describeFeatures(eff, explicit, flags).map((f) => [f.value, f.source]), [["lexical", "flag"], ["off", "flag"], ["on", "config"]], "a flag beats the file; a switch without a flag keeps the file's value");
  assert.deepEqual(describeFeatures(applyFeatureFlags(dflt, { trim: true }), { indexEngine: false, trim: false, quoteStatedRules: false }, { trim: true }).map((f) => f.source), ["default", "flag", "default"]);
});

test("feature flags parse on every command that takes them; a bad --index-engine value is a UsageError", () => {
  assert.deepEqual(parseFeatureFlag(["--index-engine", "cbm"], 0), { patch: { indexEngine: "cbm" }, last: 1 });
  assert.deepEqual(parseFeatureFlag(["--trim"], 0), { patch: { trim: true }, last: 0 });
  assert.deepEqual(parseFeatureFlag(["--no-trim"], 0), { patch: { trim: false }, last: 0 });
  assert.deepEqual(parseFeatureFlag(["--quote-stated-rules"], 0), { patch: { quoteStatedRules: true }, last: 0 });
  assert.equal(parseFeatureFlag(["--json"], 0), null);
  assert.throws(() => parseFeatureFlag(["--index-engine", "elastic"], 0), UsageError);
  assert.throws(() => parseFeatureFlag(["--index-engine"], 0), UsageError);
  const node = ["node", "main.ts"];
  const one = parseArgs([...node, "build me a counter app", "--trim", "--index-engine", "cbm", "--yes"]);
  assert.ok(one.kind === "osa" && one.features?.trim === true && one.features.indexEngine === "cbm" && one.yes === true && one.prompt === "build me a counter app");
  const noTrim = parseArgs([...node, "build me a counter app", "--no-trim"]);
  assert.ok(noTrim.kind === "osa" && noTrim.features?.trim === false);
  const search = parseArgs([...node, "search", "where is the lock", "--index-engine", "cbm"]);
  assert.ok(search.kind === "search" && search.features?.indexEngine === "cbm" && search.query === "where is the lock");
  const doctor = parseArgs([...node, "doctor", "--boundary", "--trim"]);
  assert.ok(doctor.kind === "doctor" && doctor.only === "boundary" && doctor.features?.trim === true);
  const feats = parseArgs([...node, "features", "--json", "--no-quote-stated-rules"]);
  assert.ok(feats.kind === "features" && feats.json && feats.features.quoteStatedRules === false);
  assert.ok(parseArgs([...node, "features"]).kind === "features");
  assert.throws(() => parseArgs([...node, "features", "--bogus"]), UsageError);
  assert.equal((parseArgs([...node, "build me a counter app"]) as { features?: unknown }).features, undefined, "no flags, no overrides");
});

// ---- 3. a full run with everything OFF: nothing of the plug-ins runs, nothing breaks -------------------------------------------------

const dispatcher = (repoDir: string) => async (rc: RunConfig): Promise<RunResult> => {
  const specDir = rc.spec_path.slice(0, rc.spec_path.lastIndexOf("/") + 1);
  await mkdir(`${repoDir}/${specDir}`, { recursive: true });
  await writeFile(rc.is_final_phase ? `${repoDir}/BUILD_COMPLETE.md` : `${repoDir}/${specDir}PHASE_${String(rc.phase + 1)}_SPEC.md`, "next\n", "utf8");
  return ok;
};

const fakeCbm = (calls: string[]): CodeSearchEngine => ({
  name: "cbm",
  search: (q) => {
    calls.push(`search:${q.slice(0, 20)}`);
    const a: EngineAnswer = { engine: "cbm", hits: [], confidence: "high", abstained: false, reason: "fake", signals: null, stale: [], ms: 1 };
    return Promise.resolve(a);
  },
  refresh: () => (calls.push("refresh"), Promise.resolve()),
  close: () => (calls.push("close"), Promise.resolve()),
});

const absentBinary = (calls: string[]) => (o: { readonly command: string }): Promise<RawInvocationResult> => {
  calls.push(o.command);
  return Promise.resolve({ exitCode: null, signal: null, stdout: "", stderr: "spawn trim ENOENT", durationMs: 1, timedOut: false });
};

function baseDeps(repoDir: string, over: Partial<OsaDeps>): OsaDeps {
  return {
    events: new MemoryEventSink(RUN_ID),
    io,
    interactive: true,
    runId: RUN_ID,
    textCall: fakeModel().call,
    research: { http: { fetchFn: researchFetch, sleepFn: () => Promise.resolve() }, arxivLimiter: new MinIntervalLimiter(0), env: {} },
    drive: { runDispatchFn: dispatcher(repoDir) as never },
    ...over,
  };
}
const runOpts = (repoDir: string, over: object = {}) => ({ prompt: "make me a word counter", files: [], repoDir, yes: true, json: false, build: true, ...over });

test("ALL OFF (the defaults): no CBM engine is opened, no trim-1 binary is probed or run, the lexical engine serves the context, the no-op trimmer is used, step 14 still writes the plain summary, and token_breakdown is still logged", async () => {
  const repoDir = await tempGitRepo();
  const events = new MemoryEventSink(RUN_ID);
  const cbmCalls: string[] = [];
  const trimCalls: string[] = [];
  const report = await runOsaCommand(runOpts(repoDir), baseDeps(repoDir, { events, config: defaultOsaConfig(), openCbm: () => (cbmCalls.push("OPENED"), Promise.resolve(fakeCbm(cbmCalls))), trimSpawn: absentBinary(trimCalls) as never }));
  assert.equal(report.ok, true, report.problems.join("; "));
  assert.deepEqual(cbmCalls, [], "CBM was never opened, refreshed, searched or closed");
  assert.deepEqual(trimCalls, [], "trim-1 was never probed or run");
  const search = events.events.filter((e) => e.event === "code_search_engine");
  assert.ok(search.length >= 1 && search.every((e) => e.data["engine"] === "lexical" && e.data["requested"] === "lexical"), "code search + context injection used the lexical engine");
  assert.ok(events.events.every((e) => e.event !== "trim_applied"), "nothing was trimmed");
  assert.ok(events.events.filter((e) => e.event === "trim_skipped").every((e) => e.data["engine"] === "noop"), "handoffs went through the no-op trimmer");
  const states = events.events.filter((e) => e.event === "feature_state");
  assert.deepEqual(states.map((e) => [e.data["feature"], e.data["state"], e.data["value"], e.data["source"]]), [
    ["index.engine", "disabled", "lexical", "default"],
    ["trim.enabled", "disabled", "off", "default"],
    ["intake.quoteStatedRules", "disabled", "off", "default"],
  ]);
  // step 14 still ran and wrote the plain-language summary
  assert.ok(events.events.some((e) => e.event === "step14_done"));
  const summary = await readFile(`${repoDir}/${report.summary_path as string}`, "utf8");
  assert.match(summary, /^# What OSA got done|^# /m);
  // token instrumentation is not a feature: it stays on
  const breakdowns = events.events.filter((e) => e.event === "token_breakdown");
  assert.ok(breakdowns.some((e) => e.data["scope"] === "run") && breakdowns.some((e) => String(e.data["scope"]).startsWith("phase-")), "per-phase and per-run token breakdowns are still logged");
});

test("ALL ON: the CBM engine is opened and used, trim-1 is probed, the stated rules are asked for; each logs feature_state 'enabled'", async () => {
  const repoDir = await tempGitRepo();
  const events = new MemoryEventSink(RUN_ID);
  const cbmCalls: string[] = [];
  const trimCalls: string[] = [];
  const config = OsaConfig.parse({ index: { engine: "cbm", cbm: { binaryPath: "C:/x/cbm.exe", workDir: "C:/x" } }, trim: { enabled: true, binaryPath: "C:/x/trim.exe" }, intake: { quoteStatedRules: true } });
  const model = fakeModel();
  const report = await runOsaCommand(runOpts(repoDir), baseDeps(repoDir, { events, config, textCall: model.call, openCbm: () => (cbmCalls.push("OPENED"), Promise.resolve(fakeCbm(cbmCalls))), trimSpawn: absentBinary(trimCalls) as never }));
  assert.equal(report.ok, true, report.problems.join("; "));
  assert.ok(cbmCalls.includes("OPENED") && cbmCalls.some((c) => c.startsWith("search:")) && cbmCalls.includes("close"), `CBM used and closed: ${cbmCalls.join(",")}`);
  assert.ok(trimCalls.length >= 1, "trim-1 was probed");
  assert.ok(events.events.filter((e) => e.event === "code_search_engine").every((e) => e.data["engine"] === "cbm"));
  assert.ok(model.log.find((l) => l.purpose === "intake")?.req.prompt.includes('"statedRequirements"'), "intake was asked for the stated rules");
  assert.deepEqual(events.events.filter((e) => e.event === "feature_state").map((e) => [e.data["state"], e.data["value"]]), [["enabled", "cbm"], ["enabled", "on"], ["enabled", "on"]]);
});

test("PRECEDENCE in a real run: osa.config.json switches CBM and trim-1 on, then --index-engine lexical / --no-trim turn them off for that run; the events say 'config' and 'flag'", async () => {
  const repoDir = await tempGitRepo();
  await writeFile(`${repoDir}/osa.config.json`, JSON.stringify({ index: { engine: "cbm", cbm: { binaryPath: "C:/x/cbm.exe", workDir: "C:/x" } }, trim: { enabled: true, binaryPath: "C:/x/trim.exe" } }));
  const run = async (features: object) => {
    const events = new MemoryEventSink(RUN_ID);
    const cbmCalls: string[] = [];
    const trimCalls: string[] = [];
    const deps = baseDeps(repoDir, { events, openCbm: () => (cbmCalls.push("OPENED"), Promise.resolve(fakeCbm(cbmCalls))), trimSpawn: absentBinary(trimCalls) as never });
    delete (deps as { config?: unknown }).config; // read osa.config.json for real
    const r = await runOsaCommand(runOpts(repoDir, { features }), deps);
    return { r, events, cbmCalls, trimCalls };
  };
  const fromConfig = await run({});
  assert.ok(fromConfig.cbmCalls.includes("OPENED") && fromConfig.trimCalls.length >= 1, "the config file alone switched both on");
  assert.deepEqual(fromConfig.events.events.filter((e) => e.event === "feature_state").map((e) => e.data["source"]), ["config", "config", "default"]);
  const overridden = await run({ indexEngine: "lexical", trim: false });
  assert.deepEqual(overridden.cbmCalls, [], "--index-engine lexical beat the config");
  assert.deepEqual(overridden.trimCalls, [], "--no-trim beat the config");
  assert.deepEqual(overridden.events.events.filter((e) => e.event === "feature_state").map((e) => [e.data["state"], e.data["source"]]), [["disabled", "flag"], ["disabled", "flag"], ["disabled", "default"]]);
});

// ---- 4. the pieces, each with its feature off ----------------------------------------------------------------------------------

test("resolveTrimmerLazily: off (or engine noop) returns the no-op trimmer without spawning; on probes the binary", async () => {
  const calls: string[] = [];
  const spawn = absentBinary(calls) as never;
  const off = await resolveTrimmerLazily(OsaConfig.parse({}).trim, { runProcessFn: spawn });
  assert.ok(off.trimmer instanceof NoopTrimmer && /trim\.enabled is false/.test(off.note ?? ""));
  const noop = await resolveTrimmerLazily(OsaConfig.parse({ trim: { enabled: true, engine: "noop" } }).trim, { runProcessFn: spawn });
  assert.ok(noop.trimmer instanceof NoopTrimmer);
  assert.deepEqual(calls, []);
  const on = await resolveTrimmerLazily(OsaConfig.parse({ trim: { enabled: true } }).trim, { runProcessFn: spawn });
  assert.equal(on.trimmer.engine, "noop", "binary absent: falls back loudly (this behaviour is unchanged)");
  assert.match(on.note ?? "", /not available/);
  assert.equal(calls.length, 1);
});

test("code searcher with index.engine lexical: never opens CBM, for search or for the graph views; with cbm it does", async () => {
  const repoDir = await tempGitRepo();
  await writeFile(`${repoDir}/lock.ts`, "export function lockPrd() { return 1; }\n");
  let opened = 0;
  const lexical = createCodeSearcher({ repoDir, index: OsaConfig.parse({}).index, openCbm: () => (opened++, Promise.resolve(fakeCbm([]))) });
  const a = await lexical.search("lockPrd", { k: 3, purpose: "t" });
  assert.equal(a.engine, "lexical");
  const s = await lexical.structure("architecture");
  assert.equal(s.available, false);
  await lexical.close();
  assert.equal(opened, 0);
  const cbm = createCodeSearcher({ repoDir, index: OsaConfig.parse({ index: { engine: "cbm", cbm: { binaryPath: "b", workDir: "w" } } }).index, openCbm: () => (opened++, Promise.resolve(fakeCbm([]))) });
  assert.equal((await cbm.search("lockPrd", { k: 3, purpose: "t" })).engine, "cbm");
  assert.equal(opened, 1);
});

test("intake.quoteStatedRules OFF: the model is not asked for stated rules, no quoted criteria are added even if it volunteers some; ON: they are", async () => {
  const asked = "Count words. A word is a maximal run of ASCII letters; other Unicode separates words.";
  const reply = { ...samplePrd(), statedRequirements: ["A word is a maximal run of ASCII letters; other Unicode separates words."] };
  const input = { prompt: asked, files: [], memory: null, maxItems: 8 };
  const deps = (r: object) => ({ textCall: scriptedTextCall([JSON.stringify(r)]).call, provider: "claude-code" as const, cwd: process.cwd(), timeoutMs: 1000, events: new MemoryEventSink() });
  assert.ok(!buildIntakePrompt(input).includes("statedRequirements"), "off: the prompt does not ask");
  const off = await runIntake(input, deps(reply));
  assert.equal(off.prd.acceptanceCriteria.length, samplePrd().acceptanceCriteria.length, "off: criteria are the model's own");
  assert.ok(off.prd.request !== undefined, "the verbatim request section is NOT part of this toggle");
  const on = await runIntake({ ...input, quoteStatedRules: true }, deps(reply));
  assert.equal(on.prd.acceptanceCriteria.length, samplePrd().acceptanceCriteria.length + 1);
});

// ---- 5. doctor and the CLI -------------------------------------------------------------------------------------------------------

test("doctor: with the features OFF and their binaries absent, nothing fails or warns and each feature is reported 'disabled'; ON with the binary missing is a warning, not a failure; a broken config is a warning, not a crash", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-doctor-feat-`);
  await writeFile(`${dir}/osa.config.json`, JSON.stringify({ index: { engine: "lexical", cbm: { binaryPath: "C:/nope/cbm.exe", workDir: "C:/nope" } }, trim: { enabled: false, binaryPath: "C:/nope/trim.exe" } }));
  const off = await featureReport(dir, {});
  assert.ok(off.features !== null);
  assert.deepEqual(off.warnings, [], "disabled + missing binaries = silence");
  assert.deepEqual(off.features.map((f) => [f.id, f.enabled, f.source]), [["index.engine", false, "config"], ["trim.enabled", false, "config"], ["intake.quoteStatedRules", false, "default"]]);
  const on = await featureReport(dir, { indexEngine: "cbm", trim: true });
  assert.equal(on.warnings.length, 2);
  assert.match(on.warnings.join(" "), /codebase-memory-mcp binary is not at[\s\S]*trim-1 binary is not at/);
  await writeFile(`${dir}/osa.config.json`, "{ not json");
  const broken = await featureReport(dir, {});
  assert.equal(broken.features, null);
  assert.match(broken.warnings[0] ?? "", /could not be read/);

  const { report, exitCode } = await runDoctor(ROOT, { json: true, only: "boundary" });
  assert.equal(exitCode, ExitCode.OK);
  assert.equal(report.ok, true);
  assert.equal(report.features?.length, 3);
  assert.ok((report.warnings ?? []).every((w) => !/cbm|trim-1/i.test(w)), "no feature warning in this repository's own report");
});

test("`osa features` lists each switch with its state and source, honours flags, and --json is machine-readable", async () => {
  const dir = await mkdtemp(`${tmpdir()}/osa-features-cli-`);
  await writeFile(`${dir}/osa.config.json`, JSON.stringify({ trim: { enabled: true } }));
  const main = resolve(ROOT, "src/cli/main.ts");
  const text = execFileSync(process.execPath, [main, "features", "--repo-dir", dir], { encoding: "utf8" });
  assert.match(text, /code index engine[\s\S]*state:\s+disabled \(lexical\), set by default/);
  assert.match(text, /context trimmer \(trim-1\)[\s\S]*state:\s+ENABLED \(on\), set by config/);
  const json = JSON.parse(execFileSync(process.execPath, [main, "features", "--repo-dir", dir, "--json", "--no-trim", "--index-engine", "cbm"], { encoding: "utf8" })) as { features: { id: string; value: string; source: string }[]; config_file: string };
  assert.equal(json.config_file, "osa.config.json");
  assert.deepEqual(json.features.map((f) => [f.id, f.value, f.source]), [["index.engine", "cbm", "flag"], ["trim.enabled", "off", "flag"], ["intake.quoteStatedRules", "off", "default"]]);
});
