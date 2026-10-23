# Code-search evaluation fixture

A hand-labelled set of 40 code-search queries over three real repositories, for comparing search engines
(plain grep, a lexical TF-IDF index such as `osa search`, codebase-memory-mcp, ...). Every label was made by
reading the code at the pinned snapshot; `validate-labels.mjs` re-checks the mechanical part of every label.

## Files

| File | Purpose |
|---|---|
| `queries.json` | `{ schema_version, repos, queries[] }` - the fixture itself. |
| `snapshots.json` | How to reproduce the exact trees the labels refer to (git commit per repo, total file count, sha256 manifest of every file a label or decoy touches). |
| `validate-labels.mjs` | Dependency-free Node (ESM, `node:` builtins only) validator. |
| `snapshots/` | Not used. All three repos were clean git trees, so a pinned commit reproduces them; nothing was copied. (If you ever copy a tree here, `snapshots/` is meant to be gitignored and must be listed in `snapshots.json`.) |

## Repositories

| name | language | tree | why |
|---|---|---|---|
| `osa` | TypeScript | `C:\Users\hp\OSA` at commit `2ac3f97` (233 files in the tree) | The tool under test; `src/{osa,research,trim,dispatch,verify,code-index,memory,agents,mcp}`, plus `docs/osa/*.md` and `README.md` as spec-like artifacts. No `OSA_DIRECTIVE.md` exists in the tree. Nothing under `evals/`, `node_modules` or `dist` is labelled (the validator rejects it). |
| `hostel` | Python | `C:\Users\hp\hostel-c` at commit `0738437` (47 files) | The most complete of the four candidates: it has `app/` (Streamlit UI), `engine/`, `policy/`, `shared/`, `data/`, `tests/`, `specs/` and `CONTRACT.md`. `hostel-a` lacks `policy/` and `app/`; `hostel-b` lacks `app/`; `PAU-HACKATHON` has the same file set as `hostel-c` plus a `README.md` but a different (later, Streamlit-Cloud) history, so it adds nothing to label. Working tree was clean. `CONTRACT.md` and `specs/*.md` are its spec artifacts. |
| `hms` | Python | `C:\Users\hp\HMS` ("Mizan") at commit `fe60f06` (93 files) | The "other" repo. 66 Python files / ~14k lines of real, non-generated code (EDGAR/Tiingo ingest into DuckDB, AAOIFI-style screening, a backtest with a compliance-flip state machine, a purification ledger, an HTML report), with a different domain and package layout from the other two. Not vendored, no data blobs, clean working tree. `MASTER_PRD.md`, `PHASE_N_SPEC.md` and `docs/modernization_log.md` are its spec artifacts. Rejected: `kaide-loop` (318 files, many logs/generated artifacts), `CuratedTube` (936 files incl. `node_modules`, and TypeScript like OSA), `Aloft-Compliance-Firewall`/`fairshot` (smaller, thinner logic). |

Caveat: `hostel` and `hms` are both Python. A non-TypeScript, non-Python repo with enough real code was not available on
this machine without going into vendored or experimental trees.

## Materialising the snapshots

The labels refer to *commits*, not working trees (the OSA working tree is dirty and moves on). Materialise into a scratch
directory that is **outside** the repos:

```bash
SCRATCH=/some/scratch/dir
mkdir -p $SCRATCH/osa $SCRATCH/hostel $SCRATCH/hms
git -C C:/Users/hp/OSA archive 2ac3f97 | tar -x -C $SCRATCH/osa
git -C C:/Users/hp/hostel-c    archive 0738437 | tar -x -C $SCRATCH/hostel
git -C C:/Users/hp/HMS         archive fe60f06 | tar -x -C $SCRATCH/hms
```

`git archive` is read-only on the repos. Point the engines under test at these three directories and give the validator the
same directories.

## Validating

```bash
node evals/code-search/validate-labels.mjs --root osa=$SCRATCH/osa --root hostel=$SCRATCH/hostel --root hms=$SCRATCH/hms --check-hashes
```

Add `--dump` to print the first and last line of every expected range (useful for eyeballing labels). Exit code 0 means
all labels are valid; exit code 1 lists every failure. Checks: unique ids, known repo/kind, non-empty
query/answer/note, cross-file queries have 2-4 `expect` locations, every `expect` path exists, line numbers are integers with
`1 <= startLine <= endLine <= lines in file`, the range is not whitespace-only, decoy paths exist, nothing under
`evals/`/`node_modules`/`dist` is labelled, and (with `--check-hashes`) the sha256 of every touched file (CRLF normalised to
LF) equals the value in `snapshots.json`, which catches a tree that has drifted from the one the labels were written against.
The validator cannot prove a label is *semantically* right; that was done by reading the code.

## Format

