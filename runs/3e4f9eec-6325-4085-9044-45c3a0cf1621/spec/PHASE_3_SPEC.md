# Phase 3 — the MCP flow becomes plan → spec → confirm → build

## STATUS AT RESTART (read first; this overrides the Part A / Part B split below)
An earlier attempt at this phase already COMMITTED Part A (commit `c115aef`, files `src/mcp/tools/osa.ts`, `src/mcp/tools/osa.test.ts`, `src/osa/pipeline.ts`) and then stopped. Do NOT redo Part A. Read `git show c115aef` and the current files first. Typecheck is clean; `node --test src/mcp/tools/osa.test.ts` has 3 failures to fix:
1. `osa_plan: returns the plan and its fingerprint...` expects the `next_step` text to match `/explicit yes/`; it now says "Show the person this plan (risky assumptions first), then call osa_spec (or call osa_plan again to refine it)". FIX THE PRODUCT TEXT, not the test: `next_step` must tell the assistant to call `osa_spec` only on the person's explicit yes (keep the recommended-questions wording too).
2. `the tools are registered on the server with the descriptions...` expects the `osa_plan` description to match `/show the person the plan/`. FIX THE PRODUCT TEXT: keep that safety sentence in the `osa_plan` description (and an equivalent "never call osa_spec without their explicit yes").
3. `osa_spec starts a background job that reaches the gate, and osa_status returns awaiting_confirmation...` gets state `finished` instead of `awaiting_confirmation`. Find out whether the test's fake `run` never waits on `deps.gateIo.confirm()` (a test bug: it must call `gateIo.show(...)`, write/obtain the spec gate record, then `await gateIo.confirm()`), or whether `makeWaitingGate` / the `pendingGates` / `mcp-gate.json` logic is wrong (a product bug). Fix whichever it is and say which in the handoff.

THE NEW SPLIT FOR THIS RESTART: the FIRST agent fixes the three failures above AND implements Part B items 1-3 (the rewritten `osa_build` with the spec-hash checks, the tool descriptions, the registration) and commits. The SECOND agent implements Part B item 4 (the new/replaced `osa_build` tests and the full plan → spec → status → build → status round trip), the pinned tool-list tests in `src/code-index/surfaces.test.ts` and `src/mcp/server.test.ts`, and runs the final checks (item 5), fixing anything red. Each agent writes its handoff file at EXACTLY the path its prompt gives (an earlier attempt crashed because a handoff was written one directory too high).

## Goal
Make the one-shot flow over MCP match the agreed gate design (docs/osa/CONFLICTS.md S-11, which Phases 1-2 implemented in the pipeline and CLI): `osa_plan` stays fast (intake only) and now returns the scope and the recommended questions; a NEW `osa_spec` locks the PRD automatically and runs research + spec (+ agents) in the background; when the spec is written the run WAITS at the post-spec gate and `osa_status` reports `awaiting_confirmation` with the deterministic TL;DR and a spec hash; `osa_build` takes that hash plus the person's decision and releases the waiting run into the build (or cancels). No model call is added anywhere.

## Why this shape (do not re-derive)
- `fromSpec` in `src/osa/pipeline.ts` is still a stub (it returns "TL;DR assembly not yet implemented"). Do NOT build on it and do NOT try to finish it in this phase.
- MCP background jobs already live in the server process (`jobs` map in `src/mcp/tools/osa.ts`). So the pipeline simply runs ONCE per run in the background, and its post-spec gate (`deps.gateIo.confirm()`) is a promise that `osa_build` resolves. The gate IO seam already exists: `OsaDeps.gateIo` takes precedence over `deps.io` (see the gate section of `runOsaCommand`).
- If the server restarts while a run waits, the run is `interrupted` (as today for a running build); the files up to the spec remain. That is accepted.

## Scope
In: `src/mcp/tools/osa.ts`, `src/mcp/tools/osa.test.ts`, `src/mcp/server.ts` (only if registration needs it), `src/code-index/surfaces.test.ts` and `src/mcp/server.test.ts` (tool list pins), `src/osa/pipeline.ts` (ONLY to add `answers` to `OsaCommandOptions` and pass it to `runIntake`). Out of scope: the CLI, `fromSpec`, the README/CONFLICTS docs (Phase 4), any change to the gate semantics in `lock.ts`.

---

## Part A (first agent)

Deliver `osa_plan` changes, `osa_spec`, the gate-waiting machinery and the `osa_status` extensions. Commit by explicit path. Do not touch `osa_build` beyond what compiles.

