# Phase 1 spec — wordcount-cli (complete tool)

## Goal
Ship a working, dependency-free Node.js CLI that counts whitespace-delimited words per file, prints a combined total, reports per-file errors without aborting, and exits nonzero when any file fails — with a passing `node --test` suite and a README.

## Scope
The entire PRD: argument handling, per-file counting and output, the total line, resilient per-file error handling, exit codes, the built-in-only constraint, and tests/docs. Nothing is deferred to a later phase (there is no later phase).

---

## Part A (first agent)

Build the core: project scaffold, pure counting logic, the read/count/output loop with basic resilient error handling, and happy-path tests. Finish with a real commit.

### Files
- `package.json`
- `lib/wordcount.js`
- `wc.js`
- `test/wordcount.test.js`
- `test/cli-basic.test.js`
- `test/fixtures/hello.txt`, `test/fixtures/two-lines.txt`, `test/fixtures/empty.txt`

### Interfaces and behaviour

**`package.json`**
- `"name": "wordcount-cli"`, `"version": "1.0.0"`, `"private": true`, `"type": "commonjs"`.
- `"bin": { "wordcount": "wc.js" }`.
- `"engines": { "node": ">=18" }`.
- `"scripts": { "test": "node --test" }`.
- No `dependencies` and no `devDependencies` keys (or both empty objects).

**`lib/wordcount.js`** (pure; no `require` of `node:fs`/`node:process`)
- `function countWords(text)` → `number`. Returns `text.split(/\s+/).filter(Boolean).length`. Must return `0` for `""`, for whitespace-only input, and collapse runs of spaces/tabs/newlines (no inflation from leading/trailing/multiple whitespace).
- `function formatCountLine(count, name)` → `string`. Returns `` `${count} ${name}` ``.
- `module.exports = { countWords, formatCountLine }`.

**`wc.js`** (entry; starts with `#!/usr/bin/env node`)
- `const { readFileSync } = require('node:fs');` and `const { countWords, formatCountLine } = require('./lib/wordcount');`.
- Read `const files = process.argv.slice(2);`.
- (No-args handling and refined error messaging are Part B — in Part A, if `files` is empty, simply print nothing/total `0` is acceptable; do not crash.)
- For each `file` in `files`, in order:
  - `try`: `const text = readFileSync(file, 'utf8'); const n = countWords(text); console.log(formatCountLine(n, file));` and add `n` to a `total` accumulator.
  - `catch (err)`: `console.error(\`wc: cannot read '${file}': ${err.message}\`);` and `process.exitCode = 1;` then continue to the next file (do not rethrow, do not `break`).
- After the loop: `console.log(formatCountLine(total, 'total'));`.
- Never call `process.exit()`.

### Tests (Part A)
`test/wordcount.test.js` (uses `node:test` + `node:assert/strict`):
- `countWords('hello world')` === 2.
- `countWords('')` === 0; `countWords('   \n\t ')` === 0.
- `countWords('  a   b  c  ')` === 3 (leading/trailing/multiple whitespace ignored).
- `countWords('line one\nline two')` === 4 (newlines are whitespace).
- `formatCountLine(3, 'a.txt')` === `'3 a.txt'`.

`test/cli-basic.test.js` (spawns `node wc.js ...` via `node:child_process.spawnSync`, asserts stdout + exit code):
- Fixtures: `hello.txt` contains `hello world` (2 words); `two-lines.txt` contains two lines totalling e.g. 4 words; `empty.txt` is empty (0 words).
- Single file: `node wc.js test/fixtures/hello.txt` → stdout includes `2 test/fixtures/hello.txt` and a final `2 total` line; exit code 0. (AC1)
- Multiple files: running with `hello.txt` and `two-lines.txt` → one count line per file, in argument order. (AC2)
- Total: the final line equals `"<sum> total"` where sum is the two per-file counts added. (AC3)

Commit with a message describing the core CLI + happy-path tests.