```jsonc
{
  "id": "osa-04",            // <repo-prefix>-<nn>, unique; repo prefixes: osa, hostel, hms
  "repo": "osa",
  "kind": "paraphrase",      // exact-name | paraphrase | concept | call-path | cross-file | spec-artifact
  "query": "where do we hash the PRD",           // the ask as an engineer/agent would type it
  "expect": [ { "path": "src/osa/lock.ts", "startLine": 75, "endLine": 87 } ],
  "answer": "...",           // the specific fact a correct retrieval lets you state; grade free-text answers against it
  "note": "...",             // why it is hard / what the wrong-but-plausible hit is
  "decoys": [ { "path": "src/util/hash.ts", "why": "..." } ]
}
```

## Label conventions

* Paths are repo-relative with forward slashes; lines are 1-based and inclusive.
* `expect` lists every location that legitimately answers the query. A hit on **any one** counts for recall@5; **all**
  are needed to write the full `answer`. Cross-file queries have 2-4 locations; other kinds usually 1-3 (one query may list
  several ranges of the same file when they are separate blocks).
* Ranges are tight around the definition or block: a function's range includes the doc comment / docstring immediately
  above it when there is one, and ends at its closing line. A hit should be scored as a match when the returned chunk overlaps
  an expected range (suggested), or by file for coarser engines; the fixture does not prescribe one rule.
* `exact-name`: the query is an identifier; the label is its **definition**.
* `paraphrase`: no literal keyword overlap with the target's identifiers, by construction.
* `concept`: a design concept spread over a module; several ranges are listed and any one is an acceptable hit.
* `call-path`: the label is the **caller(s)**, never the definition (which is listed as a decoy). The query says "outside of
  tests" where tests also call the function; test callers are never labelled.
* `cross-file`: the answer needs 2-4 files/blocks.
* `spec-artifact`: the answer lives in markdown (README, `docs/osa/*.md`, CONTRACT/specs, PRDs, modernization log). Where the
  same fact is also stated in a code comment that fully answers it, that comment is listed in `expect` too (hms-13), and where
  a second spec line states it (hostel-06) it is listed as well.
* `decoys` are plausible wrong hits: definitions when the label is a caller, tests, similarly named functions, superseded
  spec text. They are informational (a decoy hit is a "wrong-but-plausible" result); only their existence is validated.

## Distribution (40 queries)

| kind | osa | hostel | hms | total |
|---|---|---|---|---|
| exact-name | 3 | 3 | 2 | 8 |
| paraphrase | 3 | 3 | 2 | 8 |
| concept | 2 | 2 | 2 | 6 |
| call-path | 2 | 2 | 3 | 7 |
| cross-file | 2 | 2 | 2 | 6 |
| spec-artifact | 2 | 1 | 2 | 5 |
| **total** | **14** | **13** | **13** | **40** |

No target is used by more than two queries (the shared targets are `osa/src/osa/lock.ts` `lockNow`, hostel `confirm_retention`
and `_retained`, hms `rebalance` and `compute_divestment_attribution`).

## Caveats

* Labels are valid only for the pinned commits. Use the materialised trees; do not point engines at live working trees.
* Spec-style repos restate facts in many documents (PRD, phase specs, completion reports). Spec-artifact labels point at
  the originating statement (plus fully-answering restatements noted above); a hit on a later restatement that merely
  repeats the fact is not covered by `expect`, so treat spec-artifact recall as a lower bound. The hms phase specs
  (`PHASE_N_SPEC.md`, 800-1100 lines each) are the most likely source of such near-misses.
* Some `expect` sets are judgement calls on how wide "the answer" is. The less-certain ids are `osa-04`, `osa-05`,
  `osa-07`, `hostel-06`, `hostel-07`, `hms-05`, `hms-12` and `hms-13`.
* The `osa` repo itself contains a code-index that is a likely engine under test; its own `src/code-index/*` files are
  labelled in `osa-07` and `osa-10` (as targets/decoys), which is intentional but means that engine indexes its own
  scoring code.
* The 'hashes' in `snapshots.json` use LF-normalised content, so a Windows checkout with CRLF still matches.

## Held-out set and query rewrites (2026-10-24)

* `queries-heldout.json`: 30 labelled queries over the OSA code at commit `4e2c517` (repo name `osa-clean`, materialise with `git archive` into
  `<snapshots>/osa-clean`). Written before any engine was run on them and **not to be tuned on**; use it to confirm a change made using `queries.json`.
  The validator above does not read it (it wants fields this file does not have); its labels were checked mechanically (file exists, range in bounds).
* `rewrites/plain.json`, `rewrites/paths.json`: query rewrites for all 70 questions (Claude Haiku; `paths` also saw the project's file list). Regenerate with
  `node scripts/code-search-rewrites.ts --queries evals/code-search/queries.json,evals/code-search/queries-heldout.json --out <file> [--paths]`.
* Run a comparison: `node scripts/code-search-eval.ts --tunings <rows.json> --rewrites plain=evals/code-search/rewrites/plain.json --queries <file> --out <dir>`; a row
  that has `"rewrite": "plain"` searches the rewrite's terms in addition to the question. Result tables: `results/rewrite-*.md`, `results/baseline-heldout.md`.
