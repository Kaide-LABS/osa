# OSA global memory

OSA keeps **one** global memory database that survives across projects and runs. This is step 1 of persistent memory:
the store and its read/write surfaces only. Auto-capture of run chats, research reuse, ingestion of outside sources,
and any dashboard/sync are later steps and are **not** built yet.

## Where it lives

- Default path: `~/.osa/memory.db` (under your user profile).
- Override with the environment variable `OSA_MEMORY_DB` (an absolute path to the database file). Tests always set this
  to a temp path, so the real home directory is never written during a test run.
- Storage is Node's built-in `node:sqlite` with FTS5 + bm25 ranking. No new dependency, no embeddings.
- On macOS/Linux the file is restricted to the owner (`chmod 600`). On Windows OSA relies on the per-user profile
  folder for access control; the file permission bits are not set.

## What it stores

A `facts` table of short, durable notes. Each fact has a stable id, a `project`, a `kind` (`fact`, `decision`, or
`note`), an optional `source`, the text, and `created_at` / `updated_at` / `deleted_at` timestamps. The database also
carries the schema for `sources`, `chunks`, `snapshots` (index history) and `sessions` (chat sessions) so later steps
can add to them without changing the data model; only `facts` has a write path today.

## What is NOT captured

- No secrets. Every fact is scanned before it touches disk and secret-shaped spans (API keys, tokens, private-key
  blocks, `password=`/`token:` assignments, connection strings with embedded credentials, long high-entropy tokens) are
  **redacted** in place and the redaction is reported. If more than half of the text was secret-shaped, or if anything
  secret-shaped still remains after redaction, the fact is **refused**, not stored as a husk. A bare UUID (a run id) is
  not treated as a secret; a UUID next to a credential word is.
- No instructions. Text that reads like an instruction aimed at an AI (e.g. "ignore previous instructions ...") is
  rejected, because memory is a place for facts, not a channel for steering a later run.
- No raw run chat log. The raw chat log is write-only and is never read back into memory.

Hidden text is refused, not cleaned and saved: Unicode tag characters (which spell invisible ASCII), HTML comments and
hidden elements make a save fail. Zero-width characters, terminal escape sequences and control characters are removed,
and the text is folded with Unicode NFKC (fullwidth letters and punctuation become plain ASCII).

The `project` and `source` labels get the same checks. A label that looks like a secret or an instruction is **rejected**
(not redacted, because redacting would change which project the fact belongs to), a project name is at most 100
characters and a source at most 200.

Text read back out of memory is returned wrapped as untrusted data by the MCP tool (`memory_search`), both in the text
content and in each result's `snippet` in the structured content; it is data to read, never instructions to follow.
The CLI prints it plainly.

### Known limits of the secret filter

The filter is built to lean toward refusing, but it is pattern-based and is not a guarantee. Known gaps, found by review
and left in on purpose because closing them would refuse ordinary notes:

- A password written as plain words with no digit ("the password is correcthorsebatterystaple") is not detected, and
  neither is a 32-plus-character token made only of letters. Do not paste secrets into a fact.
- A short bearer value (`Bearer abc.def`) is not detected.
- It also over-redacts in the safe direction: `token: ...`, `key: ...` and `pwd: ...` followed by a word are treated as
  credentials, and a long identifier can be mistaken for a key. A 40- or 64-character hex string is kept only when the
  word just before it is `commit`, `sha`, `sha256`, `digest`, `hash`, `rev` or `revision`; anywhere else it is treated as
  a key.

## Using it

CLI:

```
osa memory save "<text>" [--project <p>] [--kind fact|decision|note] [--json]
osa memory search "<query>" [--project <p>] [--limit <n>] [--json]
osa memory forget --project <p> | --all [--yes] [--json]
```

- `save` validates, redacts and stores one fact; an identical fact in the same project is de-duplicated (its
  `updated_at` is refreshed, no second row).
- `search` ranks non-deleted facts with FTS5 bm25; query text is escaped, so FTS operators you type (`"`, `*`, `OR`,
  `NEAR(`) are treated as literal text and cannot inject query syntax. Ordering is deterministic: rank, then
  `created_at`, then id.
- `forget` physically **purges** the matching rows and their FTS entries, then runs `VACUUM`, and reports the count.
  A project match is exact (`forget --project x` never touches project `xy`) and uses the same name cleaning as `save`.
  `--all` requires `--yes`, and `--project` together with `--all` is refused. The purge also merges away the search
  index's old segments (FTS5 otherwise keeps deleted words until a merge), overwrites freed pages (`secure_delete`) and
  truncates the write-ahead log; a test checks that neither the database file nor its `-wal` still contains the text.

MCP tools (for any client that has OSA's server registered): `memory_save` and `memory_search`, mirroring `save` and
`search`. They are named apart from the existing project-memory tools `memory_append` / `memory_read`.

## How to forget

Run `osa memory forget --project <name>` to wipe one project, or `osa memory forget --all --yes` to wipe everything.
Deletion is a real purge: the rows and their search-index entries are removed and the database file is vacuumed. The
`deleted_at` column exists only so later export/import/sync can be added; `forget` does not merely mark a row deleted.
