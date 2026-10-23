# OSA -- One-Shot Anything

Give OSA **one prompt**. It turns it into a plain-language plan, asks you to confirm **once**, and then runs to
completion on its own: it researches, writes a spec, builds across two different AI coding tools (so one
always reviews the other), tests the result like a user would, and hands you a summary you can read without being
an engineer. It runs entirely on your machine with the AI tools you already have signed in (Claude Code, Codex
CLI, Antigravity CLI), and uses no paid API of its own.

```
osa "Build a command line tool that counts the words in text files and prints a total"
```

## What happens, in order

| # | Stage | What you see / get |
|---|---|---|
| 1 | **Intake** | A TL;DR (3-5 plain lines) and a *baby PRD*: problem, who it's for, in/out of scope, falsifiable acceptance criteria, constraints, research plan, and every **assumption** OSA had to make, tagged `[risky]` (would change scope, architecture, data, cost or security if wrong -- listed first) or `[safe]`. No questions are asked. |
| 2 | **The lock** | The only human touchpoint: **Lock and run / Edit / Cancel.** *Edit* opens the PRD in your editor and re-shows it. On lock, the PRD is hashed (`prd_locked`) and committed. It is immutable from here: any later change is a hard failure (exit 20). |
| 3 | **Research** | Runs unattended against the **locked** PRD: official documentation for every library/framework/API named (mandatory), arXiv + OpenAlex papers, public prior-art repos on GitHub -- then a **second AI on a different provider** checks the report against its sources. |
| 4 | **Spec** | `context.md` + `PHASE_1_SPEC.md`, with documentation sources (a spec with none fails the phase). Gaps become logged *spec decisions*, never questions. |
| 5 | **Agents** | A *lateral architecture* agent (independent provider) proposes a materially different design and the planner records which it chose and why; an *implication* agent turns second-order consequences into extra acceptance criteria / out-of-scope lines **in the spec** (never the PRD). |
| 6 | **Build** | The cross-provider dispatcher: per phase, executor / executor / reviewer turns across two providers, verified through git, file hashes and continuity checks. Around every phase: the PRD hash is re-verified, and **step 14** writes a trimmed handoff for the next phase plus a plain-language note for you. |
| 7 | **Application check** | An agent *runs the finished project* in a disposable copy and tries each acceptance criterion. Unmet criteria **fail the run** (exit 24); a "met" without evidence doesn't count. |
| 8 | **Summary + memory** | `runs/<id>/summary.md` (what was built, what was decided for you, what's uncertain, how it was checked) and facts saved to `.osa/memory/` for next time. |

Everything it produces for a run lives in `runs/<run-id>/` in your repo (committed): `baby-prd.md`, `research/`
(`outline.yaml`, `fields.yaml`, `results/*.json`, `report.md`), `spec/`, `step14/`, `application/`, `summary.md`.

### Flags

```
osa "<what you want built>" [--file <path>]... [--repo-dir <path>] [--yes] [--spec-only] [--json]
```

- `--file` attaches a file to the prompt (links in the prompt or files are noted; anything OSA can't open becomes an assumption).
- `--yes` is **unattended mode**: it locks automatically **only if there are zero `risky` assumptions**; otherwise it
  stops at the lock and exits **19** with a clear message. Without `--yes` a terminal is required.
- `--spec-only` stops after research and the spec.
- The target directory must be a git repository with at least one commit (OSA verifies every phase through git).

## Configuration -- `osa.config.json`

Every key is optional; these are the defaults. A typo'd key is an error, not silently ignored.

```jsonc
{
  "intake":   { "autoLockWhenNoRisky": true, "quoteStatedRules": false },
  "research": { "enabled": true, "docsRequired": true, "academic": true, "openalexMailto": "",
                "semanticScholar": false, "githubLookup": true, "crossProviderCheck": true,
                "maxItems": 8, "batchSize": 4 },
  "trim":     { "enabled": false, "engine": "trim1", "binaryPath": "", "point": "balanced", "budgetTokens": 6000 },
  "agents":   { "implication": true, "lateralArchitecture": true, "lateralArchitectureProvider": "codex",
                "lateralArchitecturePinned": false, "application": true },
  "index":    { "enabled": true, "embedder": "local", "topK": 8, "engine": "lexical",
                "cbm": { "binaryPath": "", "workDir": "", "indexMode": "full" } },
  "memory":   { "enabled": true, "maxFactsPerFile": 200, "readBudgetChars": 3000 },
  "providers": { "pair": ["claude-code", "codex-cli"], "turnTimeoutMs": 1800000, "textTimeoutMs": 900000 }
  // optional: "providers.rolePins", "providers.modelOverrides", "agents.implicationProvider", "agents.applicationProvider"
}
```

Provider names accept `claude`/`codex`/`antigravity` as short aliases. **`providers.modelOverrides`** matters if a
provider CLI's own default model has gone stale (e.g. `{"codex-cli": "gpt-6-luna"}`): it applies to every OSA call and build turn.

Optional environment variables (see `.env.example`; none is required, each feature degrades gracefully):
`GITHUB_TOKEN` (raises GitHub limits, enables code search), `OPENALEX_API_KEY` (OpenAlex now gives unauthenticated
callers only a small shared daily budget; `mailto` no longer raises it), `S2_API_KEY` (only with `research.semanticScholar`).

## Research, without a paid API

Research runs on **each provider's own built-in web search** (Claude Code `WebSearch`/`WebFetch`, Codex web search); if
a provider has none (Antigravity, unverified) research is routed to one that does and logged. Academic search uses
the public **arXiv API** (>= 3 s between calls, one connection) and **OpenAlex**, de-duplicated by DOI, then arXiv id,
then title; "nothing relevant" is a valid, logged result. Prior art uses the **GitHub REST API** (READMEs and key
files; rate-limit headers honoured). One research agent runs per outline item, results are validated against
`fields.yaml` (every field covered, `[uncertain]` values listed), and a re-run skips items that already validate. The
pattern is adapted from [Deep-Research-skills](https://github.com/Weizhena/Deep-Research-skills) (MIT) with every human
stop removed -- see `docs/osa/ATTRIBUTION.md`.

The one place OSA touches the network itself is `src/research/net/` -- the only directory exempt from the old "zero
network calls" boundary rule, and held to a stricter one (global `fetch` only, no HTTP library, no dependency).

## Optional plug-ins: CBM code index, trim-1, quoted stated rules (all OFF by default)

Three features are plug-ins with **one switch each**. When a switch is off, **none of that feature's code runs**: its
modules are not imported (a test proves no entry point can reach them), no binary is probed or spawned, no index or
session is built, and nothing is written. Turning them off breaks and nags nothing: code search and the build-context
injection use OSA's own lexical index, handoffs use the no-op trimmer, step 14 still writes the plain-language
summary, and `osa doctor` neither fails nor warns about a missing binary. **Token instrumentation is not a feature and
is always on** (`token_breakdown` per phase and per run).

| Feature | Switch (`osa.config.json`) | Flag for one command | Why it is off |
|---|---|---|---|
| codebase-memory-mcp code index | `index.engine: "lexical" / "cbm"` (default `lexical`) | `--index-engine lexical / cbm` | missed its pass bar: best confident-wrong 10 % vs the 2 % target, ~2x fewer tokens than grep at a 10-15 point accuracy cost, ~0 saving on greenfield builds (`docs/osa/TEST_REPORT.md` Suite 7) |
| trim-1 context trimmer | `trim.enabled: true / false` (default `false`) | `--trim` / `--no-trim` | saved 0.3-2.8 % of a run (Suite 1, 9) |
| quote the person's stated rules into the acceptance criteria | `intake.quoteStatedRules: true / false` (default `false`) | `--quote-stated-rules` / `--no-quote-stated-rules` | most quoted criteria were trivial noise (Suite 9) |

`osa features` lists each switch with its state and **where it was set** (`flag`, `config` or `default`); precedence is
**flag > config > default**. The flags are accepted by `osa "<prompt>"`, `osa search`, `osa doctor` and `osa features`, so you can
opt in, run the eval, and turn it off again without touching code or config (`osa "<prompt>" --trim --index-engine cbm`).
Each run logs one `feature_state` event per switch (`feature`, `state`, `value`, `source`). To use CBM at all, install it as
`docs/osa/CBM_NOTES.md` describes and set `index.cbm.binaryPath` and `index.cbm.workDir`.

## Context trimming (trim-1, off by default)

Handoff text between stages (research -> spec, phase N -> phase N+1) can be shortened by
[trim-1](https://github.com/caveman-ai/trim-1) (Apache-2.0, ~1 MB, local, no network) when `trim.enabled` is true and
you have installed it (`go install github.com/caveman-ai/trim-1/cmd/trim@latest`, or set `trim.binaryPath`). Without it
(or with trim off) OSA uses a no-op trimmer and logs `trim_skipped` -- nothing is faked. The **locked PRD, the spec, acceptance criteria and `context.md`
are never trimmed**, and paths, hashes, errors, URLs and test names always survive. Details: `docs/osa/TRIM1_NOTES.md`.

## Code index and project memory

- `osa index` / `osa search "<query>"` and the `code_search` MCP tool: a local, incremental, offline index of your
  repo (`.osa/index`, git-ignored). It is lexical-semantic (identifier-aware, with related-concept expansion), **not** a neural
  embedding. Build agents get the ranked "where to look first" list in their context before each phase. This is the
  default engine; the codebase-memory-mcp engine is the optional plug-in above.
- `osa memory` and the `memory_read` / `memory_append` MCP tools: `.osa/memory/{decisions,conventions,failures,preferences}.md`,
  one fact per line, written at the end of each run from its record and read at the next intake. **Secrets are rejected**
  and reported, never stored.

## Logs, exit codes

Every stage logs a stable event to `.osa/runs/<run-id>/events.jsonl` (`assumptions_generated`, `prd_locked`,
`research_item_done`, `research_validated`, `research_crosscheck`, `academic_query`, `github_lookup`, `trim_applied`,
`trim_skipped`, `implication_done`, `lateral_arch_done`, `application_check`, `index_updated`, `memory_written`, ...).
New exit codes: `19` stopped at the lock (risky assumptions, unattended), `20` locked PRD changed, `21` intake failed,
`22` cancelled at the lock, `23` a stage's own contract failed (e.g. zero documentation sources), `24` the application check failed.

## The lower-level commands (unchanged)

`osa run --config <path>` dispatches one phase's turn sequence; `osa drive --config <path>` dispatches phases
sequentially; `osa evidence --repo-dir <path> --run-id <uuid>` re-derives AC1/AC2/AC3 from persisted records;
`osa doctor` health-checks toolchain, providers and the boundary scan; `osa mcp` starts the stdio MCP server
(`run`, `drive`, `doctor`, `evidence`, `code_search`, `memory_read`, `memory_append`); `osa setup` registers it in
Claude Code at user scope.

Guarantees that were never weakened: executor and reviewer on **different** providers (a pinned self-review is
loud, never silent); git verification of every commit (neutral messages, no AI attribution trailers); SHA-256
attestation of every artifact read and written; verbatim JSONL chat logs; resume.

Antigravity CLI requires operator-configured authentication via either headless mode (`modelProvider: "gemini"` and
a non-empty `GEMINI_API_KEY`) or a signed-in Google account (subscription) session; OSA only observes that state.
See `docs/osa/ANTIGRAVITY.md` for the status of Antigravity dispatch.

### Persistent chat log

Every `osa run` / `osa drive` invocation appends a verbatim log of each prompt and response to
`.osa/chat-log/<id>.jsonl` in the target repo (failed, halted and timed-out turns included), gitignored by
default via a managed `.gitignore`. Set `"chat_log_gitignored": false` in a `run`/`drive` config to make it trackable --
but it is a verbatim record of everything the providers emitted and a known credential-leakage channel; OSA flags
credential-shaped content (`sk-`, `ghp_`, `xoxb-`) as a warning only. Read a log before you make it trackable.

## Documentation

`docs/osa/` -- `CURRENT_STATE.md` (the code as found), `CONFLICTS.md` (every place the directive and the code
disagreed, and every judgement call), `ATTRIBUTION.md`, `TRIM1_NOTES.md`, `ANTIGRAVITY.md`, `archive/RUN_REPORT.md` (what
was done per workstream, what was deferred and why, open risks).

## Requirements and scripts

- Node.js `>=24.0.0`; git; at least two of Claude Code / Codex CLI / Antigravity CLI installed and signed in.
- `npm run typecheck`, `npm test`, `npm run check` (typecheck + test + boundary scan).
