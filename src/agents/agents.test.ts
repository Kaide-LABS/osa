import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { StageError } from "../domain/errors.ts";
import { OsaConfig, defaultOsaConfig } from "../domain/osa-config.ts";
import type { RawInvocationResult } from "../domain/run.ts";
import { MemoryEventSink } from "../osa/events.ts";
import { FAKE_SPEC_REPLY, samplePrd, scriptedTextCall, tempGitRepo } from "../osa/fixtures.test.ts";
import { parseDecisionReply, renderDecisionSection, runArchitectureDecision } from "../osa/spec.ts";
import type { DocsReport } from "../research/docs.ts";
import { ADAPTER_REGISTRY } from "../adapters/registry.ts";
import { isTextCapable } from "../ports/text-provider.ts";
import { makeTextCall } from "../dispatch/text-call.ts";
import { AGENT_SPECS } from "./spec.ts";
import { ApplicationReportSchema, applicationNotes, buildApplicationPrompt, chooseApplicationProvider, collectCriteria, createSandbox, evaluateEvidence, runApplicationAgent, writeApplicationReport } from "./application.ts";
import { ImplicationReportSchema, applyImplications, buildImplicationPrompt, runImplicationAgent } from "./implication.ts";
import { LateralReportSchema, chooseLateralProvider, extractPlannedArchitecture, renderAlternatives, runLateralArchitectureAgent } from "./lateral-architecture.ts";
import { InternalError } from "../domain/errors.ts";

const raw = (over: Partial<RawInvocationResult> = {}): RawInvocationResult => ({ exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...over });
const docs: DocsReport = { sources: [{ title: "Node docs", url: "https://nodejs.org/docs", itemSlug: "d" }], covered: ["Node.js"], uncovered: [] };

// ---------------------------------------------------------------- declarations

test("each agent declares its inputs, outputs, provider key, config gate and event", () => {
  assert.deepEqual(AGENT_SPECS.map((a) => a.name), ["lateral-architecture", "implication", "application"]);
  for (const a of AGENT_SPECS) {
    assert.ok(a.inputs.length > 0 && a.outputs.length > 0 && a.description !== "");
    assert.ok(["implication", "lateralArchitecture", "application"].includes(a.configGate));
    assert.ok(a.providerKey.endsWith("Provider"));
  }
  assert.equal(AGENT_SPECS.find((a) => a.name === "application")?.failureIsFatal, true);
  assert.equal(defaultOsaConfig().agents.implication && defaultOsaConfig().agents.lateralArchitecture && defaultOsaConfig().agents.application, true, "all three default ON");
});

// ---------------------------------------------------------------- implication

test("implication: a material consequence must become a criterion or an out-of-scope line, never a mere note", () => {
  const bad = { consequences: [{ area: "security", consequence: "x", material: true, action: "note", text: "y" }] };
  assert.equal(ImplicationReportSchema.safeParse(bad).success, false);
  assert.equal(ImplicationReportSchema.safeParse({ consequences: [{ area: "security", consequence: "x", material: false, action: "note", text: "y" }] }).success, true);
  assert.equal(ImplicationReportSchema.safeParse({ consequences: [{ area: "weather", consequence: "x", material: false, action: "note", text: "y" }] }).success, false);
});

