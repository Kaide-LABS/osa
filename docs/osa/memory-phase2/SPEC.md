# PHASE 1 SPEC: capture each run into the global memory store

## Files
- `src/memory/global/capture.ts`: `projectNameFor(repoDir)`, `summaryNote(record)` (pure), `captureRun(record, repoDir, opts)` returning `{ saved, deduped, refused, redacted, reasons }`; loads the store with `await import("./memory.ts")`.
- `src/osa/pipeline.ts`: inside `recordMemory`, after `writeRunMemory`, call the capture when `config.memory.global.capture` is true. The hook itself is fail-soft.
- `src/domain/osa-config.ts`: `memory.global.capture`, default `true`.
- `src/osa/events.ts`: events `global_memory_written` and `global_memory_failed`.
- `src/memory/global/db.ts`: the test-runner guard on the real home directory.
- `docs/osa/MEMORY.md`: a section on what a run captures, how to turn it off, and how to forget it.
- Tests next to each file, plus a pipeline-level test.

## Behaviour
1. `captureRun` builds the list: first the run-summary note (kind `note`), then the facts from `deriveFacts(record)` mapped to kinds: decisions to `decision`, failures to `fact`, preferences to `fact`, conventions to `fact`. It stops at 40.
2. Each item goes through `saveFact` with the derived project name and source `osa run <id8>`. A refusal (UsageError) is counted and its reason class recorded; any other error aborts the whole capture and is reported as `global_memory_failed`.
3. A rerun with identical facts does not insert again (the store de-duplicates); the result counts them as `deduped`.
4. `global_memory_written` carries counts (saved, deduped, refused, redacted spans) and the reason classes of refusals. It never carries fact text. `global_memory_failed` carries only a reason class (`locked`, `corrupt`, `fts-unavailable`, `other`).
5. With `memory.global.capture` false, `captureRun` is not called, the store module is never imported, and no database file is created.
6. A run that stopped early is captured too (the failures are the most useful facts).
7. Capture must not change the run's outcome, exit code or timing in any way except the two events.

## Failure modes to test
- FM-A: the database path is unwritable, locked, or a corrupt file: the run still finishes; one `global_memory_failed`.
- FM-B: a secret in the goal, in an assumption, or in a constraint: never in the database (redacted or refused).
- FM-C: the goal is hidden text or an instruction: refused and counted, run unaffected.
- FM-D: two runs of the same project: identical facts de-duplicate, new ones add.
- FM-E: capture off: no file, no import (assert the database file does not exist).
- FM-F: a repository folder name that is empty, very long, or secret-shaped: falls back to `default`.
- FM-G: more than 40 derived facts: exactly 40 saved, summary first.
- FM-H: the guard: under the test runner, an unset `OSA_MEMORY_DB` with no explicit path throws instead of touching the real home directory.
- FM-I: the import-graph invariants still pass.

## Acceptance
`npm run typecheck`, the full test suite and the boundary scan are green. Report in the final message: files changed, tests added, CONFLICTS entries, anything not done.
