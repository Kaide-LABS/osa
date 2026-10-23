# OSA -- Current State (pre-change baseline)

Written before any code change, per `OSA_DIRECTIVE.md` Ground Rule 0. Facts here come from reading the
code at commit `456600c` (branch `main`) and from running the toolchain on this machine. Where the
directive and this file disagree, this file is right about *facts*; the disagreements are itemised in
[`CONFLICTS.md`](./CONFLICTS.md).

## 1. What the project is today

`OSA` v0.2.0: a TypeScript / Node >= 24 CLI + stdio MCP server, run directly from `.ts` via
Node's native type stripping (no build step in dev; `tsc -p tsconfig.build.json` only for publish).
Runtime dependencies are allowlisted to exactly `zod` and `@modelcontextprotocol/sdk` (boundary
rule B2).

It does **not** author specs or PRDs. It is a *dispatcher*: given a target repo that already holds
loopr's artifacts (`baby_prd.md`, `context.md`, `PHASE_N_SPEC.md`), it runs each phase as a fixed
sequence of agent turns across two of three provider CLIs, and mechanically verifies the result.

Providers (`src/domain/run.ts` `PROVIDER_IDS`): `claude-code` (`claude -p`), `codex-cli` (`codex exec`),
`antigravity-cli` (`agy`, print mode, stream-json). A run activates exactly two.

Baseline health: `npm run typecheck` clean; `npm test` = **540 passing, 0 failing** (~3 min, dominated by
real provider-CLI preflight probes); Node v24.15.0, git 2.54.0; provider CLIs present locally:
`claude` 2.1.211, `codex-cli` 0.160.0, `agy` 1.3.3.

## 2. Command surface (`src/cli/main.ts`)

| Command | Purpose |
|---|---|
| `doctor [--boundary\|--providers] [--json]` | toolchain + provider preflight + boundary scan + lock smoke test |
| `run --config <json>` | dispatch ONE phase (executor -> executor -> reviewer turn sequence) |
| `drive --config <json>` | dispatch phases 1..N sequentially, one `runDispatch` per phase |
| `evidence --repo-dir --run-id [--final-phase]` | offline re-derivation of AC1/AC2/AC3 from handoff records |
| `mcp` | stdio MCP server exposing `run`/`drive`/`doctor`/`evidence` |
| `setup` | registers the MCP server (+ two optional research MCP servers) in Claude Code user config |

Binary name: `OSA` (`package.json` `bin`). MCP server name: `OSA` (`src/mcp/server.ts`).
There is **no** `osa` command, no free-text prompt entry point, and no project-level config file:
every `run`/`drive` takes a per-invocation JSON file validated by zod (`RunConfig`, `DriveConfig`).
Flag parsing is hand-rolled; unknown flags are always a `UsageError` (exit 2).

## 3. How one run flows end to end

`drive` (`src/dispatch/driver-loop.ts`) -> per phase `runDispatch` (`src/dispatch/run-loop.ts`):

1. **Extended preflight** (`runExtendedPreflight`): provider CLIs present/in-range/authenticated for the
   two active providers; spec/baby_prd/context (+ optional role prompts) readable.
2. **Run lock** (`src/util/lock.ts`, `.osa/run.lock`).
3. **Plan** (`src/dispatch/plan.ts` `planTurnSequence`): fixed three slots -- executor A, executor B,
   reviewer (default: the provider that did *not* author the diff under review; `role_pins` can pin).
4. **Per turn** (`src/dispatch/turn.ts` `runTurn`): capture HEAD -> `adapter.buildInvocation` (pure) ->
   chat-log prompt entry -> `runProcess` (only module that imports `node:child_process`) -> adapter
   `interpretResult` -> chat-log response entry -> `captureTurnLeftovers` (harness commits stray
   changes; needed for Codex-on-Windows sandbox) -> read agent's `HandoffRecord` draft from
   `.osa/runs/<run>/handoff/<phase>/<NNN>-<role>-<provider>.json` -> reconcile against git
   ground truth (`record.ts`) -> `assertLooprArtifactsReferenced` -> reviewer only:
   `assertNextPhaseSpecProduced` -> `assertNeutralCommits` -> persist.
