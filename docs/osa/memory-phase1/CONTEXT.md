# Context for the implementer

Repo: OSA (TypeScript, Node 22+, `node:test`). Worktree: `C:\Users\hp\OSA-memory`, branch `feat/persistent-memory`. Read first: the README conventions and `docs/osa/CONFLICTS.md`.

Existing, relevant code (read before writing):
- `src/memory/store.ts` and `derive.ts`: the PROJECT-scoped markdown fact store (`.osa/memory/*.md`). Leave it working and unchanged. The new global store is separate and lives in `src/memory/global/`.
- `src/memory/secrets.ts`: `findSecret(text)` rejects. Reuse its rule list for detection; add a redacting function that replaces each matched span with `[redacted:<reason>]`. Export it from a new file and do not change `findSecret`'s behaviour. `secrets-corpus.test.ts` shows the corpus style; build a parallel corpus test for the redactor, and keep fake tokens split in literals (`"xoxb-" + "..."`) because GitHub push protection blocks whole fake tokens.
- `src/osa/untrusted.ts`: `wrapUntrusted`, `detectInjection`.
- `src/dispatch/chat-log.ts` and `src/domain/chat-log.ts`: the raw run chat log is deliberately WRITE-ONLY. No code in `src/` may read it (PHASE_10 spec 6.6, FM16). Do not add a reader. Memory has its own sink that stores scrubbed copies at write time.
- MCP tools live in `src/mcp/tools/`; `memory_append` and `memory_read` are the existing project-memory tools, so name the new ones `memory_save` and `memory_search`. CLI commands are wired in `src/cli/main.ts`; import command code LAZILY inside the run function (an invariant test fails on static imports of feature modules).

Hard boundaries (a scan enforces them): network only in `src/research/net/`; model names only in `src/adapters/`; `child_process` only in `src/util/exec.ts`. Step 1 needs none of these.

Database rules:
- Path `~/.osa/memory.db`, overridable by env `OSA_MEMORY_DB` (tests MUST use a temp path and never touch the real home directory).
- Use `node:sqlite` `DatabaseSync`. Verify FTS5 is available at open and fail with a clear message if it is not.
- Every table has: `id TEXT PRIMARY KEY` (uuid), `updated_at` (ISO), `deleted_at` (nullable). `facts` and `chunks` also have `project`, `source`, `created_at`. Add a `schema_version` table and a migration runner, even though there is one migration.
- FTS5 virtual table over fact/chunk text with triggers keeping it in sync, including on purge.
- Restrict file permissions where the platform allows it; on Windows rely on the user profile folder and say so in the docs.
- Never log or print stored text in errors.

Judgement calls: record them in `docs/osa/CONFLICTS.md` as M-01, M-02, ... and keep going. Never weaken, skip or delete a test to make it pass. Commit only your own files by explicit path.
