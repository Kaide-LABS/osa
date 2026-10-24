# Persistent memory, step 2: capture each run into the global store

Step 1 (merged in PR 1) built the global memory database, `~/.osa/memory.db`, with `saveFact`, `searchMemory` and `forgetMemory`. Nothing writes to it automatically yet. Step 2 makes every finished or stopped OSA run write what it learned into that database.

## Decisions already made by the user (do not revisit)
- ONE global database with a `project` column. Capture is ON by default, with secret scrubbing, and `osa memory forget` wipes a project or everything.
- The raw run chat log stays WRITE-ONLY. Nothing in `src/` may read it. Step 2 captures only what the run RECORD already holds, never conversation.

## What step 2 delivers
1. At the end of a run, the facts that `deriveFacts` already builds for the project's `.osa/memory` files (decisions, conventions, failures, preferences) are ALSO saved to the global store, under a project name derived from the repository folder.
2. One run-summary note per run: the outcome (finished or stopped, and why), the locked goal in one line, the architecture chosen, how many phases passed, and the count of unmet requirements.
3. A config switch `memory.global.capture` (default `true`) so a person can turn it off, and an event `global_memory_written` (counts and rejection reasons only, never fact text), or `global_memory_failed` with a reason class.
4. Capture can never fail or slow a run: it is fail-soft, runs after the run's own outcome is decided, and an unreachable, locked or corrupt database becomes the failed event and nothing else.
5. A guard so the test suite can never write to the real `~/.osa`.

## Out of scope
Reading memory back into prompts (that is step 3, research reuse), outside sources, any dashboard or sync.

## Done when
- Typecheck, the full suite and the boundary scan pass; all new code has tests.
- A run's facts appear in the global store, and a second run of the same project does not duplicate identical facts.
- With capture off, nothing is written and the database file is not even created.
- A secret placed in the goal or in an assumption never reaches the database (redacted, or the fact refused and counted).
- With the memory feature unused, the static import graph invariant still passes (the global store is loaded by dynamic `import()` only).
