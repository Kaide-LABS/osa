import { test } from "node:test";
import assert from "node:assert/strict";
import { InternalError, IntakeError } from "../domain/errors.ts";
import { MemoryEventSink } from "./events.ts";
import { REQUEST_MAX_CHARS } from "../domain/intake.ts";
import { buildIntakePrompt, extractJsonObject, extractLinks, runIntake, verifiedQuotes, withRequest, withStatedRequirements } from "./intake.ts";
import { samplePrd, scriptedTextCall } from "./fixtures.test.ts";

const input = {
  prompt: "build a word counter, see https://example.org/spec",
  files: [{ path: "notes.md", content: "must run offline" }],
  memory: null,
  maxItems: 8,
};

function deps(call: ReturnType<typeof scriptedTextCall>["call"], events = new MemoryEventSink()) {
  return { textCall: call, provider: "claude-code" as const, cwd: "/tmp", timeoutMs: 1000, events };
}

test("buildIntakePrompt: what the person stated is a requirement, never an assumption, and an assumption may not contradict it (found by the live e2e run: a stated ASCII-only rule came back as the risky assumption 'includes Unicode letters', so --yes refused a fully specified request)", () => {
  const p = buildIntakePrompt({ ...input, memory: null });
  assert.match(p, /stated explicitly is a REQUIREMENT, not an assumption/);
  assert.match(p, /do NOT list it as an assumption/);
  assert.match(p, /Never write an assumption that contradicts or narrows what they stated/);
  assert.ok(p.indexOf("REQUIREMENT") < p.indexOf("JSON shape:"), "the rule is part of the rules, before the schema");
});

test("buildIntakePrompt forbids questions, defines safe/risky, inlines files, lists links and memory", () => {
  const p = buildIntakePrompt({ ...input, memory: "- prefers pnpm" });
  assert.match(p, /NEVER ask a question/);
  assert.match(p, /"safe"\s+= reversible/);
  assert.match(p, /"risky" = would change scope, architecture, data handling, cost, or security/);
  assert.match(p, /ATTACHED FILE: notes\.md/);
  assert.match(p, /must run offline/);
  assert.match(p, /LINKS PROVIDED[\s\S]*https:\/\/example\.org\/spec/);
  assert.match(p, /PROJECT MEMORY[\s\S]*prefers pnpm/);
});

