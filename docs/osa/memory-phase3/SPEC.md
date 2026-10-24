# PHASE 1 SPEC: remember and reuse documentation research

## Files
- `src/memory/global/db.ts`: schema version 3, a `research_items` table (migration `migrateResearchItems`), plus a `purgeResearch` used by forget.
- `src/memory/global/research.ts`: `rememberItems(records, opts)` and `findReusable(keys, opts)`; pure helpers `docsKey(target)`, `isFresh(createdAt, maxAgeDays, now)`.
- `src/memory/global/memory.ts`: `forgetMemory` also removes `research_items` rows (a project's, or all).
- `src/research/agent.ts`: `ResearchRunContext` gains an optional `reuse` seam; `runItem` consults it for `kind: "docs"` items before starting an agent. `ItemOutcome.status` gains `"reused"` with an optional `reusedFrom: { project, ageDays }`.
- `src/research/stage.ts`: before the items run, load reusable results with ONE database open (dynamic import, only when reuse is enabled); after the cross-check, remember eligible items (dynamic import, only when reuse is enabled).
- `src/research/report.ts`: a reused item is marked with its provenance line. Counts in the stage's `research_validated` event gain `reused`.
- `src/domain/osa-config.ts`: `memory.global.reuse { enabled: true, maxAgeDays: 30 }` (maxAgeDays 1 to 365).
- `src/osa/events.ts`: events `research_reused` and `research_remembered` (counts only).
- `docs/osa/MEMORY.md`: a section on what is remembered, when it is reused, the freshness window, and how to turn it off or forget it.
- Tests next to each file and a stage-level test with a fake text call that counts agent calls.

## Behaviour
1. **Key.** `docsKey(target)` = the documentation target lowercased, NFKC-folded, whitespace collapsed, trailing punctuation trimmed. Only items with `kind: "docs"` have a key; the target is the text after `Official documentation: ` in the item's title (the outline builder's own wording; add a small exported helper next to `buildOutline` so there is one source of that format).
2. **Remember** (`rememberItems`): for each outcome with status `done` (not `resumed`, `reused` or `failed`) and `kind: "docs"`, only when `crosscheck !== null && crosscheck.flagged.length === 0`. Store the validated result JSON as it was written to disk (already screened), the key, the title, `check_level` (`"full"` or `"consistency-only"` from `crosscheck.degraded`), the origin project and `created_at`. One row per key: a newer result replaces the older one (`updated_at` and `created_at` refreshed). Refuse (count, do not store) a result whose JSON text is over 64 KB or on which `findSecret` fires. Keep at most 500 rows; beyond that delete the oldest.
3. **Reuse** (`findReusable`): given the keys of the outline's docs items, one query. A row qualifies only if it is not deleted, `created_at` is within `maxAgeDays`, and its JSON parses. Then in `runItem`: the candidate must pass `validateItemResult` for THIS item's fields (a docs item requires official-docs sources), then `screenDeep` exactly as a fresh result does, then it is written to `results/<slug>.json` like a fresh one and the outcome is `{ status: "reused", result, reusedFrom }`. Any failure at any step is a miss: the agent runs.
4. **Report.** `compileReport` marks a reused item: `_Reused from an earlier run (project <name>, <N> days old); not researched again in this run._` placed right under the item heading. Project names go through the existing label cleaning; no stored text other than the validated result reaches the report.
5. **Counting.** `done + resumed + reused === 0` still stops the stage. `research_validated` carries `reused`. `research_reused` carries `{ items, oldestAgeDays, resultCharsEstimate }` (the characters of the reused results, a LOWER bound on output avoided, not a token claim). No item text, target or project name in any event.
6. **Switches and failure.** With `memory.global.reuse.enabled` false the stage imports nothing from the store and opens no database. Every database error in lookup or remember is swallowed after one `research_reuse_failed` event carrying only a reason class (reuse the typed `MemoryDbReason`); lookup uses the 1.5 second busy timeout from capture.
7. **Forget.** `forgetMemory({ project })` deletes `research_items` rows whose origin project matches; `{ all: true }` deletes all. The same FTS-style physical purge applies (the table is not FTS-indexed, so `secure_delete` and `VACUUM` suffice; add a test that the forgotten target text is gone from the file and the `-wal`).
8. **Untrusted data.** A stored result is third-party text derived from web pages. It gets the same treatment as a fresh result at every point it is used; storing it does not make it trusted.

## Failure modes to test
- FM-A: a stale entry (older than the window) is not served; an entry exactly at the boundary is.
- FM-B: a stored entry that no longer validates for the item (a missing required field, no official-docs source) is a miss and the agent runs.
- FM-C: a stored result containing a secret or an injection string planted AFTER it was stored (edit the row directly): not served, or neutralised exactly as a fresh result would be.
- FM-D: a run whose cross-check flagged one claim, or was disabled, or failed: nothing is remembered.
- FM-E: a locked database and a corrupt database during lookup and during remember: a miss and a reason-class event, the run unaffected.
- FM-F: reuse off: no store import, no database file created, identical behaviour to today.
- FM-G: two docs items with the same key in one outline: both are served or neither, and never confused with a different technology whose name is a prefix of the key ("react" vs "react-native").
- FM-H: `forget --project` removes only that project's remembered research; `--all` removes all; the forgotten text is not in the file or its `-wal`.
- FM-I: the 500-row cap evicts the oldest.
- FM-J: a free-form (`kind: "research"`) item is never remembered or reused.
- FM-K: the import-graph invariants still pass.

## Acceptance
`npm run typecheck`, the full test suite and the boundary scan are green. Report in the final message: files changed, tests added, CONFLICTS entries (M-25 onwards), anything not done.
