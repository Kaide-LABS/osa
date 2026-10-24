# Context for the implementer

Repo: OSA (TypeScript, Node 22+, `node:test`). Worktree `C:\Users\hp\OSA-memory`, branch `feat/research-reuse`, based on `feat/memory-capture` (PR 2 in Kaide-LABS/osa), which is based on `feat/persistent-memory` (PR 1). Read `docs/osa/MEMORY.md` and the entries M-01 to M-24 in `docs/osa/CONFLICTS.md` first: they say what the store guarantees, what its secret filter does not catch, and the judgement calls so far.

Existing code to read before writing:
- `src/research/stage.ts`: `runResearchStage`. The outline is built, then `runAllItems` runs one agent per item, then docs are collected, the report is compiled, and the cross-check runs. `crosscheck.flagged` lists the claims the reviewer could not support; `crosscheck.degraded` means it was a consistency-only check.
- `src/research/agent.ts`: `runItem` already SKIPS an item whose valid result file exists (`resumed`). The reuse seam goes right there. `ItemOutcome.status` is `"done" | "resumed" | "failed"` today; `stage.ts` counts `done + resumed` and `report.ts` filters `failed`. Find every consumer before adding `"reused"` (grep the whole of `src/`).
- `src/research/outline.ts`: `buildOutline` writes a docs item's title as `Official documentation: ${target}` and its question as a fixed sentence; that wording is what the key is derived from, so keep ONE helper for it.
- `src/research/validate.ts` (`validateItemResult`) and `src/osa/untrusted.ts` (`screenDeep`, `wrapUntrusted`, `detectInjection`): every reused result must pass both, as a fresh one does.
- `src/memory/global/db.ts` (schema, migrations, `MemoryDbError` with its typed `reason`, `openMemoryDb(path, env, { busyTimeoutMs })`), `src/memory/global/memory.ts` (`saveFacts`, `forgetMemory`, the one-connection pattern), `src/memory/global/capture.ts` (how a feature loads the store lazily and reports a failure class). Follow these patterns; do not invent new ones.
- `src/domain/osa-config.ts`: `memory.global` (add `reuse` beside `capture`, keep strict parsing, add a config test).
- `src/osa/events.ts`: the event list.

Rules:
- The store loads by dynamic `import()` only, inside the functions that need it, never at module load, so the feature-off static import graph stays clean (see `src/osa/modular-features.test.ts` and `src/memory/global/import-graph.test.ts`). `src/research/stage.ts` is reachable from the entry points: it may import only types and the config from the memory side statically.
- Boundaries (a scan enforces them): network only in `src/research/net/`, model names only in `src/adapters/`, `child_process` only in `src/util/exec.ts`. This step needs none.
- The raw chat log (`src/dispatch/chat-log.ts`, `src/domain/chat-log.ts`) is write-only; add no reader.
- No event, error message or log line may contain a documentation target, a project name, or any stored text. Counts and reason classes only.
- Tests must use a temp database (explicit path or `OSA_MEMORY_DB`); the guard in `resolveMemoryDbPath` refuses the real home under the test runner. With reuse on by default, every existing test that runs the research stage reaches the store: point them at a temp database or turn reuse off in their config, never weaken an assertion.
- Schema: a new migration number (3) in `db.ts`; bump `SCHEMA_VERSION`; the migration runner is transactional; existing databases (version 2) must upgrade in place. Test the upgrade from a version 2 database.
- Judgement calls: record them in `docs/osa/CONFLICTS.md` as M-25, M-26, ... and keep going. Never weaken, skip or delete a test to make it pass. Commit only your own files by explicit path. No attribution trailers in commit messages.
