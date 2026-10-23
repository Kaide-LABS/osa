# Project context — wordcount-cli

## What this is
A small, dependency-free Node.js command-line tool that counts whitespace-delimited words in one or more text files, prints a per-file count line and a combined total, and keeps going (with a nonzero exit code) when an individual file is missing or unreadable.

## Stack and why
- **Runtime: Node.js (>= 18), standard library only.** The locked PRD forbids third-party packages (AC6). Everything needed is built in: `node:fs` for reading files, `node:process` for arguments and exit code.
- **Language: plain JavaScript, CommonJS.** No TypeScript/transpile step keeps the tool runnable directly (`node wc.js ...`) and the repo dependency-free.
- **Testing: `node:test` + `node:assert` (run via `node --test`).** The built-in test runner honours the zero-dependency constraint (the research's prior-art note explicitly warns against pulling in Jest for this reason).
- **File reads: synchronous `fs.readFileSync(path, 'utf8')` inside a per-file `try/catch`.** The research confirms this returns a string (not a Buffer) and throws a catchable error, giving the simplest resilient per-file loop.
- **Exit signalling: `process.exitCode = 1`, never `process.exit()`.** Official docs (and the research) warn `process.exit()` can truncate buffered stdout; setting `exitCode` lets all counts and the total print before the process exits nonzero.

## Repo layout
```
/
├── wc.js                 # CLI entry (shebang); arg parsing, read loop, output, exit code
├── lib/
│   └── wordcount.js      # pure logic: countWords(text), formatCountLine(count, name)
├── test/
│   ├── wordcount.test.js # unit tests for lib/wordcount.js
│   ├── cli-basic.test.js # integration: happy-path single/multi file + total
│   ├── cli-errors.test.js# integration: missing/unreadable, mixed, no-args, exit codes
│   └── fixtures/         # sample .txt files used by integration tests
├── package.json          # name, bin, engines, scripts.test; empty dependencies
└── README.md             # usage, examples, exit-code semantics
```

## Conventions
- CommonJS everywhere (`require` / `module.exports`).
- Import built-ins with the `node:` prefix (`require('node:fs')`).
- Pure, side-effect-free functions in `lib/`; all I/O (argv, stdout/stderr, exit code) only in `wc.js`.
- Counts → stdout (`console.log`); errors/usage → stderr (`console.error`).
- Tests are deterministic: integration tests spawn `node wc.js` via `node:child_process` against files in `test/fixtures/` and temp files, and assert on stdout, stderr, and exit code.

## Constraints
- No runtime or dev dependencies — `dependencies` and `devDependencies` must be empty/absent (AC6).
- Only Node built-in modules may be imported (`node:fs`, `node:process`, `node:test`, `node:assert`, `node:child_process`, `node:path`, `node:os`).
- UTF-8 plain text only; no stdin, no globbing, no directory recursion, no line/char counting (all out of scope per PRD).

## Glossary
- **Word / token** — a maximal run of non-whitespace characters (whitespace = `/\s+/`).
- **Per-file line** — `"<count> <filename>"` on stdout.
- **Total line** — `"<count> total"` on stdout, after all per-file lines.
- **ENOENT** — Node system-error code for "no such file or directory"; identified via `err.code` (never `err.message`).
- **Resilient loop** — each file read is wrapped so one failure reports an error and continues with the rest.

## Research digest
The Node.js standard library covers the whole task. `process.argv.slice(2)` yields the user-supplied file paths. `fs.readFileSync(path, 'utf8')` reads a file to a string synchronously and throws on failure; a missing file throws an error with `code === 'ENOENT'` and a `path` property naming the file — identify errors by `err.code`, not `err.message` (which is documented as unstable across versions). For partial failure, set `process.exitCode = 1` and continue rather than calling `process.exit()`, which can truncate buffered output; this lets valid files still print while signalling nonzero. Word counting is pure JS: trim/split on `/\s+/` and filter empty strings. A cross-provider check flagged the report's specific Node version labels (24.20.0, LTS-line naming) as unconfirmed, so this project targets Node >= 18 generically and pins no exact version; the API-surface and error-handling guidance (fs/process/errors docs) was confirmed. Prior art offered no reusable code under the zero-dependency rule — only the whitespace word-count definition and the "use built-in `node:test`, not Jest" note.

## Phase plan
- **Phase 1 (the whole project):** Deliver the complete CLI and its tests. Part A builds the core (package scaffold, pure `countWords`, the read/count/output loop with basic resilient error handling, and happy-path tests). Part B hardens it (ENOENT-vs-other error messaging, directory/unreadable edge cases, no-args usage, exit-code correctness, the AC6 "no deps / builtins only" guard, full error-path and integration tests, and the README). No further phases are needed.

## Planned architecture
The tool is split into a **pure core** (`lib/wordcount.js`) and a **thin I/O shell** (`wc.js`). `wordcount.js` exports `countWords(text)` and `formatCountLine(count, name)` — no file system, no process access — so word-counting semantics (AC1, AC3) are unit-testable in-process without spawning or touching disk. `wc.js` owns everything non-deterministic: it reads `process.argv.slice(2)`, loops over each path reading it synchronously inside a `try/catch`, prints `"<count> <filename>"` per success, accumulates a running total over successfully-read files, and on any failure writes an identifying message to stderr and sets `process.exitCode = 1` while continuing the loop. After the loop it prints `"<count> total"`. This separation is why the resilient-loop requirements (AC4, AC5, AC7) fall out naturally: the error boundary is per-iteration, so one bad file can never skip the rest or the total, and `exitCode` (not `exit()`) guarantees the already-queued stdout writes flush before a nonzero exit.

I chose synchronous `readFileSync` over async `fs.promises`/`Promise.allSettled` deliberately: the files are assumed small (PRD), output ordering must match argument order, and a sequential synchronous loop is the simplest construct that is both correct and trivially deterministic for tests — concurrency would add ordering/interleaving complexity for no benefit here. I identify missing files by `err.code === 'ENOENT'` rather than parsing `err.message`, per the Node errors docs, and treat every other read failure (e.g. a directory path → EISDIR) through the same resilient path so the tool never aborts mid-run. An independent reviewer might argue the pure/shell split is over-engineering for a ~40-line tool; the justification is testability under the zero-dependency rule — without an importable pure function, every word-count assertion would require spawning a subprocess, making the test suite slower and the counting semantics harder to pin down.

## Architecture decision

An independent reviewer proposed: Concurrent read-and-collect.

**Chosen:** the planned architecture

**Why:** The PRD assumes files are small enough to fit comfortably in memory and says nothing about large file counts or throughput, so the concurrent design optimizes for a scenario this project does not have while adding async coordination, a result-collection buffer, and concurrency-limiting machinery to a ~40-line tool. The deciding trade-off is determinism and simplicity versus speculative speed: the sequential synchronous loop makes output ordering, running-total accumulation, and per-iteration error boundaries fall out for free (directly satisfying AC2, AC3, AC5, AC7), whereas the alternative must re-impose argument-order output and total-over-successes as a separate aggregation step it broke apart. The alternative's only concrete advantage — elapsed-time reduction across many files — is explicitly outside the PRD's assumptions, and even the lateral reviewer leans keep-planned. Adopting it would be choosing complexity against the project's own stated constraints.