test("extractLinks / extractJsonObject tolerate fences and surrounding prose", () => {
  assert.deepEqual(extractLinks("a https://x.io/a b https://x.io/a c http://y.io"), ["https://x.io/a", "http://y.io"]);
  assert.deepEqual(extractJsonObject('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => extractJsonObject("no json here"), IntakeError);
});

test("intake with missing info yields tagged assumptions and emits assumptions_generated (WS2.4 test 1)", async () => {
  const { call, requests } = scriptedTextCall([JSON.stringify(samplePrd({ risky: true }))]);
  const events = new MemoryEventSink();
  const r = await runIntake(input, deps(call, events));
  assert.ok(r.prd.assumptions.length >= 2);
  assert.ok(r.prd.assumptions.every((a) => a.risk === "safe" || a.risk === "risky"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.purpose, "intake");
  assert.equal(requests[0]?.req.webSearch, false);
  const ev = events.events.find((e) => e.event === "assumptions_generated");
  assert.equal(ev?.data["risky"], 1);
  assert.equal(ev?.data["safe"], 1);
});

test("intake retries once with the validation errors quoted, then succeeds", async () => {
  const { call, requests } = scriptedTextCall(['{"tldr": []}', JSON.stringify(samplePrd())]);
  const r = await runIntake(input, deps(call));
  assert.equal(requests.length, 2);
  assert.match(requests[1]?.req.prompt ?? "", /YOUR PREVIOUS REPLY WAS REJECTED/);
  assert.equal(r.prd.researchPlan.topic, "Word counting CLI");
});

test("intake fails loudly (IntakeError) after two bad replies, and on provider failure", async () => {
  await assert.rejects(runIntake(input, deps(scriptedTextCall(["nope", "still nope"]).call)), IntakeError);
  await assert.rejects(
    runIntake(input, deps(scriptedTextCall([new InternalError("boom")]).call)),
    (e: unknown) => e instanceof IntakeError && /boom/.test(e.message),
  );
});

test("the deterministic backstop upgrades a safe-tagged password assumption during intake", async () => {
  const prd = { ...samplePrd(), assumptions: [{ text: "Users log in with a password.", risk: "safe" as const }] };
  const r = await runIntake(input, deps(scriptedTextCall([JSON.stringify(prd)]).call));
  assert.equal(r.prd.assumptions[0]?.risk, "risky");
  assert.equal(r.upgraded.length, 1);
});

test("research items beyond research.maxItems are truncated and the truncation is recorded as an assumption", async () => {
  const base = samplePrd();
  const items = Array.from({ length: 5 }, (_, i) => ({ slug: `item-${String(i)}`, title: `T${String(i)}`, question: "q", modules: ["general-web" as const] }));
  const prd = { ...base, researchPlan: { ...base.researchPlan, items } };
  const r = await runIntake({ ...input, maxItems: 3 }, deps(scriptedTextCall([JSON.stringify(prd)]).call));
  assert.equal(r.prd.researchPlan.items.length, 3);
  assert.ok(r.prd.assumptions.some((a) => /limited to the first 3 of 5/.test(a.text)));
});

test("stray list markers a model puts on items are stripped so rendering never doubles them ('1. 1. ...')", async () => {
  const prd = { ...samplePrd(), acceptanceCriteria: ["1. First thing works.", "2) Second thing works.", "- Third thing works."], inScope: ["* Do the thing"] };
  const r = await runIntake(input, deps(scriptedTextCall([JSON.stringify(prd)]).call));
  assert.deepEqual(r.prd.acceptanceCriteria, ["First thing works.", "Second thing works.", "Third thing works."]);
  assert.deepEqual(r.prd.inScope, ["Do the thing"]);
  const { renderBabyPrd } = await import("./baby-prd.ts");
  assert.match(renderBabyPrd(r.prd), /^1\. First thing works\.$/m);
});

test("withRequest / runIntake: the locked PRD carries the person's words verbatim whatever the model wrote, capped at REQUEST_MAX_CHARS (found by the live e2e run: 'ASCII letters only' came back as 'includes Unicode letters')", async () => {
  const asked = "Count words: a word is ASCII letters a-z/A-Z plus apostrophe only.\r\nUnicode letters are separators.";
  const modelReply = { ...samplePrd(), request: "THE MODEL TRIED TO WRITE THIS FIELD ITSELF" };
  const events = new MemoryEventSink();
  const { prd } = await runIntake(
    { prompt: asked, files: [], memory: null, maxItems: 8 },
    { textCall: scriptedTextCall([JSON.stringify(modelReply)]).call, provider: "claude-code", cwd: process.cwd(), timeoutMs: 1000, events },
  );
  assert.equal(prd.request, "Count words: a word is ASCII letters a-z/A-Z plus apostrophe only.\nUnicode letters are separators.", "the person's words, newlines normalised, not the model's");
  const long = withRequest(samplePrd(), "x".repeat(REQUEST_MAX_CHARS + 500));
  assert.ok((long.request ?? "").length <= REQUEST_MAX_CHARS + 100);
  assert.match(long.request ?? "", /not repeated here/);
  assert.equal(withRequest(samplePrd(), "  short  ").request, "short");
});

test("stated requirements: only quotes that are really in the person's prompt are kept (a paraphrase is dropped), and each becomes an acceptance criterion 'exactly as stated'", () => {
  const prompt = "A word is a maximal run of ASCII letters a-z and A-Z plus the apostrophe,\neverything else (digits, punctuation, other Unicode) separates words. A missing file exits with status 2.";
  const kept = verifiedQuotes(prompt, [
    "A word is a maximal run of ASCII letters a-z and A-Z plus the apostrophe,   everything else (digits, punctuation, other Unicode) separates words.",
    "words are made of letters, possibly with accents", // a paraphrase / invention: dropped
    "a missing file exits with status 2.", // case differs: kept
    "A missing file exits with status 2.", // repeat: dropped
    "short", // too short: dropped
  ]);
  assert.equal(kept.length, 2);
  assert.match(kept[0] ?? "", /^A word is a maximal run of ASCII letters/);
  const prd = withStatedRequirements(samplePrd(), kept);
  assert.equal(prd.acceptanceCriteria.length, samplePrd().acceptanceCriteria.length + 2);
  assert.match(prd.acceptanceCriteria.at(-1) ?? "", /^The finished project satisfies this requirement from the request, exactly as stated: "a missing file exits with status 2\."$/);
  assert.deepEqual(withStatedRequirements(samplePrd(), []), samplePrd(), "no quotes, no change");
  const many = withStatedRequirements({ ...samplePrd(), acceptanceCriteria: Array.from({ length: 38 }, (_, i) => `criterion ${String(i)}`) }, ["quote number one ok", "quote number two ok", "quote number three"]);
  assert.equal(many.acceptanceCriteria.length, 40, "never beyond the criteria limit");
});

test("runIntake: the person's own rules end up verbatim in the acceptance criteria even when the model's summary contradicts them (found by the live e2e run: 'ASCII only' became 'includes Unicode letters' in the summary AND the build)", async () => {
  const asked = "Count words. A word is a maximal run of ASCII letters a-z and A-Z plus the apostrophe; other Unicode separates words.";
  const reply = { ...samplePrd(), assumptions: [{ text: "'Letters' includes Unicode letters.", risk: "risky" }], statedRequirements: ["A word is a maximal run of ASCII letters a-z and A-Z plus the apostrophe; other Unicode separates words.", "the model made this quote up entirely"] };
  const { prd } = await runIntake({ prompt: asked, files: [], memory: null, maxItems: 8, quoteStatedRules: true }, { textCall: scriptedTextCall([JSON.stringify(reply)]).call, provider: "claude-code", cwd: process.cwd(), timeoutMs: 1000, events: new MemoryEventSink() });
  const added = prd.acceptanceCriteria.filter((c) => c.startsWith("The finished project satisfies this requirement from the request"));
  assert.equal(added.length, 1, "the made-up quote was dropped");
  assert.match(added[0] ?? "", /ASCII letters a-z and A-Z plus the apostrophe; other Unicode separates words\./);
  assert.ok(buildIntakePrompt({ prompt: asked, files: [], memory: null, maxItems: 8, quoteStatedRules: true }).includes('"statedRequirements"'), "the model is asked for them");
});

test("buildIntakePrompt describes scope and recommended questions to the model", () => {
  const p = buildIntakePrompt(input);
  assert.match(p, /Scope: classify as 'narrow'/);
  assert.match(p, /When broad, provide up to 3 recommended questions/);
  assert.ok(p.includes('"scope": "narrow | broad'), "schema includes scope field");
  assert.ok(p.includes('"recommendedQuestions":'), "schema includes recommendedQuestions field");
});

test("buildIntakePrompt appends clarifications block when answers are provided", () => {
  const p = buildIntakePrompt({ ...input, answers: { "Question 1": "Answer 1", "Question 2": "Answer 2" } });
  assert.match(p, /=== CLARIFICATIONS FROM THE PERSON ===/);
  assert.match(p, /Clarifications from the person:/);
  assert.match(p, /- Question 1: Answer 1/);
  assert.match(p, /- Question 2: Answer 2/);
  assert.match(p, /Treat each clarification as a stated requirement, not an assumption/);
});

test("buildIntakePrompt does not append clarifications block for empty answers", () => {
  const p = buildIntakePrompt({ ...input, answers: {} });
  assert.ok(!p.includes("CLARIFICATIONS FROM THE PERSON"));
});

test("intake with broad scope yields scope 'broad' and 1-3 recommended questions, no answers -> defaulted assumptions", async () => {
  const reply = samplePrd({ broad: true });
  const { call } = scriptedTextCall([JSON.stringify(reply)]);
  const events = new MemoryEventSink();
  const r = await runIntake(input, deps(call, events));
  assert.equal(r.prd.scope, "broad");
  assert.ok(r.prd.recommendedQuestions.length >= 1 && r.prd.recommendedQuestions.length <= 3);
  const defaultedAssumptions = r.prd.assumptions.filter((a) => a.risk === "defaulted");
  assert.equal(defaultedAssumptions.length, r.prd.recommendedQuestions.length, "one defaulted assumption per unanswered question");
  assert.ok(defaultedAssumptions.every((a) => a.text === r.prd.recommendedQuestions.find((q) => q.default === a.text)?.default));
  const ev = events.events.find((e) => e.event === "assumptions_generated");
  assert.equal(ev?.data["defaulted"], r.prd.recommendedQuestions.length);
});

test("intake with narrow scope yields scope 'narrow' and empty recommended questions, no defaulted assumptions", async () => {
  const reply = samplePrd({ broad: false });
  const { call } = scriptedTextCall([JSON.stringify(reply)]);
  const events = new MemoryEventSink();
  const r = await runIntake(input, deps(call, events));
  assert.equal(r.prd.scope, "narrow");
  assert.deepEqual(r.prd.recommendedQuestions, []);
  assert.ok(r.prd.assumptions.every((a) => a.risk !== "defaulted"), "no defaulted assumptions when narrow");
  const ev = events.events.find((e) => e.event === "assumptions_generated");
  assert.equal(ev?.data["defaulted"], 0);
});

test("intake with answers matching recommended questions does not create defaulted assumptions for those questions", async () => {
  const reply = { ...samplePrd({ broad: true }), recommendedQuestions: [
    { question: "Q1", default: "D1" },
    { question: "Q2", default: "D2" },
  ] };
  const { call } = scriptedTextCall([JSON.stringify(reply)]);
  const events = new MemoryEventSink();
  const r = await runIntake({ ...input, answers: { "Q1": "User Answer 1" } }, deps(call, events));
  const defaultedAssumptions = r.prd.assumptions.filter((a) => a.risk === "defaulted");
  assert.equal(defaultedAssumptions.length, 1, "only Q2 is unanswered");
  assert.equal(defaultedAssumptions[0]?.text, "D2");
});

test("intake normalizes recommended questions: narrow clears them, broad truncates to 3", async () => {
  const manyQuestions = { ...samplePrd({ broad: true }), recommendedQuestions: [
    { question: "Q1", default: "D1" },
    { question: "Q2", default: "D2" },
    { question: "Q3", default: "D3" },
    { question: "Q4", default: "D4" },
    { question: "Q5", default: "D5" },
  ] };
  const { call: call1 } = scriptedTextCall([JSON.stringify(manyQuestions)]);
  const r1 = await runIntake(input, deps(call1));
  assert.equal(r1.prd.recommendedQuestions.length, 3, "truncated to 3");
  assert.equal(r1.prd.assumptions.filter((a) => a.risk === "defaulted").length, 3);

  const narrowWithQuestions = { ...manyQuestions, scope: "narrow" as const };
  const { call: call2 } = scriptedTextCall([JSON.stringify(narrowWithQuestions)]);
  const r2 = await runIntake(input, deps(call2));
  assert.deepEqual(r2.prd.recommendedQuestions, [], "cleared when narrow");
  assert.equal(r2.prd.assumptions.filter((a) => a.risk === "defaulted").length, 0);
});

test("intake with answers to some recommended questions creates defaulted for unanswered ones", async () => {
  const reply = {
    ...samplePrd({ broad: true }),
    recommendedQuestions: [
      { question: "Should it count words, characters, or lines?", default: "words" },
      { question: "How should it handle non-ASCII text?", default: "Count all characters as words if separated by whitespace" },
    ],
  };
  const { call } = scriptedTextCall([JSON.stringify(reply)]);
  const events = new MemoryEventSink();
  const r = await runIntake(
    { ...input, answers: { "Should it count words, characters, or lines?": "lines" } },
    deps(call, events),
  );
  const defaulted = r.prd.assumptions.filter((a) => a.risk === "defaulted");
  assert.equal(defaulted.length, 1, "one question was answered, so only one defaulted assumption");
  assert.equal(defaulted[0]?.text, "Count all characters as words if separated by whitespace", "the unanswered question's default becomes the defaulted assumption text");
});

test("intake with non-matching answer keys ignores them; all questions still become defaulted", async () => {
  const reply = samplePrd({ broad: true });
  const { call } = scriptedTextCall([JSON.stringify(reply)]);
  const events = new MemoryEventSink();
  const r = await runIntake(
    { ...input, answers: { "Question with no match": "ignored answer" } },
    deps(call, events),
  );
  assert.equal(r.prd.assumptions.filter((a) => a.risk === "defaulted").length, r.prd.recommendedQuestions.length, "all questions become defaulted when no answers match");
});

test("buildIntakePrompt includes the built prompt in the request when answers are provided", async () => {
  const { call, requests } = scriptedTextCall([JSON.stringify(samplePrd({ broad: true }))]);
  await runIntake(
    {
      ...input,
      answers: { "Should it count words, characters, or lines?": "lines" },
    },
    deps(call),
  );
  const builtPrompt = requests[0]?.req.prompt ?? "";
  assert.match(builtPrompt, /=== CLARIFICATIONS FROM THE PERSON ===/);
  assert.match(builtPrompt, /Should it count words, characters, or lines\?: lines/);
});