### 1. `answers` through the pipeline (`src/osa/pipeline.ts`)
- Add `readonly answers?: Readonly<Record<string, string>>;` to `OsaCommandOptions` (doc comment: answers to intake's recommended questions, keyed by the question text) and pass `answers: opts.answers` into the `runIntake` input only when defined (`RunIntakeInput.answers` already exists, Phase 1).

### 2. `osa_plan` (`src/mcp/tools/osa.ts`)
- `PlanInput` gains `answers: z.record(z.string(), z.string()).default({})` (question text → answer). Persist them in `plan-request.json` (extend `PlanRequestFile` with `answers`, defaulting to `{}` so older files still parse).
- `PlanOutput` gains `scope: z.enum(["narrow","broad"])`, `recommended_questions: z.array(z.strictObject({ question: z.string(), default: z.string() }))` and `defaulted_assumptions: z.array(z.string())`. `safe_assumptions` must now EXCLUDE `defaulted` ones (today it is "everything not risky").
- `planOsaRun` passes `answers` to `run(...)` and reads `scope` / `recommendedQuestions` from the parsed PRD (`parseBabyPrd`, Phase 1 added them to `BabyPrd`).
- `next_step` text: if `recommended_questions` is non-empty, say they are HIGHLY RECOMMENDED to answer ("saves redoing a ~20 minute research and spec run") and that answering means calling `osa_plan` again with `answers`; otherwise say to call `osa_spec`. Say the person is never required to answer: skipping accepts the defaults, which are listed as defaulted assumptions.

### 3. `osa_spec` (new tool, same file)
- `SpecInput = { repo_dir, run_id, plan_sha256, decision: "go" | "cancel" }`; `SpecOutput = { run_id, status: "started" | "cancelled", message }`.
- `startOsaSpec(input, deps)` mirrors today's `startOsaBuild` guards: plan exists (`plan-request.json`), not already decided/running, plan file present, `plan_sha256` equals both the request file and `sha256String` of the file on disk (same refusal wording as today), repo not busy with another job. `cancel` writes `mcp-result.json` with `cancelled: true` exactly as `startOsaBuild` does today.
- NO risky-assumption check here: risky assumptions are decided at the post-spec gate (that is the whole point of the redesign).
- On `go`: start ONE background job that runs `run({ prompt, files, repoDir, yes: false, json: true, build: true, fromDraft: true, answers: request.answers }, { runId, interactive: true, io: <NO_TERMINAL with choose → "lock">, gateIo, ...deps.pipeline })`, where `gateIo` is a `GateIO` created by a new helper `makeWaitingGate(repoDir, runId)`:
  - `show(text)`: the FIRST call is the TL;DR — write it to `.osa/runs/<id>/mcp-gate.json` as `{ tldr: string[] (text split on newlines), created_at }`. Ignore later `show` calls (the pipeline's gate re-shows the PRD).
  - `confirm()`: returns a promise stored in a module-level `pendingGates: Map<runId, { resolve(approved: boolean): void }>`; it settles when `osa_build` decides. Remove the entry when settled.
  - The job's `finally` must also drop the `pendingGates` entry and, if one is still pending when the pipeline throws, resolve it `false`.
- Result file handling is unchanged: when the pipeline returns (finished, stopped, cancelled at the gate, or error), the job writes `mcp-result.json` and deletes itself from `jobs`.

### 4. `osa_status` extensions
- `StatusOutput` gains `tldr: z.array(z.string()).nullable()`, `spec_sha256: z.string().nullable()`, `risky_assumptions: z.array(z.string())`, `defaulted_assumptions: z.array(z.string())` (arrays empty and the others null when not applicable). Keep every existing field.
- New state logic, evaluated before the existing `running` branch: if the run has a pending gate (`pendingGates.has(runId)`) and `mcp-gate.json` exists → `state: "awaiting_confirmation"`, `stage: "spec"`, `tldr` from the file, `spec_sha256` = `spec_gate_sha256` read from `.osa/runs/<id>/spec-gate.json` (Phase 2's `SpecGateRecord`; use `specGateRecordPath` / the zod schema from `src/osa/spec-gate.ts`), `risky_assumptions` and `defaulted_assumptions` from `parseBabyPrd` of the run's `baby-prd.md`. Message: show the TL;DR, risky first, and call `osa_build` only on the person's explicit yes.
- A plan with no spec job started stays `awaiting_confirmation` with stage `plan` (today's behaviour) but its message now says to call `osa_spec`.
- Add `spec_written` and `spec_gate_written` (if the event exists; otherwise skip) to `STAGE_OF` as needed so `stage` is right; do not invent events.

### 5. Tests for Part A (`src/mcp/tools/osa.test.ts`)
Use the existing fakes in that file (fake `run`, `pipeline` deps). Cover: `osa_plan` returns `scope`, `recommended_questions`, `defaulted_assumptions`, and `safe_assumptions` excludes defaulted; `answers` reach `run` and `plan-request.json`; `osa_spec` refuses on a wrong `plan_sha256`, on an unknown run, while another job runs; `osa_spec` go starts a job that reaches the gate and `osa_status` then reports `awaiting_confirmation` with a non-empty `tldr` and a 64-hex `spec_sha256`. For the fake pipeline in these tests, a fake `run` can call `deps.gateIo.show(...)` then `await deps.gateIo.confirm()` to simulate the gate (and write a `spec-gate.json` via `writeSpecGate`-compatible content, or use the real helper from `spec-gate.ts`).

---

## Part B (second agent)

Deliver the new `osa_build`, the descriptions, the registration and the pinned-list tests. Commit by explicit path.

### 1. `osa_build` rewritten (breaking change, record it in the handoff)
- `BuildInput = { repo_dir, run_id, spec_sha256 (64 hex), decision: "lock" | "cancel", accept_risky_assumptions: boolean (default false) }`. Remove `plan_sha256` and `spec_only`. `BuildOutput` keeps `{ run_id, status: "started" | "cancelled", message }`.
- `decideOsaBuild(input)` (name your own; keep it pure of MCP types so tests call it directly):
  1. If no entry in `pendingGates` for `run_id` → refusal: no spec is waiting for a decision for this run (call `osa_plan`/`osa_spec`; the server may have restarted).
  2. Recompute the spec manifest hash from disk (`buildSpecManifest` in `src/osa/spec-gate.ts`) and read `spec-gate.json`; if `input.spec_sha256` differs from the recorded `spec_gate_sha256` OR the recomputed hash differs from the recorded one → refusal ("not the spec the person was shown, or a spec file changed after it was shown. Nothing was built."); do NOT resolve the gate.
  3. `cancel` → resolve the pending gate `false` (the pipeline then ends with exit 22 and writes `mcp-result.json`), return `status: "cancelled"`.
  4. `lock` → if the baby PRD has `risky` assumptions and `accept_risky_assumptions` is not true → refusal listing them (same style as today's osa_build refusal). Otherwise resolve the gate `true` and return `status: "started"` with a message saying the build runs in the background, follow with `osa_status`.
- The risky check uses the PRD on disk (`parseBabyPrd`), the same source `osa_status` uses.

### 2. Tool descriptions (exact requirements)
- `osa_plan`: relay `recommended_questions` to the person and say they are highly recommended (saves redoing a ~20 minute run); skipping is fine; to apply answers call `osa_plan` again with `answers`; never call `osa_spec` without the person's yes to proceed.
- `osa_spec`: starts research and spec in the background (about 20 minutes); returns immediately; follow with `osa_status`; builds NOTHING.
- `osa_build`: only after `osa_status` shows `awaiting_confirmation` at stage `spec`, and only after the person has seen the TL;DR (risky assumptions first) and said yes; pass the `spec_sha256` from `osa_status`; **never set `accept_risky_assumptions` yourself — only after the person has read and accepted each risky assumption**.
- `osa_status`: describe the new fields.

### 3. Registration and pinned lists
- `registerOsaTools` registers `osa_plan`, `osa_spec`, `osa_build`, `osa_status` (4 osa tools). Update the tool-list assertions in `src/code-index/surfaces.test.ts` and `src/mcp/server.test.ts`: this is a REVERSED CONTRACT (two-step plan/build becomes plan/spec/build), so those assertions are REPLACED to include `osa_spec`, not weakened or removed; say so in the handoff. Update `src/cli/main.test.ts` only if it pins the tool list.

### 4. Tests for Part B (`src/mcp/tools/osa.test.ts`)
Replace the old `osa_build` tests (they pinned `plan_sha256`/`spec_only`) with: build refused when no spec is waiting; refused on a wrong `spec_sha256`; refused when a spec file is changed after the TL;DR was shown (modify a file under `runs/<id>/spec/` after the gate is reached); refused with risky assumptions unless `accept_risky_assumptions`; `lock` resolves the gate and the fake pipeline continues to its result so that `osa_status` ends `finished`; `cancel` ends the run `stopped`/cancelled without building; a full plan → spec → status(awaiting) → build → status(finished) round trip using fakes.

### 5. Final checks (both parts)
`npm run typecheck`, `node --test src/mcp/**/*.test.ts src/osa/*.test.ts src/code-index/surfaces.test.ts`, and the boundary scan (`node src/cli/main.ts doctor --boundary`) must be clean. Never weaken, skip or delete a test; replacing one that pinned the reversed two-step contract is allowed and must be named in the handoff. No new dependency. TypeScript type stripping rules apply (no enums, no parameter properties). Windows: write files with the edit tools, not shell redirection.

## Acceptance criteria
1. `osa_plan` output has `scope`, `recommended_questions`, `defaulted_assumptions`; `safe_assumptions` has no defaulted item.
2. `osa_spec` go returns immediately; the run reaches the post-spec gate; `osa_status` then reports `awaiting_confirmation`, stage `spec`, a TL;DR and a 64-hex `spec_sha256`.
3. `osa_build` refuses without a waiting spec, on a wrong hash, on a changed spec file, and on risky assumptions without `accept_risky_assumptions`.
4. `osa_build` lock releases the build; cancel ends the run without building; `osa_status` reflects both.
5. Tool descriptions contain the three required instructions (relay questions as highly recommended; show the TL;DR before building; never set `accept_risky_assumptions` yourself).
6. Typecheck, the listed tests and the boundary scan are green; no test was weakened.