---

## Part B (second agent)

Harden the core from Part A: precise error messaging, edge cases, no-args usage, exit-code correctness, the dependency-free guard, full error-path/integration tests, and the README. Finish with a real commit.

### Files
- Modify: `wc.js`
- Add: `test/cli-errors.test.js`
- Add: `test/no-deps.test.js`
- Add: `README.md`
- Add fixtures as needed (e.g. `test/fixtures/words.txt`); may create temp files via `node:os.tmpdir()` + `node:fs`.

### Interfaces and behaviour

**`wc.js` changes**
- No-args: if `process.argv.slice(2)` is empty, `console.error('usage: node wc.js <file> [<file> ...]');` set `process.exitCode = 1;` and return without printing a total.
- Refine the `catch` block to distinguish error kinds while keeping the resilient loop:
  - `const reason = err.code === 'ENOENT' ? 'No such file or directory' : err.message;`
  - `console.error(\`wc: cannot read '${file}': ${reason}\`);`
  - `process.exitCode = 1;` continue.
- Behaviour preserved: valid files before and after a failing file are still counted and printed; the total (over successfully-read files only) still prints after the loop; exit code is `0` only when no file failed.

### Tests (Part B)
`test/cli-errors.test.js` (spawnSync, assert stdout, stderr, exit code):
- Missing file alone: `node wc.js does-not-exist.txt` → stderr contains `does-not-exist.txt`; exit code nonzero (!== 0). (AC4, AC7)
- Mixed valid + missing: args `[hello.txt, does-not-exist.txt, words.txt]` → stdout has count lines for both valid files and a `total` line equal to their sum; stderr names the missing file; exit code nonzero. (AC5, AC7)
- All-valid run: exit code is exactly `0`.
- Directory as path: pass an existing directory (e.g. `test/fixtures`) → error reported to stderr, loop continues, exit code nonzero. (edge of AC4/AC5)
- Empty file: `empty.txt` alone → stdout `0 test/fixtures/empty.txt` then `0 total`; exit code 0.
- No args: `node wc.js` → stderr contains `usage:`; exit code nonzero; no `total` line on stdout.

`test/no-deps.test.js`:
- Parse `package.json`; assert `dependencies` and `devDependencies` are absent or empty objects. (AC6)
- Read `wc.js` and `lib/wordcount.js`; assert every `require(...)` argument is either a relative path (`./…`) or a `node:`-prefixed built-in — no bare third-party specifiers. (AC6)

**`README.md`**: one-line description; requirements (Node >= 18); usage (`node wc.js <file> [<file> ...]`); an example with sample output (per-file lines + total); explanation that missing/unreadable files print an error to stderr but the rest are still counted and the process exits nonzero; a "Run tests: `npm test`" line; a note that it uses only Node built-in modules.

Commit with a message describing error handling, edge-case/integration tests, the no-deps guard, and docs.

---

## Acceptance-criteria mapping
| PRD AC | Phase/Part | Concrete check |
|---|---|---|
| 1. Single file → name + whitespace-token count | P1 Part A | `cli-basic.test.js` single-file assertion + `wordcount.test.js` |
| 2. Multiple files → one line each | P1 Part A | `cli-basic.test.js` multi-file, one line per file in order |
| 3. Total = sum of per-file counts | P1 Part A | `cli-basic.test.js` asserts final `"<sum> total"` |
| 4. Nonexistent file → error identifying it | P1 Part B | `cli-errors.test.js` missing-file stderr contains filename |
| 5. Missing alongside valid → valid still counted + total prints | P1 Part B | `cli-errors.test.js` mixed-args stdout has valid lines + total |
| 6. Only built-ins; no package.json dependencies | P1 Part B | `no-deps.test.js` checks package.json + require specifiers |
| 7. Missing file → nonzero exit while valid files processed | P1 Part B | `cli-errors.test.js` asserts exit code !== 0 with valid output present |

