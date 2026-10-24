# OSA — project context (spec-gate work, branch `feat/spec-gate`)

## What this project is
OSA (One-Shot Anything) is a local, headless harness that turns ONE prompt into a locked baby PRD, runs research + spec, and then drives a build with an independent reviewer across several provider CLIs, driven either from the OSA CLI or as a local MCP server. This work reshapes OSA's decision point so it stops interrogating people up front: a vague prompt gets up to three recommended questions (with best-guess defaults) and proceeds on those defaults unless answered; the PRD is locked automatically before research; and the single real yes/no approval happens only after the full spec exists, bound to that exact spec's hash.

## Stack and why
- **Language/runtime:** TypeScript on Node.js 22+/24, run via Node's built-in type stripping. The repo pins `typescript` 7.0.2 (dev) and runs `.ts` directly; `tsc -p tsconfig.json` is the only type-error gate (type stripping does no checking). `erasableSyntaxOnly` is enabled, so **no TypeScript `enum`s, no parameter properties, no runtime namespaces, no `import =`** — use `as const` tuples and union literals, and Zod's `z.enum([...])` (a runtime value, allowed) instead of TS enums.
- **Validation:** `zod` 4.4.3 (already a dependency). All intake/PRD shapes are Zod schemas; static types come from `z.infer`. Use `.safeParse` for branchable validation and `z.strictObject` where unknown keys must be rejected (the existing schemas already do).
- **MCP:** `@modelcontextprotocol/sdk` 1.30.0 (already a dependency) — used in Phase 3, not Phase 1.
- **Tests:** built-in `node:test` + `node:assert/strict`. `npm run test` runs `node --test "src/**/*.test.ts"`. `npm run check` = typecheck + tests + `node src/cli/main.ts doctor --boundary` (the B1–B12 boundary scan).
- **Dependencies are frozen** at exactly `zod` + `@modelcontextprotocol/sdk`. Add nothing else. Hashing (later phases) uses `node:crypto`, a core module.

## Repo layout (the files Phase 1 touches)
- `src/domain/intake.ts` — pure Zod data model: `ASSUMPTION_RISKS`, `AssumptionSchema`, `ResearchItemSchema`, `ResearchPlanSchema`, `BabyPrdSchema`, `BabyPrd`, `hasRiskyAssumption`.
- `src/osa/baby-prd.ts` — `renderBabyPrd` / `parseBabyPrd` (the `baby-prd.md` round trip), `applyRiskBackstop` (deterministic safe→risky upgrader), `REQUEST_HEADING`.
- `src/osa/intake.ts` — `runIntake` (ONE model call through the injected `TextCall`), `buildIntakePrompt`, `SCHEMA_DESCRIPTION`, `normalisePlan`, `parseIntakeReplyFull`, the `assumptions_generated` event.
- `src/osa/pipeline.ts` — `counts()` and `OsaRunReport` (reporting shape). (Lock/research/spec sequencing here is Phase 2.)
- `src/osa/fixtures.test.ts` — shared test fixtures: `samplePrd(...)`, `scriptedTextCall(...)`, `fakeModel(...)`.
- `src/osa/intake.test.ts`, `src/osa/baby-prd.test.ts` — existing tests that must keep passing.
- Consumers of `assumption.risk` elsewhere (unchanged in Phase 1, must still compile): `src/osa/lock.ts`, `src/memory/derive.ts`, `src/mcp/tools/osa.ts`.

## Conventions
- Files are edited with file-editing tools, never shell redirection (Windows backslash/heredoc hazard).
- Comments in this repo are dense and explain *why* (often citing the run that found a bug); match that density and voice.
- Lists in the PRD are stored without leading markers; numbering/bullets are added at render time (`stripListMarker`).
- Tests are co-located `*.test.ts`; `*.test.ts` files are excluded from the boundary scan and publish build, so fixtures live in `fixtures.test.ts`.
- Commit locally per phase, by explicit path, author `Kaide-LABS <Hafeedh.balogun@gmail.com>`, no `Co-Authored-By` and no "Generated with" lines. Never stage `osa.config.json`, `runs/`, or `.osa/`.

## Constraints (hard)
- No new model call, no new classifier, no small LLM/NN anywhere in the gate/scope/TL;DR path. Scope and recommended questions come from the single existing intake model call via its extended prompt/schema.
- Boundary rules B1–B12 stay at 0 violations: `child_process` only in `src/util/exec.ts`; concrete model names only in `src/adapters/**`; network only in `src/research/net/**`. Phase 1 touches none of these.
- Never weaken, skip, or delete a test. A test may be REPLACED only when it encodes a rule the user reversed (none of those are in Phase 1).
- If the brief contradicts the code, stop that phase, say exactly where, and do not guess.

