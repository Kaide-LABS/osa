# trim-1 -- verification notes (WS4 prerequisite)

Verified 2026-10-17 by a research subagent via direct fetch of the HF model card, GitHub README, LICENSE
and GitHub/npm APIs. **Nothing was built or run at that stage**; the HF card was read through a
summarising fetch, so figures marked (card) should be eyeballed against the primary source before
being quoted elsewhere. Section 6 (integration status) is updated as WS4 proceeds.

## 1. What it is, where it lives
- Code: `https://github.com/caveman-ai/trim-1` -- created 2026-10-14, one release `v0.1.0`, ~4 commits
  (very new). The release has **no binary assets** (source archives only).
- Weights: `https://huggingface.co/caveman-so/trim-1`, file `model.bin`; also embedded in the Go source.
- Parent: README says "trim-1 is the model inside Caveman" (`https://github.com/JuliusBrussee/caveman`).
  The Caveman README itself never mentions "trim"; how trim-1 is wired into the Caveman CLI was **not
  confirmed**. Treat trim-1 as a separate, v0.1.0 project.

## 2. Licence
Code and weights: **Apache-2.0** (LICENSE, GitHub SPDX, HF card). `model.go` embeds a BSD-3-Clause copy
of Go's `math.Exp` (`LICENSE-go`). OSI-open, commercially usable; "Caveman" name/logo are trademarks of
its author. -> **No licence blocker.** Attribution goes in `ATTRIBUTION.md`.

## 3. Model
Not a neural net: **712 gradient-boosted trees**, 67 numeric features per line (BM25 / query coverage,
line kind such as error/path/stack-frame, position/shape, neighbour scores); `model.bin` = 1,245,358
bytes (~1.2 MB). "Line-pruning" = each *line* gets a keep probability; lines above a share of the best
score are kept plus the top few, +/-1 line of context and the enclosing block header. Long lines are
never shortened (no token-level pruning). Limits (card): English and source code only; **requires a
query**; drops later multi-hop evidence that shares no words with the query.

## 4. Runtime
Local only, no network, no GPU. Pure Go, no dependencies, model embedded. ~24-39 MB RSS; ~1 ms at 700
tokens, ~63 ms at 60k tokens (card). Install: `go install github.com/caveman-ai/trim-1/cmd/trim@latest`
(needs Go >= 1.23). **No official Node path** (no npm package, ONNX, or HTTP server). Windows is not
mentioned; pure Go should cross-compile (unverified). No paid API.

## 5. Interface
`trim --query "<text>" [--point conservative|balanced|aggressive] [file]` (flags before the filename), or
context on stdin. stdout = trimmed context with a marker where lines were removed, kept lines in original
order; stderr = one summary line; exit 2 on missing query / unknown point. Floors: conservative 0.0035,
balanced 0.008 (default), aggressive 0.035. **No ratio/token-budget knob and no "keep these lines" knob.**
It *fails closed* (returns input unchanged) if: query blank; input < 2,000 bytes, > 8 MiB or > 200k lines;
input already contains a removal marker; or the cut would be < 10% of bytes. Self-reported benchmarks
(single run, unverified): ~2% cut on agent tool output, 21.8% on code, 88.9% on long multi-hop QA.

## 6. Integration decision (WS4)
Not a blocker: licence is fine, runtime is local, no paid dependency. The only gap is the missing Node
path, which is closed by an honest, optional **shell-out** (`Trim1Trimmer` spawns a locally-installed
`trim` binary through `runProcess`; located via `trim.binaryPath` config or PATH). We do **not** port the
model to TypeScript and we do **not** vendor the binary. When the binary is absent, `NoopTrimmer` runs and
`trim_skipped` is logged -- no fake integration, no silent pretence. `budgetTokens` is honoured by
stepping `--point` conservative -> balanced -> aggressive until the estimate fits; `keep` is honoured by
the caller never sending protected segments to the binary at all (see `src/trim/`).

Closest alternatives if trim-1 is later unsuitable (from the same verification pass):
LLMLingua-2 (MIT / Apache-2.0 weights; token-level, Python + torch, not query-conditioned, no Node path);
Selective Context (**no licence** -- do not use). A hand-rolled BM25 line filter in TS is an unverified
fallback idea only.

## 7. Integration status (as built in WS4) and observed behaviour

Built from source into a scratch directory with `go install github.com/caveman-ai/trim-1/cmd/trim@latest`
(Go 1.26.3, Windows; module `v0.1.0`; a 4.6 MB `trim.exe`; **nothing is installed into this repository**).
Everything below was observed by running it, not read from the card:

- **CLI contract confirmed.** `trim --query "<ask>" [--point conservative|balanced|aggressive]`, context on stdin.
  stdout = kept lines in original order with one `… N lines …` marker per removed run; stderr = one summary
  line, either `trim: kept K lines, removed R, A -> B bytes` or `trim: unchanged (<reason>)`. A blank query
  prints usage. Reasons seen: `cut below the minimum`, `context below the minimum size`.
- **It fails closed often.** On a 158-line varied document, `conservative` and `balanced` returned the input
  unchanged ("cut below the minimum"); only `aggressive` cut (137 of 158 lines, 11,915 -> 1,751 bytes), and it
  kept the `ERROR:` and `FAIL` lines. On a uniform log it cut nothing at any point. On a document where every
  line contains the query's words it cut nothing. So trim-1 helps most on long, heterogeneous text, and the
  query must discriminate. This is why the wrapper steps the operating point up until the budget is met and
  reports `metBudget` honestly.
- **No keep-lines knob** (confirmed), so `src/trim/trim1.ts` re-inserts every protected line the engine
  dropped (`restoreProtectedLines`, patterns in `src/trim/protected.ts`). That guarantee is the wrapper's,
  and is tested with both a fake engine and (opt-in) the real binary.
- **Availability probe.** `resolveTrimmer` runs `trim --query probe` on a one-line input and requires exit 0 and
  a `trim:`-prefixed stderr line, so an unrelated executable named `trim` is never mistaken for it. If absent,
  `NoopTrimmer` is used and `trim_skipped` carries the install hint. `trim.binaryPath` overrides PATH lookup.
- **Where it runs (WS4.2):** research report -> spec input; each phase's output -> the next phase's
  `executor-context.md` (step 14). **Where it never runs (WS4.3):** the locked PRD, the spec, acceptance
  criteria, `context.md` -- `NEVER_TRIM_LABELS` makes marking them trimmable an `InternalError`, and
  protected parts are never even shown to the engine.
- **Not done, deliberately:** no TypeScript port of the model, no bundled binary, no auto-install. Reviewer
  diffs are not trimmed (a reviewer must see the real diff).
- **Opt-in live test:** `TRIM1_BIN=/path/to/trim node --test src/trim/trim.test.ts` runs the real-binary case.
