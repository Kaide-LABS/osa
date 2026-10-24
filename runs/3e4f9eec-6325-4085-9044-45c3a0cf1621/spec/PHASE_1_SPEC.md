# Phase 1 — scope signal and the `defaulted` assumption tag

## Goal
Extend OSA's intake data model and baby-PRD serialization so that: (a) intake classifies prompt `scope` as `narrow` or `broad` and, when broad, returns up to three recommended questions each with a best-guess default; (b) a third assumption risk value `defaulted` flows losslessly through render/parse/counts/backstop and every Phase-1 consumer; and (c) optional `answers` can be supplied so that answered questions are folded in and unanswered recommended questions become `defaulted` assumptions. No new model call, no new dependency.

## Scope
In: `src/domain/intake.ts`, `src/osa/baby-prd.ts`, `src/osa/intake.ts`, `src/osa/pipeline.ts` (`counts()` + `OsaRunReport.assumptions`), `src/osa/fixtures.test.ts`, and Phase-1 tests. Out: lock changes, pipeline sequencing, `spec-gate.json`, TL;DR, CLI gate, MCP tools, README/CONFLICTS (all later phases).

---

## Part A (first agent)

Deliver the core data-model and serialization changes plus intake wiring, with the minimum tests that prove each piece works. Commit by explicit path.

### Files and changes

**`src/domain/intake.ts`**
- Widen the risk tuple:
  `export const ASSUMPTION_RISKS = ["safe", "risky", "defaulted"] as const;` (keep `AssumptionRisk` derived from it). `AssumptionSchema.risk` therefore becomes `z.enum(ASSUMPTION_RISKS)` accepting all three. `hasRiskyAssumption` is unchanged (it only checks `=== "risky"`).
- Add scope:
  `export const SCOPES = ["narrow", "broad"] as const;` and `export type Scope = (typeof SCOPES)[number];`
- Add a recommended-question schema:
  ```ts
  export const RecommendedQuestionSchema = z.strictObject({
    question: z.string().trim().min(1).max(300),
    default: z.string().trim().min(1).max(500),
  });
  export type RecommendedQuestion = z.infer<typeof RecommendedQuestionSchema>;
  ```
- Extend `BabyPrdSchema` (the `z.strictObject`) with two known keys, both with defaults so older/hand-edited markdown still parses:
  `scope: z.enum(SCOPES).default("narrow"),`
  `recommendedQuestions: z.array(RecommendedQuestionSchema).max(3).default([]),`

**`src/osa/baby-prd.ts`**
- `renderBabyPrd`:
  - Insert a `## Scope` section immediately after the `## TL;DR` block, body = a single line, the scope value (`narrow` or `broad`).
  - In the `## Assumptions` block, render order `[...risky, ...defaulted, ...safe]` (filter a new `defaulted` list the same way `risky`/`safe` are filtered). Each line stays `- [<risk>] <text>`.
  - Insert a `## Recommended questions` section immediately after the `## Assumptions` block and before any `## Original request (authoritative)` section. Each question renders as `- ${noPipe(question)} | ${noPipe(default)}`; render `- (none)` when the array is empty (reuse the `NONE` marker).
- `parseBabyPrd`:
  - Read `top.get("Scope")`: first non-empty trimmed line; if absent, omit (schema default `"narrow"` applies); validation rejects anything not in `SCOPES`.
  - Extend the assumption prefix regex to `/^\[(risky|safe|defaulted)\]\s+(.*\S)$/i` and map the captured tag (lower-cased) to the risk value. The existing "must start with [risky] or [safe]" error message must now read `[risky], [safe] or [defaulted]`.
  - Read `top.get("Recommended questions")` via `listItems`; for each item split on the first `|` into `{ question, default }` (trim both); throw an `IntakeError` in the same plain-language style if an item has no `|`. Absent section → omit (schema default `[]`).
- Keep the request section as the last section.

**`src/osa/intake.ts`**
- In `SCHEMA_DESCRIPTION`, add two keys to the JSON shape shown to the model (keep assumptions as `"safe | risky"` — the model never emits `defaulted`):
  - `"scope": "narrow | broad -- 'broad' when the prompt is vague/open-ended (e.g. 'build the next Instagram'), 'narrow' when it is specific enough to build from"`
  - `"recommendedQuestions": [{ "question": "a short question whose answer would most change the build", "default": "your single best-guess answer, used as-is if the person does not answer" }]`