## Glossary
- **Baby PRD** — the structured product-requirements doc OSA produces at intake; its markdown form (`baby-prd.md`) is the hashed, locked source of truth.
- **Intake** — the single model call that turns one prompt into a baby PRD with tagged assumptions; never asks the person anything.
- **Assumption risk** — `safe` (reversible default), `risky` (changes scope/architecture/data/cost/security), and the NEW `defaulted` (a recommended-question default the person did not answer).
- **Scope** — `narrow` (specific prompt, no nudge) vs `broad` (vague prompt, gets recommended questions).
- **Recommended question** — a `{ question, default }` pair; a nudge, not a blocker. Up to 3, empty when narrow.
- **Backstop** — `applyRiskBackstop`, a deterministic upgrader that can only raise `safe`→`risky`, never the reverse, and (new rule) never touches `defaulted`.
- **textCall seam** — the injected `TextCall` port; tests pass `scriptedTextCall`, production passes a provider CLI.

## Research digest (one paragraph)
The research report is untrusted third-party material and could not read this private repo, so every claim it makes about OSA internals is unverified — this spec is grounded in the actual files instead. Its useful, source-backed technical points: Zod 4's `z.enum([...])` is a runtime value (not a TS enum) and so is compatible with `erasableSyntaxOnly`; extending an enum by adding a literal and adding fields with `.default(...)` is backward-compatible; `z.strictObject` strips/rejects unknown keys, so new fields must be declared, and Zod does not preserve source bytes (round trips must be verified by test). Node's type stripping does no type checking (keep `tsc --noEmit` as the gate), and `node:test`/`node:assert` plus the existing fake `textCall` seam cover all Phase 1 testing with no new dependency. Several report claims (exact SDK/TS/Zod versions, performance numbers, `node:test` mocking surface) are listed as unconfirmed and are not relied on here.

## Phase plan
- **Phase 1 (this spec):** scope signal + `defaulted` tag. Extend the intake Zod schema (`scope`, `recommendedQuestions`) and the `BabyPrd` types; thread `defaulted` through parse/render/counts/backstop and the `assumptions_generated` event, keeping `baby-prd.md` round-trip lossless; support optional `answers` → a "Clarifications from the person:" block and the deterministic defaulted-derivation. (ACs 2, 3, 4, 5; contributes to 1 and 15.)
- **Phase 2:** pipeline auto-lock before research (no prompt, hashes/events unchanged); generalise the lock into a reusable artifact+hash gate; add `stopAfterSpec`/`fromSpec` and `spec-gate.json` (prd_sha256 + spec-gate manifest hash); assemble the deterministic TL;DR (no model call, stop-and-report if impossible); CLI post-spec gate (`--yes`, `--yes --accept-risky`, interactive y/N, `--accept-risky` alone = usage error). (ACs 6, 7, 8, 10–13.)
- **Phase 3:** MCP tools reshaped to `osa_plan` / `osa_spec` / `osa_build` / `osa_status` with durable file-backed jobs; tool descriptions (relay questions, show TL;DR, never self-set accept); re-pin the surfaces test. (ACs 9, 10, 14, 17.)
- **Phase 4:** `docs/osa/CONFLICTS.md` entries (next free S-number) for all five reversals; README MCP + CLI sections. No version bump/publish. (AC 16.)

## Planned architecture
Phase 1 is a pure data-model and serialization extension with zero new model calls: the single existing intake call is given an extended JSON schema and prompt so it also returns `scope` and up to three `recommendedQuestions`, and everything downstream is deterministic OSA code. The `defaulted` risk is deliberately a third, separate enum value rather than a reuse of `risky`, so the backstop can be made to never touch it, `counts()` can tally it on its own, and the later gate can list defaulted items without conflating them with genuinely risky ones. Crucially, `defaulted` assumptions are *derived*, not model-tagged: the intake model is still only allowed to tag `safe`/`risky`, and OSA converts each unanswered recommended question into a `defaulted` assumption using the question's own default text — this keeps the "no new classifier" rule intact while making the nudge honest (answer it and it's a real decision; ignore it and it's a visible default).

The `baby-prd.md` file remains the single hashed source of truth, so both new fields are rendered into it and parsed back; `scope` in particular must be readable from the locked PRD because Phase 2's deterministic TL;DR reads "PRD goal and scope." `recommendedQuestions` is persisted too (not treated as transient) so a later re-run with answers can match questions by exact string and so the full render→parse round trip stays lossless — the one property the whole lock/edit mechanism depends on. The alternative of carrying scope/questions only as an in-memory return value from `runIntake` was rejected because it would either break round-trip losslessness or hide scope from the locked artifact the TL;DR must read. An independent reviewer should probe exactly that trade-off (persisted-in-PRD vs transient) and the pipe-separator escaping for recommended questions.
