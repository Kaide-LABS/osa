# baby_prd.md -- wordcount toy build

## Problem

Build a single-file, dependency-free Node.js CLI, `wordcount.mjs`, that reads all of stdin and
prints exactly one line to stdout:

```
lines: <n> words: <n> chars: <n>
```

where `<n>` is replaced with the real count in each position (line count, word count, character
count, of the stdin it read). Nothing else is printed to stdout. The program exits `0` on success.

## What this build is for

This is a demonstration build, not a production deliverable. Its only purpose is to exercise
OSA's own cross-provider handoff end to end on a genuinely small, genuinely real coding task:
one AI coding provider starts this single phase, hands off, and a second, different provider
genuinely continues and finishes it on the same repository. The quality bar for `wordcount.mjs`
itself is "correct and tested," not "production-grade" -- the interesting thing being demonstrated is
the handoff, not the tool.