- In `buildIntakePrompt`, add rule lines: broad prompts get up to 3 recommended questions each with a best-guess default; narrow prompts get `scope: "narrow"` and an empty `recommendedQuestions`; the questions are a nudge, the run proceeds on the defaults if unanswered — never phrase them as blocking. (Do NOT quote timing numbers here.)
- Add optional `answers` to `IntakeInput`:
  `readonly answers?: Readonly<Record<string, string>>;`
  When present and non-empty, `buildIntakePrompt` appends a block:
  ```
  === CLARIFICATIONS FROM THE PERSON ===
  Clarifications from the person:
  - <question>: <answer>
  ...
  Treat each clarification as a stated requirement, not an assumption.
  ```
- Add a normalisation step (extend `normalisePlan` or add a sibling called from `runIntake` after parse, before backstop): when `scope === "narrow"`, force `recommendedQuestions` to `[]`; otherwise truncate to the first 3.
- After the model reply is parsed and the backstop applied, derive defaulted assumptions deterministically: for each `recommendedQuestions[i]` whose `question` is NOT a key of `input.answers`, append `{ text: q.default, risk: "defaulted" }` to `assumptions`. Answered questions add nothing. Append these AFTER the backstop so they are never scanned/upgraded. (The backstop only upgrades `safe`, so `defaulted` is safe regardless; keep the append order anyway for clarity.)
- Update the `assumptions_generated` event payload to include `defaulted: tagged.assumptions.filter((a) => a.risk === "defaulted").length`.

**`src/osa/baby-prd.ts` — `applyRiskBackstop`**
- No behavioural change needed beyond the enum widening: the guard is `a.risk === "safe" && ...`, so `defaulted` is already untouched. Add a one-line comment stating the backstop must never upgrade `defaulted`.

**`src/osa/pipeline.ts`**
- `counts()` returns `{ risky: number; safe: number; defaulted: number }` (compute each by filter; `safe` = total − risky − defaulted, or an explicit filter). Update the `OsaRunReport.assumptions` type at line ~152 to include `readonly defaulted: number`. Callers pass the object through unchanged.

**`src/osa/fixtures.test.ts`**
- Extend `samplePrd` so the default remains a narrow PRD (`scope: "narrow"`, `recommendedQuestions: []`) — existing tests must be unaffected. Add an option, e.g. `samplePrd({ broad: true })`, returning `scope: "broad"` with 1–3 `recommendedQuestions`. Do not change existing fields or the existing `risky` option's behaviour.

### Interfaces and behaviour (Part A)
- `BabyPrd` now carries `scope: Scope` and `recommendedQuestions: RecommendedQuestion[]`.
- `runIntake(input, deps)` with a narrow fake reply returns `scope "narrow"`, `recommendedQuestions []`; with a broad fake reply returns `scope "broad"` and 1–3 questions, and (no answers) one `defaulted` assumption per question using its default text.
- `renderBabyPrd`/`parseBabyPrd` round-trip scope, recommended questions, and all three risk values.

### Tests (Part A) — add to existing files
- `baby-prd.test.ts`: a PRD with one `safe`, one `risky`, one `defaulted` assumption, `scope "broad"`, and two recommended questions renders and `parseBabyPrd(renderBabyPrd(prd))` deep-equals it (assumptions compared as a set, as the existing round-trip test does). Assert the rendered order risky→defaulted→safe.
- `baby-prd.test.ts`: `renderBabyPrd` contains `## Scope`, the scope value, and `## Recommended questions` with `question | default` lines.
- `intake.test.ts`: broad fake reply → `r.prd.scope === "broad"`, `recommendedQuestions.length` in 1..3; `assumptions_generated` event carries a `defaulted` count.
- `intake.test.ts`: narrow fake reply → `scope === "narrow"`, `recommendedQuestions` empty, no `defaulted` assumptions.

### Commit (Part A)
Stage only the touched `src/...` paths. One local commit, author `Kaide-LABS <Hafeedh.balogun@gmail.com>`, no co-author/generated lines. Run `npm run typecheck` and the touched tests before committing.

---

## Part B (second agent)

Build on Part A's commit. Deliver the edge cases, their tests, error handling, and the end-to-end round-trip/answers tests. Commit by explicit path.