5. **Continuity gating** (`src/verify/continuity.ts`, checks C1..C5) with one bounded retry after a
   `git reset --hard` to the last good commit.
6. Driver then inspects the repo for the next `PHASE_{N+1}_SPEC.md` or `BUILD_COMPLETE.md`
   (states D0..D5, `src/dispatch/driver-state.ts`), appends `driver-log.jsonl`, loops or stops.

Key mechanical guarantees (the "existing guarantees" Ground Rule 5 forbids weakening):

- **Cross-provider review** -- two distinct providers; reviewer = non-author unless pinned, and a
  pinned self-review is surfaced as a `warnings[]` entry, never silent (`plan.ts`, `RunResult.warnings`).
  `executor_providers` must be two *different* ids; `reviewer_provider` must be one of them.
- **Git verification** -- HEAD/branch captured before spawn; commits derived from `head_before..HEAD`;
  R3 (`completed` => >= 1 commit); commit-neutrality check (no AI attribution trailers).
- **File hashing** -- SHA-256 (`src/util/hash.ts`); `artifacts_read` hashed at `head_before` (so loopr
  artifacts **must be committed** at run start), `artifacts_written` hashed from the working tree.
- **Logging** -- two JSONL sinks: `.osa/runs/<driver-id>/driver-log.jsonl` (driver decisions) and
  `.osa/chat-log/<id>.jsonl` (verbatim prompt/response per turn, gitignored by default).
  There is **no** general event log with named events (`prd_locked`, `trim_applied`, ...).
- **Resume** -- `drive` accepts `starting_phase`/`starting_spec_path`; there is no per-item research resume.

## 4. Source map (`src/`, ~9.5k lines non-test, ~54 test files)

- `adapters/` -- `claude-code.ts`, `codex-cli.ts`, `antigravity-cli.ts` (each: `preflight`,
  `resolveEffort`, pure `buildInvocation`, `interpretResult`), `registry.ts`, `conformance.ts` (shared
  adapter contract tests). Only place concrete model names may appear (B7).
- `ports/provider-adapter.ts` -- `ProviderAdapter`, `Invocation`, `PreflightReport`.
- `domain/` -- zod schemas and pure types: `run.ts` (`RunConfig`, `TurnRequest`), `driver.ts`
  (`DriveConfig`, driver states), `relay.ts` (`HandoffRecord` + rules R1..), `roles.ts` (archetypes),
  `errors.ts` (exit-code table 0..18), `chat-log.ts`, `setup.ts`, `tiers.ts`.
- `dispatch/` -- `run-loop.ts`, `driver-loop.ts`, `driver-state.ts`, `turn.ts`, `plan.ts`, `prompt.ts`,
  `record.ts`, `artifacts.ts`, `chat-log.ts`, `acceptance.ts`.
- `verify/` -- `preflight.ts`, `git.ts`, `continuity.ts`, `commits.ts`, `boundary.ts` +
  `boundary-rules.ts` (rules B1..B8 as data).
- `cli/` -- `main.ts` and one file per command. `mcp/` -- server + four tool registrations.
  `setup/` -- MCP-server registration for `OSA setup`. `util/` -- `exec.ts` (the sole
  `node:child_process` importer), `hash.ts`, `lock.ts`, `paths.ts`.

Conventions the new code must follow: ESM + `.ts` import specifiers; `erasableSyntaxOnly` (no `enum`,
no parameter properties); `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`; `node --test`
colocated `*.test.ts`; zod `strictObject` for any persisted/wire shape; modelled failures are
`OsaError` subclasses with stable `exitCode`/`code`; functions return `{report, exitCode}` and
never call `process.exit`; commit messages follow `<type>: <subject>` and carry no
attribution trailers (B8).