## Documentation sources
- Node.js File system (fs) API documentation — https://nodejs.org/api/fs.html
- File system | Node.js — fs.readFileSync — https://nodejs.org/api/fs.html#fsreadfilesyncpath-options
- File system | Node.js — fs.readFile / fsPromises.readFile — https://nodejs.org/api/fs.html#fsreadfilepath-options-callback
- Node.js Process API documentation — https://nodejs.org/api/process.html
- Process | Node.js — process.argv — https://nodejs.org/api/process.html#processargv
- Process | Node.js — process.exit / process.exitCode — https://nodejs.org/api/process.html#processexitcode_1
- Errors | Node.js — Common system errors (ENOENT, error.code/path) — https://nodejs.org/api/errors.html#common-system-errors

## Out of scope for this phase
- Line or character counting; recursive directory traversal or glob expansion; reading from stdin; non-UTF-8 encodings; locale-aware word segmentation; publishing to any package registry (all per PRD "Out of scope").
- Flags/options such as `--help`/`--quiet`, concurrency/async reads, and distinct exit codes per error type (a single nonzero `1` suffices for AC7).

## Spec assumptions

Gaps found while writing this spec were resolved as follows (nobody was asked):

- The project uses CommonJS (`require('node:fs')`, `module.exports`); `package.json` sets `"type": "commonjs"`; there is no build/transpile step.
- The CLI entry script is `wc.js` at the repo root, with a `#!/usr/bin/env node` shebang (invoked as `node wc.js <files...>`).
- Word-counting logic lives in a separate, importable pure module (`lib/wordcount.js`) so it can be unit-tested without spawning a process; `wc.js` is the thin I/O shell.
- A "word" is a maximal run of non-whitespace characters: `text.split(/\s+/).filter(Boolean).length` (honours the PRD's [risky] whitespace-token definition; empty or whitespace-only files count 0).
- Per-file output goes to **stdout** in the format `"<count> <filename>"` (single space), matching the PRD's locked "count<whitespace>filename, similar to Unix `wc`" assumption.
- The final line is `"<count> total"` on stdout, printed once after all per-file lines (the PRD's "labeled as a total" assumption; `total` is the label, as in `wc`).
- Error messages go to **stderr** in the format `"wc: cannot read '<path>': <reason>"`, where `<reason>` is `"No such file or directory"` when `err.code === 'ENOENT'` and `err.message` otherwise; the offending path is always named (AC4).
- Running with no file arguments prints `"usage: node wc.js <file> [<file> ...]"` to stderr and exits with code 1 (treated as a usage error).
- A path that resolves to a directory (or any non-ENOENT read failure, e.g. EISDIR/EACCES) is treated as an unreadable file: its error is reported, processing continues, and the exit code becomes nonzero.
- Exit code is `0` when every provided file was read successfully, and `1` if one or more could not be read; implemented via `process.exitCode = 1` (never `process.exit()`), so all output flushes.
- Files are read synchronously and wholly into memory with `fs.readFileSync(path, 'utf8')`.
- Target runtime is Node.js **>= 18** (declared in `package.json` `engines`); tests use the built-in `node:test` runner and `node:assert` via `node --test`. No specific Node patch/line is pinned, because the research's exact-version claims (24.20.0 / LTS-line labels) are listed as unconfirmed.
- Package name is `wordcount-cli`; the `bin` name is `wordcount`.

## Implications

Second-order consequences found by an independent review of this spec. This section only adds to the spec; the locked PRD is unchanged.

### Additional acceptance criteria

S1. When a supplied path contains terminal control characters, stdout and stderr escape or remove those characters so they cannot control terminal display. _(security: Raw file paths are written to the terminal in count and error output. A path containing ANSI escape or other control characters can alter or spoof terminal output.)_

### Explicitly out of scope

- Files too large to fit comfortably in available memory are unsupported; the CLI provides no streaming or large-file performance guarantee. _(performance)_
