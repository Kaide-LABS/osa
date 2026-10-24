# Persistent memory, step 1: the store

OSA gets one global memory database, `~/.osa/memory.db`, that survives across projects and runs. Step 1 builds only the store and its two read/write surfaces. Auto-capture of run chats, research reuse, ingestion of outside sources, and the dashboard/sync come in later steps and are OUT of scope here.

## Decisions already made by the user (do not revisit)
- ONE global database with a `project` column and a project filter. Not one file per project.
- Capture is on by default, with secret scrubbing, and there is a `forget` command to wipe one project or everything.
- Every row has a stable id, an updated-at time and a deleted marker, so export, import and sync can be added later without changing the data.
- Storage is Node's built-in `node:sqlite` with FTS5 and bm25. No new dependency. No embeddings.

## What step 1 delivers
1. A store module (open or create the database, schema, migrations table) with tables: `sources`, `chunks`, `snapshots` (index history), `sessions` (chat sessions), `facts`. Only `facts` needs a write path now; the others need only the schema.
2. A redacting scrubber. The existing `src/memory/secrets.ts` REJECTS a secret-shaped fact; memory needs a variant that REDACTS secret-shaped spans before anything reaches disk, and reports that it did so.
3. `memory_save` and `memory_search` MCP tools, and `osa memory search | save | forget` CLI commands.
4. `forget` by project or for everything, with a count of what was removed. A forgotten row is physically purged, not only marked.

## Done when
- All new code has tests; the full suite, the typecheck and the boundary scan pass.
- A secrets corpus test proves nothing secret-shaped reaches the database or the FTS index.
- Text read back from memory is returned wrapped as untrusted data (the existing `wrapUntrusted` helper), and instruction-like saves are refused (existing `detectInjection`).
- With the memory feature unused, no memory module is reachable from the entry points' static import graph (the existing invariant test must still pass).