### Files and changes
- `src/osa/baby-prd.ts`: harden parsing edge cases surfaced by tests — a `## Recommended questions` item with no `|` throws an `IntakeError` in the existing plain-language style; an invalid `## Scope` value (not `narrow`/`broad`) produces a clear `IntakeError` via schema validation; empty recommended questions render/parse through the `(none)` marker to `[]`. Fix any ordering/escaping bug the tests expose (e.g. a `|` inside a question being replaced by `/`).
- `src/osa/intake.ts`: finalise `answers` handling — the clarifications block appears in the prompt only when `answers` is non-empty; keys that match no recommended question are ignored (not errored); questions are capped at 3 and cleared when narrow. Ensure `defaulted` assumptions use the default text verbatim (no rephrasing).
- `src/osa/fixtures.test.ts`: add any small builder helpers the Part B tests need (e.g. a broad PRD whose recommended questions have known `question` strings for answer-matching). Do not weaken Part A fixtures.

### Interfaces and behaviour (Part B)
- Answered vs unanswered: with `answers` keyed by exact `question` strings, answered questions yield no `defaulted` assumption; unanswered ones do.
- Non-matching answer keys are silently ignored.
- `narrow` scope never carries recommended questions even if the model returns some; broad scope truncates to 3.

### Tests (Part B)
- `intake.test.ts`: broad prompt, `answers` covering one of two recommended questions → the answered question is NOT `defaulted`; the other IS; and the built prompt (`requests[0].req.prompt`) matches `/Clarifications from the person:/`.
- `intake.test.ts`: `answers` with a key matching no question is ignored (all questions still become `defaulted`); empty `answers` behaves like no answers.
- `intake.test.ts`: model returns 5 recommended questions and `scope "broad"` → normalised to 3 (and exactly 3 `defaulted` assumptions with no answers); model returns `scope "narrow"` with questions → normalised to `[]`, no `defaulted`.
- `baby-prd.test.ts`: full byte-stability — `renderBabyPrd(parseBabyPrd(renderBabyPrd(prd)))` is identical to `renderBabyPrd(prd)` for a PRD with all three risk values, broad scope, and recommended questions (true round-trip). Also: a `## Recommended questions` line missing its `|` throws `IntakeError`; an invalid `## Scope` value throws `IntakeError`.
- `baby-prd.test.ts`: `applyRiskBackstop` never changes a `defaulted` assumption to `risky` — feed a `defaulted` assumption whose text contains a risk-signal word (e.g. "password") and assert it stays `defaulted` (AC 5).
- `pipeline` / unit for `counts()`: a PRD with 1 risky, 2 safe, 1 defaulted reports `{ risky: 1, safe: 2, defaulted: 1 }` (AC 4). (Export or test `counts` via the smallest seam already available; if `counts` is not exported, add a dedicated test through the nearest public surface rather than exporting new API unnecessarily — prefer a focused assertion that the report's `assumptions` object separates all three.)

### Commit (Part B)
Stage only the touched `src/...` paths. One local commit, author `Kaide-LABS <Hafeedh.balogun@gmail.com>`, no co-author/generated lines. Run `npm run typecheck`, the touched tests, and `node src/cli/main.ts doctor --boundary` (expect 0 violations) before committing.

---

## Acceptance-criteria mapping (Phase 1)
- **AC 2** (broad→scope broad + 1–3 questions each with a default; narrow→narrow + empty): Part A intake tests + Part B normalisation tests.
- **AC 3** (unanswered→defaulted; answered→not, intake re-runs once): Part A (no-answers path) + Part B answers tests; the caller-driven second invocation is realised in Phases 2–3, the derivation and clarifications block ship here.
- **AC 4** (render→parse round trip with safe/risky/defaulted byte-for-byte; `counts()` separates each): Part A round-trip test + Part B byte-stability and `counts()` tests.
- **AC 5** (backstop never defaulted→risky): Part B backstop test.
- **AC 1** (`npm run check` green: typecheck, full suite, 0 boundary violations): run at the end of Part B; Phase 1 adds no boundary-sensitive code.
- **AC 15** (no staging of `osa.config.json`/`runs/`/`.osa/`; per-phase local commit with the stated author, no co-author/generated lines): both commits.

## Documentation sources
- https://zod.dev
- https://zod.dev/api
- https://zod.dev/v4/changelog
- https://nodejs.org/api/typescript.html
- https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html
- https://nodejs.org/api/test.html

## Out of scope for this phase
- Any lock change, auto-lock, pipeline sequencing, `stopAfterSpec`/`fromSpec`, or `spec-gate.json` (Phase 2).
- The deterministic TL;DR and the CLI post-spec gate / `--yes` / `--accept-risky` behaviour (Phase 2).
- MCP tool reshaping, durable jobs, tool descriptions, surfaces test re-pin (Phase 3).
- `docs/osa/CONFLICTS.md` entries and README updates (Phase 4).
- Any new model, classifier, or dependency; any version bump, publish, push, or tag; starting a real provider run or build.

## Spec assumptions

Gaps found while writing this spec were resolved as follows (nobody was asked):

- The new BabyPrd fields use the codebase's existing camelCase convention: `scope` and `recommendedQuestions`, each question object being `{ question, default }`. The PRD's prose spelling `recommended_questions` is treated as conceptual, not a literal identifier (every other BabyPrd field — `inScope`, `outOfScope`, `acceptanceCriteria`, `researchPlan`, `docsTargets` — is camelCase).
- `scope` and `recommendedQuestions` are added to `BabyPrdSchema` (in `src/domain/intake.ts`), are rendered into `baby-prd.md` and parsed back, so the full render→parse round trip stays lossless. `scope` defaults to `"narrow"` and `recommendedQuestions` to `[]` when a (possibly older / hand-edited) markdown omits them.
- The model is NOT instructed to emit `"defaulted"`; the intake JSON schema keeps `"risk": "safe | risky"` for assumptions. `"defaulted"` is derived deterministically in OSA code from recommended questions the person did not answer. `AssumptionSchema.risk` (the parse/validate enum) is widened to accept all three values so constructed and parsed-from-markdown assumptions validate.
- `counts()` lives in `src/osa/pipeline.ts` (not `baby-prd.ts`), as does `OsaRunReport.assumptions`. Both gain a `defaulted: number` field; this is additive and does not break existing callers. The research report's grouping of `counts()` under baby-prd is treated as descriptive; the actual repo wins.
- Recommended questions are rendered with ` | ` as the field separator, reusing the research-item `noPipe` convention; a literal `|` inside a question or default is replaced with `/` on render (the same lossy-but-documented behaviour already applied to research-item titles/questions).
- Assumptions render in the order risky, then defaulted, then safe. The parse accepts `[risky]`, `[safe]` and `[defaulted]` prefixes (case-insensitive).
- Section placement in `baby-prd.md`: `## Scope` immediately after `## TL;DR`; `## Recommended questions` immediately after `## Assumptions` and before `## Original request (authoritative)`. Empty recommended-questions render as the existing `(none)` marker and round-trip to `[]`.
- `runIntake` gains an optional `answers` map on `IntakeInput`. A non-empty map appends a `=== CLARIFICATIONS FROM THE PERSON ===` block (labelled "Clarifications from the person:") to the intake prompt. After the (single) model call per invocation, each recommended question whose exact `question` string is NOT a key in `answers` becomes a `defaulted` assumption whose text is the question's `default`, used verbatim. Answered questions produce no defaulted assumption.
- The "intake re-runs once" when answers are supplied is realised as the caller invoking `runIntake` a second time with the `answers` populated; each `runIntake` invocation still makes exactly one primary model call (plus the existing single validation retry). The caller-driven re-run is wired by the pipeline/MCP layers in Phases 2–3; Phase 1 delivers the `answers` input, the clarifications block, and the deterministic defaulted-derivation.
- `answers` keys are matched to recommended questions by exact `question`-string equality; a key that matches no recommended question is ignored, not an error.
- Recommended questions are capped at 3 by truncating any surplus (no assumption is recorded for the truncation). When `scope` is `"narrow"`, `recommendedQuestions` is normalised to `[]` even if the model returned some, satisfying "empty when narrow".
- The nudge wording that quotes measured timings (~20-minute research+spec run, etc.) belongs to the CLI gate (Phase 2) and MCP tool descriptions (Phase 3). The Phase 1 intake prompt only teaches the model to classify scope and to produce up to 3 recommended questions with best-guess defaults.
- The test runner is the built-in `node:test` with `node:assert/strict`, matching every existing `*.test.ts`; the fake `textCall` seam is `scriptedTextCall` from `src/osa/fixtures.test.ts` and the sample PRD builder is `samplePrd`.
