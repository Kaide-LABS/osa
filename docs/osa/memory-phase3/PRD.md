# Persistent memory, step 3: reuse documentation research across projects

Steps 1 and 2 built the global memory store and made every run write into it. Step 3 makes a run READ from it, for the one thing that costs real tokens and repeats: the documentation research. A measured run spends 27 to 28 percent of its tokens on research input, and every project that names React, SQLite or Express pays for "find the official documentation" again.

## Decisions already made by the user (do not revisit)
- One global database, `~/.osa/memory.db`, project column, capture on by default, `osa memory forget` wipes a project or everything.
- The raw run chat log stays WRITE-ONLY; nothing reads it.
- The pitch is accuracy and freshness first, tokens second: stale or unverified research must never be served.

## Scope: documentation items only
A research outline has two kinds of item. A documentation item's question is fixed by the technology's name ("Find the OFFICIAL documentation for \"<target>\": current stable version, how it is installed, the API surface, breaking changes in <time range>"), so it repeats across projects. A free-form research item is worded per project and almost never matches, and matching it by similarity would risk serving the wrong answer. Step 3 reuses documentation items only. Academic search, GitHub lookup, and the report slicing for the spec stage are out of scope.

## What step 3 delivers
1. **Remember.** After the research stage, each documentation item that finished is stored in the global database, but only when the independent cross-check ran and flagged NOTHING in the report. A run whose check was disabled, failed, or flagged any claim stores nothing.
2. **Reuse.** Before a documentation item's agent is started, the store is asked for the same technology. A stored result is reused only when it is no older than the freshness window (default 30 days), still passes the current validator for that item, and passes the same untrusted-data screening as a fresh result. Otherwise the agent runs exactly as before.
3. **Visible provenance.** A reused item is marked in the research report ("reused from an earlier run, project P, N days old"), in the item's event, and in the run summary's counts, so the spec author and the person can see what was not freshly researched.
4. **Switches.** `memory.global.reuse.enabled` (default true) and `memory.global.reuse.maxAgeDays` (default 30). With reuse off, the store is never read by a run and behaviour is identical to today.
5. **Fail-soft.** A locked, corrupt or unwritable database is a cache miss. A run never fails or waits long because of it.
6. **Forgetting.** `osa memory forget --project p` and `--all` also remove remembered research.

## Out of scope
Reading facts back into prompts, free-form item reuse, semantic matching, a dashboard, sync.

## Done when
- Typecheck, the full suite and the boundary scan pass; all new code has tests.
- Two runs of a project naming the same technology: the second skips that item's agent call, and the report and events say so. A stale (older than the window), invalid, or secret-shaped entry is never served.
- With reuse off, no database file is created by a run's research stage and no store module is imported.
- A secret or an instruction planted in a stored result never reaches a prompt (the screening that fresh results get applies to reused ones).
- The feature-off static import graph invariant still passes.