test("implication: applying adds S-numbered criteria and out-of-scope lines to the SPEC; no consequences leaves it untouched", () => {
  const spec = "# Phase 1\nbody\n";
  assert.deepEqual(applyImplications(spec, []), { specMd: spec, acceptanceAdded: 0, outOfScopeAdded: 0 });
  const r = applyImplications(spec, [
    { area: "data", consequence: "Large files exhaust memory", material: true, action: "acceptance-criterion", text: "A 50 MB file is counted without crashing." },
    { area: "security", consequence: "Paths could escape", material: true, action: "acceptance-criterion", text: "A path with .. is treated as an ordinary path." },
    { area: "cost", consequence: "No cost", material: true, action: "out-of-scope", text: "Remote files are not supported." },
    { area: "maintenance", consequence: "n", material: false, action: "note", text: "Keep the tokenizer in one function." },
  ]);
  assert.equal(r.acceptanceAdded, 2);
  assert.equal(r.outOfScopeAdded, 1);
  assert.match(r.specMd, /^# Phase 1\nbody\n\n## Implications/);
  assert.match(r.specMd, /### Additional acceptance criteria\n\nS1\. A 50 MB file is counted without crashing\./);
  assert.match(r.specMd, /\nS2\. A path with \.\./);
  assert.match(r.specMd, /### Explicitly out of scope\n\n- Remote files are not supported\./);
  assert.match(r.specMd, /### Noted, no action\n\n- Keep the tokenizer/);
  assert.match(r.specMd, /the locked PRD is unchanged/);
});

test("implication agent: success logs implication_done with counts; invalid output is retried once; failure is reported, not thrown", async () => {
  const events = new MemoryEventSink();
  const good = JSON.stringify({ consequences: [{ area: "user-impact", consequence: "c", material: true, action: "acceptance-criterion", text: "T." }] });
  const s = scriptedTextCall(['{"consequences": [{"area": "data"}]}', good]);
  const r = await runImplicationAgent({ prdMarkdown: "PRD", contextMarkdown: "CTX", specMarkdown: "SPEC", provider: "codex-cli", textCall: s.call, events, cwd: "/r", timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.acceptanceAdded, 1);
  assert.match(r.specMarkdown, /^SPEC\n\n## Implications/);
  assert.equal(s.requests.length, 2);
  assert.match(s.requests[1]?.req.prompt ?? "", /YOUR PREVIOUS REPLY WAS REJECTED/);
  assert.equal(s.requests[0]?.provider, "codex-cli");
  assert.equal(s.requests[0]?.req.webSearch, false);
  const e = events.events.find((x) => x.event === "implication_done");
  assert.equal(e?.data["acceptanceAdded"], 1);
  assert.equal(e?.data["material"], 1);

  const events2 = new MemoryEventSink();
  const failed = await runImplicationAgent({ prdMarkdown: "P", contextMarkdown: "C", specMarkdown: "SPEC", provider: "codex-cli", textCall: scriptedTextCall([new InternalError("down")]).call, events: events2, cwd: "/r", timeoutMs: 1000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.specMarkdown, "SPEC", "the spec is untouched on failure");
  assert.equal(events2.events.find((x) => x.event === "implication_done")?.data["failed"], true);
  assert.match(buildImplicationPrompt({ prdMarkdown: "P", contextMarkdown: "C", specMarkdown: "S" }), /you may only ADD constraints to the spec/);
});

// ---------------------------------------------------------------- lateral architecture

const lateralJson = { alternatives: [{ name: "Streaming", summary: "s", howItDiffers: "streams", pros: ["a"], cons: ["b"], betterWhen: "big files" }], leaning: "keep-planned", note: "" };

test("lateral: at least one alternative is required, with pros, cons and how it differs", () => {
  assert.equal(LateralReportSchema.safeParse(lateralJson).success, true);
  assert.equal(LateralReportSchema.safeParse({ ...lateralJson, alternatives: [] }).success, false);
  assert.equal(LateralReportSchema.safeParse({ ...lateralJson, alternatives: [{ ...lateralJson.alternatives[0], howItDiffers: "" }] }).success, false);
  assert.equal(LateralReportSchema.safeParse({ ...lateralJson, leaning: "maybe" }).success, false);
});

test("lateral provider: the most independent seat wins; naming the planner's own provider is allowed and only reported; nothing is refused", () => {
  const planner = (provider: "claude-code" | "codex-cli", model: string | null) => ({ provider, model });
  const cands = [planner("claude-code", null), planner("codex-cli", null), { provider: "antigravity-cli" as const, model: null }];
  // a different model family is available -> it is chosen, with no warning
  const normal = OsaConfig.parse({});
  const a = chooseLateralProvider(normal.agents, planner("claude-code", null), cands);
  assert.deepEqual([a.provider, a.level, a.warning, a.sharesPlannerProvider], ["codex-cli", "different-family", null, false]);
  // the planner is the other family -> the choice flips
  const b = chooseLateralProvider(normal.agents, planner("codex-cli", null), cands);
  assert.deepEqual([b.provider, b.level], ["claude-code", "different-family"]);
  // ONE provider only: still runs, on the planner's own provider, and says the check is weak
  const alone = chooseLateralProvider(normal.agents, planner("claude-code", null), [planner("claude-code", null)]);
  assert.equal(alone.provider, "claude-code");
  assert.equal(alone.sharesPlannerProvider, true);
  assert.equal(alone.level, "same-model");
  assert.match(alone.warning ?? "", /weakly independent/);
  assert.doesNotMatch(alone.warning ?? "", /refus|LOUD/);
  // the operator names a provider and a model: used as named, even the planner's own
  const named = OsaConfig.parse({ agents: { lateralArchitectureProvider: "claude", lateralArchitectureModel: "named-model" } });
  const c = chooseLateralProvider(named.agents, planner("claude-code", null), cands);
  assert.deepEqual([c.provider, c.model, c.sharesPlannerProvider], ["claude-code", "named-model", true]);
  assert.equal(OsaConfig.parse({}).agents.lateralArchitectureProvider, undefined, "no provider is the default: OSA picks one");
});

test("lateral agent: runs on the chosen provider, logs lateral_arch_done, retries once, and reports failure instead of throwing", async () => {
  const events = new MemoryEventSink();
  const s = scriptedTextCall(["not json", JSON.stringify(lateralJson)]);
  const choice = { provider: "codex-cli" as const, model: null, level: "different-family" as const, warning: null, sharesPlannerProvider: false };
  const r = await runLateralArchitectureAgent({ prdMarkdown: "PRD", contextMarkdown: "## Planned architecture\nA single script.\n\n## Other\nx", researchDigest: "digest", choice, textCall: s.call, events, cwd: "/r", timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(s.requests[0]?.provider, "codex-cli");
  assert.match(s.requests[0]?.req.prompt ?? "", /=== PLANNED ARCHITECTURE ===\nA single script\./);
  assert.ok(!(s.requests[0]?.req.prompt ?? "").includes("## Other"), "only the planned-architecture section is shown");
  assert.equal(events.events.find((e) => e.event === "lateral_arch_done")?.data["alternatives"], 1);
  const events2 = new MemoryEventSink();
  const failed = await runLateralArchitectureAgent({ prdMarkdown: "P", contextMarkdown: "C", researchDigest: "d", choice, textCall: scriptedTextCall([new InternalError("down")]).call, events: events2, cwd: "/r", timeoutMs: 1000 });
  assert.equal(failed.ok, false);
  assert.equal(events2.events.find((e) => e.event === "lateral_arch_done")?.data["failed"], true);
  assert.match(renderAlternatives(LateralReportSchema.parse(lateralJson)), /Alternative 1: Streaming[\s\S]*Better when: big files/);
});

test("extractPlannedArchitecture takes just that section (to the next heading of the same or higher level), else the whole text", () => {
  assert.equal(extractPlannedArchitecture("# Ctx\n\n## Planned architecture\nOne script.\n### Detail\nmore\n\n## Next\nx"), "One script.\n### Detail\nmore");
  assert.equal(extractPlannedArchitecture("# Ctx\nno such section"), "# Ctx\nno such section");
  assert.equal(extractPlannedArchitecture("## Planned architecture\n\n## Next\nx"), "## Planned architecture\n\n## Next\nx");
});

// ---------------------------------------------------------------- the planner records the decision

test("decision parsing: 'planned' needs no revision; adopting an alternative needs both revised files; unknown names are rejected", () => {
  const names = ["Streaming", "Worker pool"];
  assert.deepEqual(parseDecisionReply("=== ARCHITECTURE_DECISION ===\nChosen: planned\nWhy: simple.", names), { chosen: "planned", why: "simple.", contextMd: null, specMd: null });
  const adopt = ["=== ARCHITECTURE_DECISION ===", "Chosen: streaming", "Why: big files.", "=== CONTEXT.MD ===", "# New ctx", "=== PHASE_1_SPEC.MD ===", "# New spec\n## Part A (first agent)\na\n## Part B (second agent)\nb"].join("\n");
  const d = parseDecisionReply(adopt, names);
  assert.equal(d.chosen, "Streaming");
  assert.match(d.specMd ?? "", /^# New spec/);
  assert.throws(() => parseDecisionReply("=== ARCHITECTURE_DECISION ===\nChosen: Streaming\nWhy: x", names), (e: unknown) => e instanceof StageError && /requires the full revised/.test(e.message));
  assert.throws(() => parseDecisionReply("=== ARCHITECTURE_DECISION ===\nChosen: Quantum\nWhy: x", names), (e: unknown) => e instanceof StageError && /neither "planned" nor/.test(e.message));
  assert.throws(() => parseDecisionReply("no sections", names), StageError);
  assert.match(renderDecisionSection("Streaming", "big files", names), /\*\*Chosen:\*\* Streaming[\s\S]*\*\*Why:\*\* big files/);
});

test("the planner RECORDS which architecture was chosen and why in context.md; an adopted alternative rewrites the spec but keeps its doc sources", async () => {
  const repoDir = await tempGitRepo();
  const events = new MemoryEventSink();
  const base = { repoDir, runId: "r1", prdMarkdown: "PRD", contextMarkdown: "# Ctx\n## Planned architecture\nA", specMarkdown: "# Spec\nsee https://nodejs.org/docs", alternativesText: "Alt", alternativeNames: ["Streaming"], docs, config: defaultOsaConfig(), events, specPath: "spec/PHASE_1_SPEC.md", contextPath: "spec/context.md" };
  const { mkdir } = await import("node:fs/promises");
  await mkdir(`${repoDir}/spec`, { recursive: true });

  const kept = await runArchitectureDecision({ ...base, textCall: scriptedTextCall(["=== ARCHITECTURE_DECISION ===\nChosen: planned\nWhy: small inputs."]).call });
  assert.equal(kept.chosen, "planned");
  assert.equal(kept.revised, false);
  const ctx = await readFile(`${repoDir}/spec/context.md`, "utf8");
  assert.match(ctx, /## Architecture decision[\s\S]*\*\*Chosen:\*\* the planned architecture[\s\S]*\*\*Why:\*\* small inputs\./);
  assert.match(ctx, /An independent reviewer proposed: Streaming\./);
  assert.ok(events.events.some((e) => e.event === "spec_assumption" && /kept the planned architecture/.test(String(e.data["text"]))));

  const adoptReply = ["=== ARCHITECTURE_DECISION ===", "Chosen: Streaming", "Why: files can be huge.", "=== CONTEXT.MD ===", "# Ctx v2", "=== PHASE_1_SPEC.MD ===", "# Spec v2 with no links\n## Part A (first agent)\na\n## Part B (second agent)\nb"].join("\n");
  const adopted = await runArchitectureDecision({ ...base, textCall: scriptedTextCall([adoptReply]).call });
  assert.equal(adopted.revised, true);
  const spec = await readFile(`${repoDir}/spec/PHASE_1_SPEC.md`, "utf8");
  assert.match(spec, /^# Spec v2 with no links/);
  assert.match(spec, /## Documentation sources[\s\S]*nodejs\.org\/docs/, "the revised spec still carries the documentation sources");
  assert.match(await readFile(`${repoDir}/spec/context.md`, "utf8"), /^# Ctx v2[\s\S]*\*\*Chosen:\*\* Streaming/);

  await assert.rejects(runArchitectureDecision({ ...base, textCall: scriptedTextCall(["rubbish", "still rubbish"]).call }), (e: unknown) => e instanceof StageError && /could not record an architecture decision/.test(e.message));
});

// ---------------------------------------------------------------- application agent

test("criteria: the PRD's numbered criteria (AC<n>) plus the spec's additional S<n> criteria", () => {
  const c = collectCriteria(samplePrd(), "## Implications\n\n### Additional acceptance criteria\n\nS1. Large files do not crash. _(data: memory)_\nS2. Bad paths are errors.\n\nnot a criterion\n");
  assert.deepEqual(c.map((x) => [x.id, x.source]), [["AC1", "prd"], ["AC2", "prd"], ["S1", "spec"], ["S2", "spec"]]);
  assert.equal(c[2]?.text, "Large files do not crash.");
});

const ev = (cmd = "node x.js", out = "ok") => [{ command: cmd, exit_code: 0, output_excerpt: out }];
const criteria = collectCriteria(samplePrd(), "");

test("evaluateEvidence: passes only when EVERY criterion is met WITH evidence", () => {
  const ok = evaluateEvidence(criteria, ApplicationReportSchema.parse({ criteria: [{ id: "AC1", status: "met", summary: "a", evidence: ev() }, { id: "AC2", status: "met", summary: "b", evidence: ev() }] }));
  assert.equal(ok.passed, true);
  assert.deepEqual(ok.downgraded, []);
});

test("evaluateEvidence: 'met' with no evidence is DOWNGRADED to unmet; missing, unmet and blocked criteria are unmet", () => {
  const v = evaluateEvidence(criteria, ApplicationReportSchema.parse({ criteria: [{ id: "AC1", status: "met", summary: "trust me", evidence: [] }] }));
  assert.equal(v.passed, false);
  assert.deepEqual(v.downgraded, ["AC1"]);
  assert.match(v.unmet.find((u) => u.id === "AC1")?.reason ?? "", /no evidence/);
  assert.match(v.unmet.find((u) => u.id === "AC2")?.reason ?? "", /did not report/);
  const blocked = evaluateEvidence(criteria, ApplicationReportSchema.parse({ criteria: [{ id: "AC1", status: "blocked", summary: "b", evidence: [] }, { id: "AC2", status: "unmet", summary: "u", evidence: ev() }] }));
  assert.equal(blocked.passed, false);
  assert.match(blocked.unmet[0]?.reason ?? "", /could not exercise/);
  const emptyOutput = evaluateEvidence(criteria.slice(0, 1), ApplicationReportSchema.parse({ criteria: [{ id: "AC1", status: "met", summary: "x", evidence: [{ command: "node x.js", output_excerpt: "" }] }] }));
  assert.equal(emptyOutput.passed, false, "a command with no observed output is not evidence");
  assert.equal(evaluateEvidence([], ApplicationReportSchema.parse({ criteria: [] })).passed, false, "nothing to check is not a pass");
});

test("application provider: default pair[1], then pair[0]; an explicit non-executing provider or none that can run is a loud failure", () => {
  const cfg = (a: object) => OsaConfig.parse({ agents: a }).agents;
  const exec = (ok: string[]) => (p: string): boolean => ok.includes(p);
  assert.equal(chooseApplicationProvider(cfg({}), ["claude-code", "codex-cli"], exec(["claude-code", "codex-cli"])), "codex-cli");
  assert.equal(chooseApplicationProvider(cfg({}), ["claude-code", "antigravity-cli"], exec(["claude-code"])), "claude-code");
  assert.equal(chooseApplicationProvider(cfg({ applicationProvider: "claude" }), ["claude-code", "codex-cli"], exec(["claude-code"])), "claude-code");
  assert.throws(() => chooseApplicationProvider(cfg({ applicationProvider: "antigravity" }), ["claude-code", "codex-cli"], exec(["claude-code"])), StageError);
  assert.throws(() => chooseApplicationProvider(cfg({}), ["antigravity-cli", "antigravity-cli"], exec([])), StageError);
});

test("application agent: runs in the sandbox with execute:true, evaluates, cleans up, logs application_check", async () => {
  const repoDir = await tempGitRepo();
  const events = new MemoryEventSink();
  let cleaned = 0;
  const sandbox = { dir: "/sandbox/repo", cleanup: () => { cleaned += 1; return Promise.resolve(); } };
  const reply = JSON.stringify({ criteria: [{ id: "AC1", status: "met", summary: "ok", evidence: ev() }, { id: "AC2", status: "unmet", summary: "broken", evidence: ev("node x.js bad", "Error: nope") }] });
  const s = scriptedTextCall([reply]);
  const v = await runApplicationAgent({ repoDir, prd: samplePrd(), specMarkdown: "", prdPath: "runs/r/baby-prd.md", specPath: "runs/r/spec/PHASE_1_SPEC.md", contextPath: "runs/r/spec/context.md", provider: "claude-code", textCall: s.call, events, timeoutMs: 1000, sandboxFactory: () => Promise.resolve(sandbox) });
  assert.equal(v.passed, false);
  assert.equal(v.unmet.length, 1);
  assert.equal(s.requests[0]?.req.cwd, "/sandbox/repo", "ran in the disposable copy, not the real repository");
  assert.equal(s.requests[0]?.req.execute, true);
  assert.equal(s.requests[0]?.req.webSearch, false);
  assert.equal(s.requests[0]?.req.tier, "verification-grade");
  assert.equal(cleaned, 1);
  const e = events.events.find((x) => x.event === "application_check");
  assert.deepEqual([e?.data["met"], e?.data["unmet"], e?.data["passed"]], [1, 1, false]);
});

test("application agent: a provider that cannot answer FAILS the check (could not verify != passed), after cleanup", async () => {
  const repoDir = await tempGitRepo();
  let cleaned = 0;
  const events = new MemoryEventSink();
  const v = await runApplicationAgent({ repoDir, prd: samplePrd(), specMarkdown: "", prdPath: "p", specPath: "s", contextPath: "c", provider: "codex-cli", textCall: scriptedTextCall([new InternalError("down")]).call, events, timeoutMs: 1000, sandboxFactory: () => Promise.resolve({ dir: "/x", cleanup: () => { cleaned += 1; return Promise.resolve(); } }) });
  assert.equal(v.passed, false);
  assert.match(v.couldNotRun ?? "", /down/);
  assert.equal(cleaned, 1);
  assert.equal(events.events.find((x) => x.event === "application_check")?.data["couldNotRun"], v.couldNotRun);
  assert.match(applicationNotes(v)[0] ?? "", /could NOT be carried out/);
});

test("application agent: a sandbox that cannot be deleted (EPERM on a folder the Codex sandbox user created) is logged and left behind, and the verdict still comes back", async () => {
  const repoDir = await tempGitRepo();
  const events = new MemoryEventSink();
  const sandbox = { dir: "/sandbox/repo", cleanup: () => Promise.reject(new Error("EPERM: operation not permitted, scandir '.../repo/.pytest_cache'")) };
  const reply = JSON.stringify({ criteria: [{ id: "AC1", status: "met", summary: "ok", evidence: ev() }] });
  const v = await runApplicationAgent({ repoDir, prd: samplePrd(), specMarkdown: "", prdPath: "p", specPath: "s", contextPath: "c", provider: "claude-code", textCall: scriptedTextCall([reply]).call, events, timeoutMs: 1000, sandboxFactory: () => Promise.resolve(sandbox) });
  assert.ok(v.results.length > 0, "the verdict was not lost");
  const left = events.events.find((x) => x.event === "application_sandbox_leftover");
  assert.match(String(left?.data["reason"]), /EPERM/);
  assert.equal(left?.data["dir"], "/sandbox/repo");
  assert.ok(events.events.some((x) => x.event === "application_check"));
});

test("the sandbox is a real git clone of the COMMITTED state only, and is removed on cleanup", async () => {
  const repoDir = await tempGitRepo();
  await writeFile(`${repoDir}/untracked.txt`, "not committed", "utf8");
  const sb = await createSandbox(repoDir);
  assert.ok((await stat(`${sb.dir}/README.md`)).isFile());
  await assert.rejects(stat(`${sb.dir}/untracked.txt`), "uncommitted files are not in the copy");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sb.dir }).toString().trim();
  assert.equal(head, execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim());
  await sb.cleanup();
  await sb.cleanup(); // idempotent
  await assert.rejects(stat(sb.dir));
  await assert.rejects(createSandbox(`${repoDir}/does-not-exist`), (e: unknown) => e instanceof StageError && /git clone failed/.test(e.message));
});

test("application report: evidence.json + a plain-language report.md; notes say how many requirements worked", async () => {
  const repoDir = await tempGitRepo();
  const v = evaluateEvidence(criteria, ApplicationReportSchema.parse({ criteria: [{ id: "AC1", status: "met", summary: "worked", evidence: ev("node wc.js a.txt", "a.txt: 5") }, { id: "AC2", status: "unmet", summary: "crashed", evidence: [] }] }));
  const dir = await writeApplicationReport(repoDir, "r9", v);
  assert.equal(dir, "runs/r9/application");
  const md = await readFile(`${repoDir}/${dir}/report.md`, "utf8");
  assert.match(md, /\*\*Failed\*\* -- 1 requirement\(s\) not met\./);
  assert.match(md, /## AC1:[\s\S]*node wc\.js a\.txt/);
  assert.equal(JSON.parse(await readFile(`${repoDir}/${dir}/evidence.json`, "utf8")).passed, false);
  assert.deepEqual(applicationNotes(v).slice(0, 1), ["1 of 2 requirements were seen working when the finished project was run."]);
  assert.match(buildApplicationPrompt({ criteria, contextPath: "c", specPath: "s", prdPath: "p" }), /You are checking, not fixing[\s\S]*No evidence, no 'met'/);
});

// ---------------------------------------------------------------- the execute capability

test("only providers that declare `execute` can serve an execute call; claude gets Bash and codex a writable scratch sandbox ONLY then", async () => {
  const claude = ADAPTER_REGISTRY["claude-code"];
  const codex = ADAPTER_REGISTRY["codex-cli"];
  const agy = ADAPTER_REGISTRY["antigravity-cli"];
  assert.ok(isTextCapable(claude) && isTextCapable(codex) && isTextCapable(agy));
  const req = (execute: boolean) => ({ prompt: "p", cwd: "/r", timeoutMs: 1000, tier: "verification-grade" as const, webSearch: false, modelOverride: null, execute });
  const tools = (execute: boolean) => { const a = claude.buildTextInvocation(req(execute)).args; return a[a.indexOf("--tools") + 1]; };
  assert.equal(tools(false), "Read,Glob,Grep");
  assert.equal(tools(true), "Read,Glob,Grep,Bash");
  assert.ok(!/\b(Edit|Write)\b/.test(tools(true) ?? ""), "never a file-edit tool");
  const sandboxMode = (execute: boolean) => { const a = codex.buildTextInvocation(req(execute)).args; return a[a.indexOf("--sandbox") + 1]; };
  assert.equal(sandboxMode(false), "read-only");
  assert.equal(sandboxMode(true), "workspace-write");
  assert.equal(agy.textCapabilities.execute, false);

  let spawned = false;
  const call = makeTextCall({ runProcessFn: () => { spawned = true; return Promise.resolve(raw()); } });
  const refused = await call("antigravity-cli", req(true), "application");
  assert.equal(refused.outcome.ok, false);
  assert.match(refused.outcome.failure?.message ?? "", /cannot run commands/);
  assert.equal(spawned, false);
  void FAKE_SPEC_REPLY;
});
