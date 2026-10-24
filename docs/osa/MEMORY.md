# OSA global memory

OSA keeps **one** global memory database that survives across projects and runs. Step 1 built the store and its
read/write surfaces; step 2 makes every finished or stopped run capture what it learned into that store; step 3 lets a
run reuse a prior run's **documentation research** (see "Reusing documentation research across runs" below). Reading
general facts back into prompts, free-form research reuse, ingestion of outside sources, and any dashboard/sync are later
steps and are **not** built yet.

## What a run captures

At the end of a run that got past the lock (finished **or** stopped early -- a stopped run's failures are the most
useful facts), the same facts OSA already derives for the project's `.osa/memory` files are **also** saved to the global
store, plus one run-summary note. The facts come only from the run's RECORD (what the person locked, the spec and
architecture decisions, per-phase outcomes, the application check, research outcomes) via `deriveFacts`, which is
deterministic and makes no model call -- never from the raw chat log, which stays write-only. Be aware that the record
itself holds text a model or a web page wrote (the goal summary, assumptions, spec decisions, the architecture reason,
flagged research claims): the store's secret, hidden-text and instruction checks are the only gate on those, and they
are pattern-based (see the known limits above).

A run that stops by an **exception** after the lock (the locked PRD was changed, or research or the spec stage failed) is
captured too, as a stopped run. Its note uses fixed words only: no error message and no text from the failure is stored.
A run that stops before the lock has nothing locked to remember and is not captured.

- **The run-summary note** (kind `note`, always first): the outcome and why, then the phase and requirement counts, the
  architecture chosen, and the locked goal in whatever room is left (the counts can never be pushed out by a long goal).
  A spec-only run says "spec only, nothing built" and reports no counts; if the final check could not run or was not
  run, the note says so instead of reporting "0 unmet requirements". If the goal itself would be refused (for example
  it quotes an instruction), the note is still stored, without the goal.
- **Decisions** (risky assumptions accepted, the architecture decision, spec decisions, out-of-scope choices) as kind
  `decision`; **failures**, **preferences** and **conventions** as kind `fact`.
- At most **40** facts per run (the summary note first), each cleaned and clipped to 300 characters. Secrets, hidden
  text and instructions are redacted or refused by the store exactly as for a manual `osa memory save`.

The project is derived from the repository folder's name (its basename), cleaned the same way a label is; an empty,
over-long or secret-shaped folder name falls back to `default`. The source label is `osa run <first 8 chars of the run
id>`. A second run of the same project does **not** duplicate identical facts (the store de-duplicates per project); only
genuinely new facts are added.

Capture is **fail-soft**: it runs after the run's own outcome is already decided and can never change the run's outcome,
exit code or timing. An unreachable, locked or corrupt database becomes a single `global_memory_failed` event (reason
class only: `locked`, `corrupt`, `unwritable`, `fts-unavailable`, `other`, taken from the error's type, not from its
text) and nothing else. A capture saves all of a run's facts through one open connection and waits at most 1.5 seconds
for another process's lock, so a busy database costs a run about a second and a half, not the full five. A successful
capture emits `global_memory_written` with counts (saved, deduped, refused, redacted spans, and `truncated`: facts left
out by the 40-fact cap) and the reason classes of any refusals -- **never** any fact text, the goal, or any user text.

Two repositories with the same folder name share one project name, and so share de-duplication; the name is the folder's
basename and nothing more.

## Turning capture off, and forgetting a run

- **Off:** set `"memory": { "global": { "capture": false } }` in `osa.config.json`. With it off, nothing is written, the
  store module is never loaded, and the database file is not even created. (`"memory": { "enabled": false }` turns off
  both project memory and global capture.)
- **Forget:** `osa memory forget --project <folder-name>` wipes everything a project captured, or
  `osa memory forget --all --yes` wipes the whole store. See "How to forget" below.

> **Step 1 note (below):** the step-1 sections said "nothing writes to it automatically yet". Step 2 is that automatic
> writer; the store guarantees, limits and the forget semantics it describes are unchanged.

## Reusing documentation research across runs (step 3)

Documentation research repeats across projects: every build that names React, SQLite or Express pays to "find the official
documentation" again, and in a measured run that documentation lookup is 27–28% of the research input tokens. Step 3 lets a
run READ a prior run's documentation result back instead of researching it afresh. Accuracy and freshness come first: a
stale or unverified result is never served.

**Scope: documentation items only.** A research outline has two kinds of item. A *documentation* item's question is fixed
by the technology's name ("Find the OFFICIAL documentation for `<target>` …"), so it repeats verbatim across projects and is
safe to key by that name. A *free-form* research item is worded per project, almost never matches, and is never remembered
or reused — matching it by similarity would risk serving the wrong answer.

- **What is remembered.** After the research stage, each documentation item that finished is stored in the global
  database — but **only** when the independent cross-provider check ran and flagged nothing in the report. A run whose check
  was disabled, failed, or flagged any claim stores nothing. The validated result JSON is stored exactly as it was written
  to disk (already screened), keyed by the normalised technology name, with the origin project and the check level (full or
  consistency-only). One row per key: a newer result replaces the older one. A result over 64 KB or on which the secret
  filter still fires is refused (counted, not stored), and the store keeps at most 500 rows, evicting the oldest.
- **When it is reused.** Before a documentation item's agent is started, the store is asked for the same technology. A
  stored result is reused only when it is **no older than the freshness window** (default 30 days), still **passes the
  current validator** for that item (a docs item requires an official-docs source), and passes the **same untrusted-data
  screening** a fresh result gets. Any failure at any step is a cache miss and the agent runs exactly as before. A reused
  result is written to the item's result file and used like a fresh one.
- **Visible provenance.** A reused item is marked in the research report (`Reused from an earlier run (project P, N days
  old) …`), in its `research_item_done` event (status `reused`), and in the stage's counts (`research_validated` carries
  `reused`; `research_reused` carries `items`, `oldestAgeDays` and a `resultCharsEstimate` lower bound on the output
  avoided). No documentation target, project name or stored text ever appears in an event.
- **Untrusted data.** A stored result is third-party text derived from web pages. It gets exactly the same validation and
  screening as a fresh result every time it is used; storing it never makes it trusted. A secret or an instruction planted
  into a stored row is neutralised exactly as it would be in a fresh result (or the result fails to validate and is a miss),
  so it never reaches a prompt.

**Freshness window and the switch.** Reuse is **on by default** with a 30-day window:

```json
"memory": { "global": { "reuse": { "enabled": true, "maxAgeDays": 30 } } }
```

`maxAgeDays` is 1–365. With `enabled` false the research stage imports no store module and opens (or creates) **no**
database — behaviour is identical to before step 3. (`"memory": { "enabled": false }` turns the whole feature off too.)

**Fail-soft.** A locked, corrupt or unwritable database is a cache miss: the lookup (and the remember) swallow the error
after a single `research_reuse_failed` event carrying only a reason class (`locked`, `corrupt`, `unwritable`,
`fts-unavailable`, `other`), and the run proceeds unaffected. The lookup waits at most 1.5 seconds for another process's
lock, so a busy database never makes a run wait long.

**Forgetting.** `osa memory forget --project <folder-name>` and `--all` remove a project's (or all) remembered research
along with its facts. The rows are physically purged and the file vacuumed; the forgotten target text survives in neither
the database file nor its `-wal`. The `research_items` table is not search-indexed, so no index segments hold its text.

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
