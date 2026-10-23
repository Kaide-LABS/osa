# PHASE_1_SPEC.md -- wordcount toy build

This is the toy build's own single-phase technical blueprint. It has no relationship to
OSA's own root-level `PHASE_1_SPEC.md` beyond sharing loopr's generic naming convention --
this file describes work inside the materialized toy repository only.

## Files to add

1. `wordcount.mjs` -- a single-file, dependency-free Node.js CLI. Reads all of stdin to completion,
   then prints exactly one line to stdout:

   ```
   lines: <n> words: <n> chars: <n>
   ```

   with each `<n>` replaced by the real count for that position:
   - **lines**: the number of newline-terminated lines in the input. An input with no trailing
     newline still counts its final, unterminated line.
   - **words**: the number of maximal whitespace-separated non-empty tokens.
   - **chars**: the total number of characters read (UTF-8 code points), including all whitespace and
     newlines.

   Prints nothing else to stdout. Exits `0` on success.

2. `wordcount.test.mjs` -- a colocated test file using Node's built-in `node:test` runner (`import
   { test } from "node:test"`), asserting `wordcount.mjs`'s stdout against at least the concrete case
   below.

## Concrete test case

Given the stdin input `"hello world\nfoo\n"` (two lines, three words, 16 characters), running
`wordcount.mjs` against that input must print exactly:

```
lines: 2 words: 3 chars: 16
```

At least this one case must be a real, executable assertion in `wordcount.test.mjs` -- spawning
`wordcount.mjs` as a child process with that exact stdin and asserting its stdout equals that exact
line (including the trailing newline `wordcount.mjs` itself writes), or an equivalent in-process
assertion against the same logic, whichever is simpler to write correctly.

## Acceptance criterion

Running, from inside the materialized toy repository:

```
node --test wordcount.test.mjs
```

must exit `0`.

## Reviewer's own responsibility (this build's final phase)

This is the toy build's only phase (`is_final_phase: true` in `run-config.template.json`). The
reviewer turn must, after verifying the two files above satisfy this spec, genuinely write and commit
a `BUILD_COMPLETE.md` file at the toy repository's root recording that this build is done -- not
merely reference an existing one.