## 5. Where the directive's concepts map onto (or are missing from) the code

| Directive concept | State in the code |
|---|---|
| "the run dispatch function is the lock" | `runDispatch` / `runDrive` exist; no pre-dispatch confirmation exists |
| intake / TL;DR / baby PRD | **absent.** `baby_prd.md` is an *input* produced out-of-band by the `loopr` skill's interrogation |
| spec phase (research) | **absent from this repo.** It is loopr's Step 10 (`.claude/agents/loopr-step10.md`), a Claude Code subagent run by a human; this repo only ever sees its output (`PHASE_N_SPEC.md`) |
| step 14 | **absent from this repo's code.** It is loopr's Step 14 (`.claude/agents/loopr-step14.md`), a comprehension pass that writes root-level `COMPREHENSION.md` (192 KB here); `dispatch`/`drive` never invoke it |
| provider `research()` / web search | absent; adapters expose only turn-shaped `buildInvocation(TurnRequest)` |
| network access | **forbidden by boundary rules B3/B4** ("OSA itself makes zero network calls") |
| config files / `osa.config.*` | none; per-run JSON via `--config` only |
| semantic code index / memory | absent |
| trim-1 / any trimming | absent |
| Antigravity dispatch | adapter exists (`--print=` shape fixed in commits `f2aa815`/`5f540be`); see `ANTIGRAVITY.md` |

## 6. Data on disk (target repo)

`.osa/run.lock`; `.osa/runs/<run-id>/handoff/<phase>/*.json`;
`.osa/runs/<driver-id>/driver-log.jsonl`; `.osa/chat-log/<id>.jsonl` + managed
`.gitignore`. loopr artifacts in the target repo (`.claude/loopr*/baby_prd.md`, `context.md`,
`PHASE_N_SPEC.md`) are ordinary committed files.

## 7. Working-tree note

The repository has ~40 pre-existing *untracked* scratch files (`.step10_*.txt`, `.loopr-*.json`,
`.claude/loopr-*/`, `docs/portfolio-entry.md`, ...) that predate this work. This effort never stages
them; every commit adds explicit paths only.

## 8. Optional plug-ins as of WS10 (added after the test-hardening round; the rows above describe the starting state)

Three features are modular plug-ins, each with ONE switch, all **off by default**:

| Feature | Switch | Flag | State by default |
|---|---|---|---|
| codebase-memory-mcp code index | `index.engine: "lexical" / "cbm"` | `--index-engine` | `lexical` (OSA's own index) |
| trim-1 context trimmer | `trim.enabled` | `--trim` / `--no-trim` | `false` (no-op trimmer) |
| quote stated rules into the criteria | `intake.quoteStatedRules` | `--quote-stated-rules` / `--no-quote-stated-rules` | `false` |

Why off: CBM missed its pass bar (best confident-wrong 10 % against 2 %, 65 % abstentions, ~2x fewer tokens than grep + read at a 10-15 point accuracy cost, ~0 run-level saving on greenfield builds); trim-1 removed 0.3-2.8 % of a run; the quoted criteria were mostly trivial. Evidence: `docs/osa/TEST_REPORT.md` (Suites 1, 7, 9). They are switched off until they are optimised, not removed: flip a switch in `osa.config.json`, or pass the flag for one command, to run the eval again.

What "off" guarantees: the feature's modules are never imported (`src/osa/modular-features.test.ts` walks the static import graph of every entry point), no binary is probed or spawned, no CBM session/daemon/index/shadow is created, no network or file activity from it. `osa features` shows each switch, its state and its source (`flag` > `config` > `default`); every run logs a `feature_state` event per switch; `osa doctor` reports them and never fails or warns about the binary of a disabled one. Token instrumentation (`token_breakdown`) is always on.
