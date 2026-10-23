# codebase-memory-mcp (CBM) — notes

Written on branch `osa/test-hardening`. CBM: https://github.com/DeusData/codebase-memory-mcp (MIT). **Pinned: v0.12.1**, released 2026-10-16.
Numbers in section 3 are from this machine (Windows 11, Node 24); the evaluation tables live in `archive/TEST_REPORT.md` (Suite 7).

## 1. The prior spike — what it found, and where the record is

The brief said the spike's raw logs were unavailable. They are partly available: `C:\Users\hp\cbm-spike\` holds `CBM_SPIKE_FINDINGS.md` (14 KB, 2026-08-18), the install log, the analysis scripts, a v0.10.7 install and the index it built. The findings, as recorded there, and how each held up when re-tested:

| # | Spike finding (v0.10.7, Aug 2026) | Re-tested on v0.12.1 |
|---|---|---|
| i | Default BM25 `search_graph` confidently returned the wrong file for a paraphrased query, with a real-looking score and nothing to signal it was wrong. The embedding path ranked the right function #31 of 50 with all scores in a 0.87–0.91 band. | **Confirmed.** Our eval measures it directly (CONFIDENT-WRONG column). Semantic scores still cluster (0.9648–0.9667 for five different functions). Guard design: `src/code-index/fusion.ts`. |
| ii | Spec artifacts (`PHASE_*_SPEC.md`, PRD, `COMPREHENSION.md`) were excluded through `.gitignore` matching. | **Confirmed and worse than recorded.** `.cbmignore` negation cannot override the repo `.gitignore` (docs/cbmignore.md, "Precedence"); `.osa/` is on CBM's built-in skip list; the graph index also ignores YAML, `.jsonl` and lock records. Fix: index a *shadow tree* OSA controls (section 4). |
| iii | Binary 296 MB. | 333,716,480 bytes (318 MiB) for 0.12.1; 296,140,288 for 0.10.7. Footprint note, not a blocker. |
| iv | Measured savings ~3.6× vs 10×/120× claimed. | Not re-measured on the spike's task; our own token-per-query and run-level numbers are in the report. |
| v | File exploration was 41–45% of context; an index delays compaction, cannot prevent it. | Re-measured on the current build with `token_breakdown` (report, Suite 7a). The spike counted **every** Bash call as exploration; OSA classifies each command by what it does. |
| vi | "Served stale content after edits" — UNVERIFIED. | Spike: `get_code_snippet` / `search_graph` served pre-edit content with no flag until `check_index_coverage` was called. See the stale-read verdict in the report. OSA never shows index content: snippets are read from the live file and every hit is checked against a hash manifest. |

## 2. Install, verification, pinning

- Asset: `codebase-memory-mcp-windows-amd64.zip` (48,508,123 bytes), SHA-256 `4e4e0f16b45233af5c757a1fcbe3c3b16e9056375b1fbe2ce020b6de75dedcc0`.
- Verified three ways: matches `checksums.txt` from the release; matches the digest GitHub records for the asset; `checksums.txt` itself verified with **cosign v2.6.5** against its sigstore bundle (`Verified OK`, signer identity = this repository's GitHub Actions workflow).
- Extracted by hand to `C:\osa-cbm\bin\`. **`install.ps1` / `cbm install` was never run**, so none of the 45 supported agent clients' MCP configs was touched and the user PATH was not changed. Checked afterwards: no `codebase-memory` entry in `~/.claude.json`, `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`; no CBM entry on the user PATH.
- OSA owns the launch: a fixed path from config, an argument array, no shell, through `src/util/exec.ts` (the only spawn wrapper; boundary rules B10–B12).

## 3. Things that are not in the README

1. **Refuses to run beside a writable ancestor.** CBM walks the ancestor chain of its directories and refuses any that grant write access to another principal. On this machine `C:\Users\hp` has an extra account (`Habeeb`, full control) and `C:\ProgramData` has `BUILTIN\Users`, so every command failed (`secure CLI coordination could not be created … DACL entry … untrusted identity`, or `could not load saved runtime settings`). Fix, with no change to the user's folders: a directory directly under `C:\` with a hardened ACL (current user, SYSTEM, Administrators only), `C:\osa-cbm\{bin,cache,run,shadow}`, plus `CBM_CACHE_DIR`, `CBM_RUNTIME_DIR` (the documented switch for exactly this) and `CBM_ALLOWED_ROOT`.
2. **Every `cbm cli <tool>` call costs ~11 s** (≈3.7 s process start + a temporary daemon). A persistent stdio session costs ~11 s once and then **~30 ms per tool call**. OSA holds one session per run.
3. **A daemon listens on `127.0.0.1:9749`** (the graph UI) whether or not `ui_enabled` is false, in both documented settings locations; it even ignored `ui_port: 1`. It is a loopback listener, not an outbound connection; OSA confines indexing with `CBM_ALLOWED_ROOT` and stops the session at run end. Reported as a risk.
4. **Re-index cost in a warm session** (369 files): first index 10.9 s; nothing changed 3.6 s; one file edited 5.3 s. So refresh at phase boundaries, never per query.
5. **Output formats.** Every tool accepts `format: "json"`; the default is a YAML-like tree. Semantic search returns no line ranges; `get_file_outline` maps a symbol to its range. A bare JSON key `semantic-query` is silently ignored (spike); the key is `semantic_query`.

## 4. How OSA uses it

`src/code-index/cbm/`: `session.ts` (stdio MCP session), `shadow.ts` (the shadow tree), `client.ts` (typed wrappers pinned to real payloads), `engine.ts` (the guarded engine). Shadow tree: the repo's tracked and unignored files **plus** every spec artifact (`src/code-index/spec-artifacts.ts`, derived from the path builders in the code), **minus** secrets (`.env*`, keys, certificates, credential stores) and every `.gitignore`/`.cbmignore`. It lives under `CBM_ALLOWED_ROOT`, outside the repository. Its manifest of file hashes is the freshness oracle.

Coverage of spec-artifact kinds by CBM channel, measured on a fixture with every kind (`runs/<id>/…`, `.osa/runs/…`, `.osa/memory`, `docs/osa`, root `PHASE_N_SPEC.md`): the text-search channel (`search_code`) found **14 of 15**; the graph channel (`search_graph`) found 9 of 15 and missed YAML, hidden directories and lock/evidence JSON; `.jsonl` was found by neither. OSA's lexical index (which now indexes all of them) completes the coverage, and the engine always includes it as a channel.

## 5. Outcome and where the numbers are

- **Verdict: ships behind `index.engine: "cbm"`, default OFF.** Best tuned configuration: confident-wrong 10.0 % (bar 2 %) with 65 % abstentions; about 2x fewer tokens than grep + read at a 10-15 point accuracy cost; on greenfield builds the run-level saving is about 0. Tables, the full tuning log, the stale-read verdict and the comparison with the spike are in `archive/TEST_REPORT.md`, Suite 7.
- **Stale-read verdict (spike finding vi):** true of CBM alone, neutralised by OSA's hash check (zero stale reads served; the stale file is reported and a re-index scheduled).
- **Shadow history:** since the architecture/change views were added, the shadow tree keeps its own private git history (one commit per refresh that changed something) so CBM's `detect_changes` has something to diff. It lives under the allowed root, never in the project.
- **Footprint and install:** v0.12.1, 333,716,480-byte binary, 10-13 MB idle working set, 4-18 MB index databases, private cache under `C:osa-cbm`; `install.ps1` / `cbm install` were never run.
- **To enable:** see `archive/TEST_REPORT.md` section 5, item 5.

