> Archived development report. Commit hashes and branch names in it refer to a private history that is not part of this repository.

# OSA run report

Branch chain (stacked, each on the previous; nothing merged to `main`, nothing pushed):
`osa/ws0-current-state` → `ws1-rename` → `ws2-intake-lock` → `ws3-research` → `ws4-trim` → `ws5-antigravity` → `ws6-agents` →
`ws7-code-index` → `ws8-memory` (tip). 13 commits on top of `main`, the last three being fixes from live runs.

Final state at the tip: `npm run typecheck` clean; `npm test` 782 tests, **779 pass, 0 fail, 3 skipped** (the skips are
opt-in live tests: `AGY_LIVE_TURN=1`, the trim-1 binary test, a live-provider test); `osa doctor --boundary` 104 files
scanned, 0 violations. No runtime dependency was added (still `zod` + `@modelcontextprotocol/sdk`).

## Per workstream

**Ground rule 0 – current state.** `CURRENT_STATE.md` written before any code change. Directive/code disagreements are in
`CONFLICTS.md` (C-01 … C-26, assumptions A-01 … A-22), each with the reading chosen and why.

**WS1 – Rename.** `osa` binary, `osa.config.json`, MCP server name `osa`, user-facing strings renamed. The data
directory is `.osa/`.

**WS2 – One-shot intake and lock.** `osa "<prompt>"` produces TL;DR + baby PRD with every assumption tagged safe/risky, locks
with one Lock/Edit/Cancel confirmation (`--yes` only when there are zero risky assumptions), hashes the locked PRD and
re-checks the hash at every phase boundary. No further questions after the lock. Provider text-call seam added for all three
providers.

**WS3 – Spec-phase research.** Outline and fields derived from the locked PRD; per-item agents with provider web search;
validator; resume; official documentation sources are mandatory (spec fails with zero); arXiv and OpenAlex via their free
APIs (or a logged "none relevant"); GitHub prior art; cross-provider check of the report; spec authoring with doc sources.
Network access is confined to `src/research/net/` by one scoped exemption to B3/B4 and new rule B9. The arXiv and
paper-search setup servers were removed; no skill or MCP for them was added.

**WS4 – Context trimming and step 14.** `ContextTrimmer` port; trim-1 shell-out with protected-line restoration; no-op
fallback when the binary is absent (the documented fallback). The locked PRD and the spec are never trimmed (guard + test).
Step 14 runs after every phase and emits plain-language summaries. Verification of trim-1 recorded in `TRIM1_NOTES.md`.

**WS5 – Antigravity.** Root cause of the dispatch failure was `agy` 1.3.x emitting a nested `result` event (misreported as
"status undefined"); parsing fixed, repro in `ANTIGRAVITY.md`.

**WS6 – Three new agents.** Lateral-architecture agent (independent provider; planner records the decision), implication
agent (adds S-criteria to the spec), application check (sandboxed git clone, evidence-gated, fails the run with exit 24 on an
unmet criterion). All logged to the event stream.

**WS7 – Code search.** Incremental hashed sub-word TF-IDF index, `code_search` MCP tool, `osa index` / `osa search`, ranked
context injected into build agents. On this repo 9/9 probe queries returned the right file in the top three.

**WS8 – Project memory.** Facts derived from the run record (not free-form model output), secret-rejecting store,
`memory_read` / `memory_append` MCP tools, read at intake, written at run end.

## Live verification

Three end-to-end runs with real Claude Code and Codex CLI and the real arXiv / OpenAlex / GitHub APIs. Each exposed a real
defect, all fixed with regression tests:

| Run | Result | Defect found → fix |
|---|---|---|
| 1 | stopped at build | Codex handoff JSON had a UTF-8 BOM (C-20); secret filter rejected UUIDs (C-21); summary leaked a path and JSON (C-22); GitHub prior art empty for long queries (C-23) |
| 2 | stopped at executor B | Nothing for the second executor to commit, rule R3 rejected the turn (C-24). R3 was not weakened; spec now requires Part A / Part B |
| 3 | **completed in 838 s** | Application check 8/8 met; 23 memory facts written. Afterwards: MCP `evidence` gave a false AC3 failure on the OSA layout (C-25); summary choices read like engineer notes (C-26) |

I independently ran the built CLI from run 3 (correct counts, missing-file error and non-zero exit, 17 tests pass) and the
MCP `evidence` tool (AC1/AC2/AC3 OK after C-25).

## Deferred, and why

- **Antigravity permission-skipping turn, not run live.** The environment's safety classifier refused
  `agy --dangerously-skip-permissions`, and I did not work around it. The text path is verified live against agy 1.3.3; the
  turn path is covered by parser tests and a documented manual smoke (`AGY_LIVE_TURN=1`, see `ANTIGRAVITY.md`).
- **Codex `web_search="live"`** is accepted without error, but I could not prove it actually searched.
- **Antigravity web search and execute** are declared unsupported (`webSearch:false`, `execute:false`); research and the
  application check route to Claude or Codex.
- **Screenshots** of the lock screen and summary were not captured.
- **Merging and pushing** the stacked branches: left to you (publishing is outside what I do unprompted).

## Open risks

1. **Prompt injection from fetched text.** Web, arXiv and GitHub content is fed to models. Mitigations: research agents get
   no write tools, the PRD is hash-locked, the application check is sandboxed. Not eliminated.
2. **Code search is lexical, not neural.** Sub-word TF-IDF with concept expansion; no embeddings were added (no dependency,
   no paid API). Weaker on paraphrase-only queries.
3. **Secret filter is heuristic.** It rejects obvious keys, tokens and high-entropy strings and exempts UUIDs; a novel secret
   format could slip into memory. Memory is derived from the run record, which narrows the surface.
4. **Codex default model is stale on this machine.** `gpt-5.5` is rejected for this account; `providers.modelOverrides`
   (e.g. `{"codex-cli":"gpt-6-luna"}`) works around it and must be set in `osa.config.json`.
5. **B3/B4 now has one exemption** (`src/research/net/`, rule B9). It is scanned (only global `fetch`, URL literals only in
   `urls.ts`), but it is a deliberate widening of the "zero network" guarantee.
6. **Public API limits.** OpenAlex has a small shared daily budget without a key (`OPENALEX_API_KEY` optional); unauthenticated
   GitHub allows 60 core requests/hour and 10 searches/minute, and code search needs auth. Research degrades to a logged
   "none found" rather than failing, except documentation sources, which are mandatory.
7. **Trim-1 not installed here.** The real binary was exercised by an opt-in test, but runs default to the no-op trimmer
   unless `trim.binaryPath` is set.
8. **Small projects.** The two-agent build model needs a spec that splits work into Part A and Part B; for trivial projects
   Part B can be thin (tests, errors, docs). Rule R3 still forbids empty commits.
9. **The MCP server runs the compiled `dist/`, which is git-ignored.** The final MCP `doctor` call reported 10 B4 violations in
   `src/research/net/` because the already-running server was built before the B9 exemption existed (the source scan reports
   0). `npm run build` was re-run and the rebuilt `dist` reports 0, but a server process started earlier keeps the old code
   until it is restarted. After pulling these branches, run `npm run build` and restart the MCP server.
