# context.md -- wordcount toy build

## Toolchain constraint

Node.js only. No `package.json` dependency of any kind, no build step, no bundler, no transpiler.
Tests use Node's own built-in `node:test` runner, invoked directly as `node --test wordcount.test.mjs`.
This mirrors OSA's own toolchain philosophy for itself: zero dependencies, nothing to install
beyond Node.js.

## Required behaviour, restated for this document's own record

`wordcount.mjs` reads all of stdin and prints exactly one line to stdout in the exact format
`lines: <n> words: <n> chars: <n>`, then exits `0`.

## Mandatory reading order

Before writing any code in this phase, read this file (`context.md`) and `baby_prd.md` in full. Both
are short, foundational documents for this build and must genuinely be read, not merely referenced by
path, before any implementation work begins. `PHASE_1_SPEC.md` in this same directory is the
phase's own technical blueprint and must also be read in full before implementation starts.
