# Context for the implementer

Repo: OSA (TypeScript, Node 22+, `node:test`). Worktree `C:\Users\hp\OSA-memory`, branch `feat/memory-capture`, which is based on `feat/persistent-memory` (the step 1 store; PR 1 in the Kaide-LABS/osa repo). Read `docs/osa/MEMORY.md` and the M-01 to M-12 entries in `docs/osa/CONFLICTS.md` first: they say what the store guarantees and what its secret filter does not catch.

Existing code to read before writing:
- `src/memory/derive.ts`: `deriveFacts(record)` builds facts from the run RECORD, deterministically, with no model call; `clip()` already removes run ids and absolute paths; `writeRunMemory` writes the project's `.osa/memory` files and emits `memory_written`. Leave the project-memory behaviour exactly as it is.
- `src/osa/pipeline.ts`, the `recordMemory` closure (around line 476): it builds the `RunRecord` and calls `writeRunMemory`, guarded by `config.memory.enabled` and wrapped in try/catch. The global capture hooks in here, after the project write, so it sees the same record.
- `src/memory/global/memory.ts` (`saveFact`, `MAX_FACT_CHARS`, `MAX_PROJECT_CHARS`, `MAX_SOURCE_CHARS`), `src/memory/global/db.ts` (`resolveMemoryDbPath`, `openMemoryDb`). `saveFact` redacts secrets, refuses instruction-like, hidden and husk text, rejects secret-shaped labels, and de-duplicates per project.
- `src/domain/osa-config.ts`: the `MemoryConfig` schema (around line 157) and `memory: MemoryConfig.prefault({})`. Add `global: { capture: boolean }` there with the default `true`; keep the config strict-parse behaviour and add a test.
- `src/osa/events.ts`: the event sink and the event name list (add the two new events and update whatever pins the list).
- `src/domain/intake.ts` (`BabyPrd`): which fields hold the goal, scope and assumptions.

Rules:
- The global store loads by dynamic `import()` only (inside the capture function), never a static import, so the feature-off import-graph invariant test stays green. Check `src/osa/modular-features.test.ts` and `src/memory/global/import-graph.test.ts`.
- Boundaries (a scan enforces them): network only in `src/research/net/`, model names only in `src/adapters/`, `child_process` only in `src/util/exec.ts`. Step 2 needs none.
- The raw chat log (`src/dispatch/chat-log.ts`, `src/domain/chat-log.ts`) is write-only; add no reader.
- Project name: derive it from the repository folder name (basename of `repoDir`), cleaned the way `saveFact` cleans labels; if that is empty or rejected, use `default`. Source label: `osa run <first 8 characters of the run id>`.
- Limits: at most 40 facts per run (summary note first, then decisions, failures, preferences, conventions), each at most 300 characters (reuse the existing clip).
- NEVER put fact text, the goal, or any user text in an event or an error message. Counts and reason classes only.
- Tests must use a temp database. Add a guard in `resolveMemoryDbPath` (or `openMemoryDb`): when the process is running under the Node test runner (the `NODE_TEST_CONTEXT` environment variable is set) and the resolved path is inside the real home directory, throw a clear error unless `OSA_MEMORY_DB` or an explicit path was given. Then check that no existing pipeline test writes to the real `~/.osa`: with capture on by default, any test that runs the pipeline needs `OSA_MEMORY_DB` set to a temp path or capture turned off in its config. Fix the tests, never weaken an assertion.
- Judgement calls: record them in `docs/osa/CONFLICTS.md` as M-13, M-14, ... and keep going. Never weaken, skip or delete a test to make it pass. Commit only your own files by explicit path. No attribution trailers in commit messages.
