# PHASE 1 SPEC: global memory store, save/search/forget

## Files
- `src/memory/global/db.ts`: `openMemoryDb(path?)`, schema, migration runner, FTS5 check, close.
- `src/memory/global/redact.ts`: `redactSecrets(text)` returning `{ text, redactions: string[] }`.
- `src/memory/global/memory.ts`: `saveFact`, `searchMemory`, `forgetMemory`, `listProjects`.
- `src/mcp/tools/memory-global.ts`: tools `memory_save`, `memory_search`.
- `src/cli/memory-cmd.ts` plus wiring in `src/cli/main.ts`: `osa memory search <query> [--project p] [--limit n]`, `osa memory save <text> [--project p] [--kind fact|decision|note]`, `osa memory forget --project p | --all [--yes]`.
- Tests next to each file, plus a corpus test for the redactor and an integration test for the CLI and MCP tools.
- A short `docs/osa/MEMORY.md` describing the store, what is and is not captured, and how to forget.

## Behaviour
1. `saveFact({ text, project, kind, source })`: reject empty text or text over 2,000 characters; reject instruction-like text via `detectInjection`; redact secret-shaped spans; if more than half the text was redacted, refuse instead of storing a husk; de-duplicate by normalised text within a project (update `updated_at`, do not insert a second row); return `{ id, redactions }`.
2. `searchMemory({ query, project?, limit })`: FTS5 bm25 over non-deleted rows; query terms are escaped so user text cannot inject FTS syntax; results carry id, project, kind, source, created_at, a short snippet and the rank. The MCP tool wraps returned text with `wrapUntrusted`; the CLI prints it plainly.
3. `forgetMemory({ project } | { all: true })`: deletes the rows and their FTS entries, runs `VACUUM`, and returns counts. The CLI requires `--yes` for `--all`.
4. The soft-delete column exists for later sync, but `forget` purges.
5. Ordering is deterministic: equal rank breaks by `created_at`, then `id`.

## Failure modes to test
- FM-A: FTS syntax in the query (`"`, `*`, `NEAR(`, `OR`, a lone quote).
- FM-B: a secret inside a longer sentence.
- FM-C: a secret split over two lines, for example `password:` and then the value on the next line.
- FM-D: a prompt-injection fact ("ignore previous instructions ...").
- FM-E: concurrent saves from two processes (WAL mode, busy timeout).
- FM-F: a corrupt or missing database file.
- FM-G: `forget --project x` must not touch project `xy`.
- FM-H: the real home directory is never written by tests.
- FM-I: the import-graph invariant with the memory feature unused.

## Acceptance
`npm run typecheck`, the full test suite and the boundary scan are green. Report in the final message: files changed, tests added, any CONFLICTS entries, and anything not done.
