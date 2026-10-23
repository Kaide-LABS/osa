# OSA -- Attribution and third-party notices

## Deep-Research-skills (MIT) -- pattern source for the spec-phase research

- Project: **Deep-Research-skills** -- <https://github.com/Weizhena/Deep-Research-skills>
- Licence: **MIT**, `Copyright (c) 2026 Lan Zheng` (verified from the repository's `LICENSE` file on 2026-10-17;
  default branch `master`).
- What OSA adapted (patterns and structure, re-implemented in TypeScript; no source file is vendored):
  - the two-file outline per run -- `outline.yaml` (topic, items, execution settings) and `fields.yaml`
    (field schema) -> `src/research/outline.ts`, `src/domain/research.ts`;
  - one web-search research agent per item, batched, each writing a JSON result file ->
    `src/research/agent.ts` (`results/<item_slug>.json`);
  - the `[uncertain]` marker plus an `uncertain` array per result, and the `validate_json.py` idea -- a result
    is complete only when every field in `fields.yaml` is covered -> `src/research/validate.ts` (ported from
    Python; OSA has no Python dependency);
  - resume by skipping items whose JSON already validates -> `runItem` in `agent.ts`;
  - the four search modules `general-web`, `github-debug`, `stackoverflow`, `academic-papers` ->
    `src/research/modules.ts` (the upstream `chinese-tech` module is not adopted);
  - a final `report.md` compiled from the JSONs -> `src/research/report.ts`.
- What OSA deliberately changed: every `AskUserQuestion` stop in the upstream skills (outline confirmation,
  time range, existing-fields question, batch size, approve-next-batch) is removed. Each becomes a field of the
  baby PRD's *Research plan* (or a config default) and is settled at the lock, so research runs unattended.
  Research runs on each provider's own built-in web search/fetch rather than a skill-host tool. A
  cross-provider check of the compiled report and a mandatory official-documentation requirement are OSA
  additions.

The MIT licence text, as published by the upstream project:

> MIT License
>
> Copyright (c) 2026 Lan Zheng
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without
> limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
> the Software, and to permit persons to whom the Software is furnished to do so, subject to the following
> conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial
> portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
> TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
> THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
> DEALINGS IN THE SOFTWARE.

## trim-1 (Apache-2.0) -- optional context trimmer (WS4)

- Project: **trim-1** -- <https://github.com/caveman-ai/trim-1>; weights at
  <https://huggingface.co/caveman-so/trim-1>. Licence of code and weights: **Apache-2.0** (a copy of Go's
  `math.Exp` embedded in its source is BSD-3-Clause). "Caveman" is the author's trademark.
- OSA does **not** vendor, bundle or redistribute it. It shells out to a `trim` binary the operator installed
  themselves (see `TRIM1_NOTES.md`); when absent, a no-op trimmer runs and the skip is logged.

## Public data sources (no keys bundled, no data redistributed)

- **arXiv API** -- <https://info.arxiv.org/help/api/> -- used within arXiv's usage guidance (one connection,
  at least 3 s between calls). arXiv content remains under each paper's own licence; OSA stores only metadata
  and abstracts in the run's research artifacts, with links.
- **OpenAlex** -- <https://openalex.org/> -- open scholarly metadata (CC0). Unauthenticated use shares a small
  free daily budget; an optional `OPENALEX_API_KEY` is read from the environment (see `.env.example`).
- **GitHub REST API** -- public repositories only; an optional `GITHUB_TOKEN` is read from the environment.
  Fetched READMEs/files are summarised, never copied into the build; repository licences are surfaced so
  nobody copies code under an incompatible licence.
- **Semantic Scholar Graph API** -- optional, off by default, requires the operator's own `S2_API_KEY`.
