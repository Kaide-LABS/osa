# modernization_log.md

Canonical pinned versions and provider-CLI facts for OSA. Mirrored from
`OSA-PRD.md` (Step 10 pass). If this file and the PRD ever disagree, **the PRD wins** --
this is a convenience index, not a second source of truth.

**Last pass:** 2026-09-07 (Step 10, Phase 11 Antigravity-CLI-provider pass; **§9 is new**, §1 and §3
gained an Antigravity row/column, and all three provider CLIs were re-probed on this machine).
**Prior passes:** 2026-08-16 (initial), 2026-08-18 (Phase 6 driver), 2026-08-18 (Phase 7 role pinning),
2026-08-18 (Phase 8 MCP server), 2026-08-18 (Phase 9 installer bundling; §7 new, §3 corrected),
2026-09-06 (Phase 10 persistent chat log; §8 new, no provider-CLI fact re-probed).
**Verification key:** `LOCAL` = executed on this machine · `DOC` = vendor official docs ·
`REGISTRY` = `npm view <pkg> version` · `UNVERIFIED` = no primary source found.

---

## 1. Model strings

**None pinned, deliberately.** Per PRD §6.2, concrete provider model identifiers are never recorded on
role definitions or anywhere outside `src/adapters/**`. Boundary rule B7 makes a hardcoded model name a
build-failing violation (exit `9`).

Evidence for the decision: OpenAI's own two config doc pages carried different example model strings
within the same pass -- `gpt-5.6` (DOC https://learn.chatgpt.com/docs/config-file/config-basic) vs
`gpt-5.5` (DOC https://learn.chatgpt.com/docs/config-file/config-reference).

Tier is mapped to each provider's **stable effort enum** instead:

| Abstract `ModelTier` | Claude Code `--effort` | Codex `-c model_reasoning_effort` | Antigravity `--effort` (new, Phase 11) |
|---|---|---|---|
| `research-grade` | `high` | `high` | `high` |
| `verification-grade` | `high` | `high` | `high` |
| `high-volume-low-effort` | `low` | `low` | `low` |

Allowed value sets (do not invent values outside these):
- Claude Code `--effort`: `low`, `medium`, `high`, `xhigh`, `max` -- LOCAL, `claude --help` v2.1.211.
  The published CLI reference additionally lists `ultracode` (DOC https://code.claude.com/docs/en/cli-reference);
  treat any value absent from the installed binary's own help as unavailable.
- Codex `model_reasoning_effort`: `minimal`, `low`, `medium`, `high`, `xhigh` -- DOC
  https://learn.chatgpt.com/docs/config-file/config-reference
- Antigravity `--effort`: **exactly three values** -- `low`, `medium`, `high` -- LOCAL, `agy --help`
  v1.1.20 (`"Reasoning effort for the current CLI session (low|medium|high)"`). Narrower than either
  of the other two; `xhigh`/`max`/`minimal` do **not** exist for this provider and must never be
  emitted.

Antigravity model slugs observed via LOCAL `agy models` (v1.1.20), recorded **only** so boundary rule
B7's pattern can be extended to catch them outside `src/adapters/**` -- **not** as a pin, and never to
be written into source: `gemini-3.8-flash-{high,medium,low}`, `gemini-3.7-flash-{high,medium,low}`,
`gemini-3.6-flash-{high,medium,low}`, `gemini-3.1-pro-{high,low}`, `claude-sonnet-4-6`,
`claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. Note that `agy` serves two Anthropic slugs, already
matched by B7's existing `claude-(opus|sonnet|haiku|fable)` clause.

Model *selection* is delegated to each provider CLI's own configured default unless the operator
overrides it in the OSA run config.

## 2. Implementation toolchain (pinned)

| Element | Pin | Source |
|---|---|---|
| Node.js | `>=24.0.0` (Active LTS "Krypton") | LOCAL `node --version` -> `v24.15.0`; DOC https://nodejs.org/en/about/previous-releases |
| npm | `>=11` | LOCAL `npm --version` -> `11.12.1` |
| TypeScript | `7.0.2` (devDependency; `tsc --noEmit` only) | REGISTRY; LOCAL install + type-check pass |
| `@types/node` | `26.2.0` (devDependency) | REGISTRY |
| zod | `4.4.3` -- runtime dependency 1 of 2 (**was "the only runtime dependency" through Phase 7; corrected 2026-08-18, Phase 9 pass** -- this row was left stale when Phase 8 amended PRD §7 I1 and boundary rule B2) | REGISTRY; LOCAL `.strict()` parse + type-check pass |
| `@modelcontextprotocol/sdk` | `1.30.0` -- runtime dependency 2 of 2, added Phase 8 only, per the amended B2 (PRD §5.1). **No third runtime dependency is authorized**; Phase 9 adds none. | REGISTRY `registry.npmjs.org/@modelcontextprotocol/sdk/latest`, MIT, `engines.node >=18`; see PRD §8.7 |
| Test runner | Node built-in `node:test` (zero dependency) | LOCAL `node --test "src/**/*.test.ts"` -> exit 0 on a `.ts` file |
| Build step | **None** -- Node executes `.ts` directly via type stripping | LOCAL `node src/a.ts` -> correct output on v24.15.0 |
| git | `>=2.40` | LOCAL `git --version` -> `2.54.0.windows.1` |

Node EOL status: v20 EOL, v22 maintenance, v24 Active LTS (DOC, same nodejs.org page).

TypeScript 7.0.2 notes: released 2026-07-08 (RC 2026-06-18); Go-native compiler; `strict` on by default;
several previously-deprecated flags are now hard errors; programmatic API not stable until 7.1
(DOC https://www.infoq.com/news/2026/08/typescript-7-released/). OSA uses only the `tsc` CLI, has
no bundler/transpiler in its graph, and sets every relevant flag explicitly, so it does not rely on any
7.0 default.

**Required tsconfig flags** (any of these missing is a Phase 1 failure):
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedModules`,
`allowImportingTsExtensions`, `noEmit`. `package.json` must set `"type": "module"`, and relative imports
must carry an explicit `.ts` extension -- both verified LOCAL (omitting `"type": "module"` produced
`TS1295`/`TS1287` errors; omitting `allowImportingTsExtensions` breaks `.ts`-extension imports).

## 3. Provider CLI versions

| CLI | Installed here (LOCAL) | npm latest (REGISTRY, 2026-08-16) | Package |
|---|---|---|---|
| Claude Code | `2.1.211` (re-confirmed 2026-08-18) | `2.1.233` (`stable` tag: `2.1.224`) | `@anthropic-ai/claude-code` |
| Codex CLI | `codex-cli 0.147.0` -- **CORRECTED 2026-08-18**; was `0.128.0` on 2026-08-16, the operator updated it in the interim; **re-confirmed `0.147.0` 2026-09-07** | `0.147.0` | `@openai/codex` |
| Antigravity CLI (**new, Phase 11 pass 2026-09-07**) | `1.1.20` -- LOCAL `agy --version`; binary at `C:\Users\hp\AppData\Local\agy\bin\agy.exe` | `1.1.27` (2026-09-05) -- DOC (public web; GitHub MCP was down) https://github.com/google-antigravity/antigravity-cli/releases | **None -- not an npm package.** Go-compiled standalone binary installed via Google's own script (DOC https://antigravity.google/docs/cli/install/): `irm https://antigravity.google/cli/install.ps1 \| iex` (Windows PowerShell), `curl -fsSL https://antigravity.google/cli/install.sh \| bash` (macOS/Linux) |

`PROVIDER_VERSION_RANGES["antigravity-cli"]` is pinned to **`[1.1.20, 2.0.0)`**. The floor is derived,
not copied from what happens to be installed -- four separate releases each contribute a capability
this adapter depends on: `1.1.13` (the `GEMINI_API_KEY` headless mode), `1.1.15`
(`--input-format stream-json` stdin), `1.1.18` (print mode no longer reporting a dropped agent-state
stream as a clean success), `1.1.20` (print mode no longer treating benign tool errors and permission
denials as fatal). The floor is the highest of those. LOCAL `agy changelog` for the first three; DOC
(public web) releases page for the fourth.

Claude Code `2.1.211` and Codex `0.147.0` were both re-probed on 2026-09-07 and both remain inside
their existing ranges -- **no drift, no code change** (FM9 reporting a clean result is still FM9
working).

The Codex correction is FM9 doing its job rather than a defect: `0.147.0` remains inside
`PROVIDER_VERSION_RANGES`'s `[0.128.0, 1.0.0)` window (`src/verify/preflight.ts`, unchanged), so no code
change follows. Every `codex exec` fact in §4.2 below was verified against `0.128.0` and has **not** been
re-verified against `0.147.0`; treat §4.2 as `[UNVERIFIED]` for `0.147.0` specifically until a pass
re-probes the binary. The `-a`-rejection finding in particular is the exact hazard class FM9 models.

The gap between installed and latest is modelled as **FM9** in the PRD: flags verified on one version are
not guaranteed on another. Preflight records the observed `--version` and range-checks it. OSA
never auto-updates a provider CLI.

## 4. Provider CLI invocation facts (pinned)

### 4.1 Claude Code -- non-interactive

- `-p` / `--print` -- non-interactive. Exit `0` success, non-zero failure, `143` on SIGTERM.
  DOC https://code.claude.com/docs/en/headless
- `--output-format` -- `text` | `json` | `stream-json`. `json` payload includes `result`, `session_id`,
  `total_cost_usd`; with `--json-schema`, also `structured_output`. DOC same.
- `--permission-mode` -- LOCAL help (v2.1.211) lists `acceptEdits`, `auto`, `bypassPermissions`,
  `manual`, `dontAsk`, `plan`; the CLI reference also lists `default`.
  DOC https://code.claude.com/docs/en/cli-reference
- `--allowedTools` / `--disallowedTools` -- permission-rule syntax, e.g. `Bash(git diff *)`. Note the
  space before `*` is significant. DOC headless page.
- `--append-system-prompt`, `--append-system-prompt-file`, `--system-prompt`, `--system-prompt-file` --
  role-profile injection. LOCAL help + DOC cli-reference.
- `--session-id <uuid>`, `--resume <id>`, `--continue` -- session continuity. LOCAL help.
- `--setting-sources`, `--strict-mcp-config` -- startup-context determinism without `--bare`.
- Piped stdin capped at **10MB**. DOC headless page.
- Auth probe: `claude auth status` -> exit `0`, stdout JSON with `loggedIn`, `authMethod`,
  `apiProvider`, `subscriptionType`. LOCAL (observed `authMethod: "claude.ai"`,
  `subscriptionType: "max"`).
- **`--bare` is BANNED in V1** (PRD FM8). It is the vendor-recommended scripting mode but it never reads
  OAuth credentials or the system keychain and requires `ANTHROPIC_API_KEY`, which would silently change
  the BYOA credential model. DOC https://code.claude.com/docs/en/headless
- Commit attribution: `settings.json` key `attribution: { commit: "", pr: "" }`.
  DOC https://code.claude.com/docs/en/settings

### 4.2 Codex CLI -- non-interactive

- `codex exec [PROMPT]` -- non-interactive. Prompt may be the argument, `-`, or piped stdin.
  LOCAL `codex exec --help` v0.128.0.
- **`codex exec` accepts NO `-a` / `--ask-for-approval` flag.** LOCAL: `codex exec -a never --help` ->
  `error: unexpected argument '-a' found`. `-a` exists only on the top-level interactive `codex` command.
  Set the policy via `-c approval_policy="never"` if it must be set explicitly. **Adapters must never
  emit `-a` for `exec`.**
- Defaults in `exec`: `approval_policy = "never"` and a **read-only** sandbox. A writing turn must pass
  `--sandbox workspace-write` explicitly. DOC https://learn.chatgpt.com/docs/non-interactive-mode
- `--full-auto` is **deprecated**; use `--sandbox workspace-write`. DOC same.
- `-s` / `--sandbox` -- `read-only` | `workspace-write` | `danger-full-access`. LOCAL help + DOC.
- `--json` -- JSONL event stream on stdout. Event types: `thread.started`, `turn.started`,
  `turn.completed`, `turn.failed`, `item.*`, `error`. `turn.completed` carries a `usage` object. DOC
  non-interactive page.
- `-o` / `--output-last-message <FILE>` -- writes the final agent message to a file. LOCAL help + DOC.
- `--output-schema <FILE>` -- structured final response. **Not relied upon by OSA** (PRD FM5):
  openai/codex#15451 reports `--json` and `--output-schema` being silently ignored when tools/MCP servers
  are active, producing malformed output (reported against 0.116.0; issue closed).
  https://github.com/openai/codex/issues/15451
- `-C` / `--cd <DIR>`, `--add-dir`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`,
  `--ignore-rules` -- LOCAL help.
- `codex exec resume [SESSION_ID|--last] [PROMPT]` -- session continuity. LOCAL `codex exec resume --help`.
- Config keys (DOC https://learn.chatgpt.com/docs/config-file/config-reference):
  - `approval_policy` = `untrusted` | `on-request` | `never` | `{ granular = {...} }`
  - `sandbox_mode` = `read-only` | `workspace-write` | `danger-full-access`
  - `model` = string
  - `model_reasoning_effort` = `minimal` | `low` | `medium` | `high` | `xhigh`
- Auth probe: `codex login status` -> exit `1` + `Not logged in` when unauthenticated. LOCAL (this
  machine is currently unauthenticated for Codex). The **authenticated** stdout shape is **UNVERIFIED**;
  the preflight predicate therefore keys on exit code only.
- CI/BYOA env alternative: `CODEX_API_KEY`. DOC https://learn.chatgpt.com/docs/non-interactive-mode
- Commit attribution: a `commit_attribution` config key is claimed by third-party blogs but is
  **UNVERIFIED** -- absent from the official config reference (that page was searched for "commit",
  "attribution", "co-author"). OSA enforces neutral commits with its own deterministic git check
  instead.

## 5. Deterministic verification primitives (pinned behaviour)

- `git merge-base --is-ancestor <A> <B>` -> exit `0` ancestor, `1` not ancestor, `128` bad object.
  LOCAL (the `128` path was observed against this repo's empty history).
- `fs.open(path, "wx")` -- atomic exclusive create; the FM6 lock primitive. No check-then-act race.
- SHA-256 over file bytes -- the AC3 artifact-attestation primitive (`node:crypto`, zero dependency).

## 6. Capabilities skipped in this pass

- **GitHub MCP (read-only dependency-source verification): SKIPPED.** No GitHub MCP server is present in
  this environment's tool registry (`ToolSearch` for GitHub repository/file-content tools returned only
  arXiv/paper-search/notebook tools). Substituted: direct execution of the installed provider CLIs
  (`--help`, `--version`, auth probes, a rejected-flag probe) and `npm view` against the registry. This
  substitution is *stronger* than GitHub source-reading for the specific facts pinned above, because the
  installed binary is the artifact that will actually run -- but it is weaker for any claim about
  upstream source not exercised by a local probe, and no such claim is made here.
- **paper-search MCP `search_google_scholar`: returned empty** for every query attempted; treated as
  unavailable rather than as a null finding.


## 7. MCP server registration surface (pinned, Phase 9 pass 2026-08-18)

Dual-verified: executed against the installed Claude Code `2.1.211` **and** checked against
DOC https://code.claude.com/docs/en/mcp-quickstart . PRD §8.8.1 carries the per-fact citations.

### 7.1 `claude mcp` commands

- `claude mcp add [options] <name> <commandOrUrl> [args...]` -- everything after a `--` separator is the
  command Claude Code runs to start the server. LOCAL `claude mcp add --help` + DOC.
- `-s, --scope <scope>` = `local` | `user` | `project`. **Default `local`.** LOCAL + DOC.
- `-t, --transport <transport>` = `stdio` | `sse` | `http`. **Defaults to `stdio`**; omit it for a local
  server. LOCAL + DOC.
- Other `add` flags, all of which OSA **must never emit** (boundary B3/B4/B5): `--header`,
  `--client-id`, `--client-secret`, `--callback-port`, `-e/--env`. LOCAL `claude mcp add --help`.
- `claude mcp get <name>` -- exit `0` if a server of that name is configured **in any scope and
  regardless of whether it works**; exit `1` if no such server exists. LOCAL (probed against four real
  servers, one deliberately-absent name, and one registered-but-broken server).
- `claude mcp list` -- exit `0`; **health-checks every configured server, including remote ones.** Slow.
  Prefer `get` for a targeted probe. LOCAL.
- `claude mcp remove <name> [-s <scope>]` -- exit `0` on success, `1` when absent from that scope. LOCAL.
- Duplicate name at the same scope: `add` exits **`1`** with `MCP server <name> already exists in
  <scope> config`. LOCAL + DOC ("Server already exists" troubleshooting entry).
- Startup timeout default **30 seconds**, override via `MCP_TIMEOUT` (milliseconds). DOC.
- `claude mcp login` / `logout` are the OAuth entry points for **remote** servers. **Never invoked by
  OSA** (boundary B5). LOCAL `claude mcp --help`.

### 7.2 Scope -> storage, and the case-sensitivity landmine

| Scope | File | Available to |
|---|---|---|
| `local` (default) | `~/.claude.json`, under the entry for **this project path** | Only you, only this project |
| `project` | `.mcp.json` in the project root | Everyone who clones the project |
| `user` | `~/.claude.json`, under the **top-level `mcpServers` key** | Only you, all projects |

DOC, "Find your configuration on disk". On Windows `~/.claude.json` is `%USERPROFILE%\.claude.json`;
`CLAUDE_CONFIG_DIR` relocates it. DOC.

**`local`-scope project keys are literal path strings and are case-sensitive even where the filesystem
is not.** LOCAL: this machine's `~/.claude.json` holds **seven** key pairs differing only by drive-letter
case, including both `"C:/Users/hp/OSA"` and `"c:/Users/hp/OSA"`, each with its own
`mcpServers` object (`ConvertFrom-Json` on the file fails with `DuplicateKeysInJsonString`).
**OSA's setup command therefore always passes `-s user`** -- structurally immune, since a
`user`-scope entry is not keyed by a project path at all (LOCAL: a `user` add's `File modified:` line
carries no `[project: ...]` suffix). This is also the vendor's own prescribed fix ("add it with
`--scope user` so it isn't tied to a project", DOC) and the upstream `arxiv-mcp-server` project's own
documented registration command. PRD §9 FM11.

### 7.3 Two behaviours a naive implementation gets wrong

- **`claude mcp add` does not check that the recorded command can run.** Registering a nonexistent
  binary exits `0` with the ordinary `Added stdio MCP server ...` confirmation. LOCAL + DOC, verbatim:
  *"The `Added` confirmation means the entry was saved, not that the command runs."* Always follow a
  registration with an independent `claude mcp get` assertion. PRD §9 FM10.
- **Never parse the status glyph.** `✔`/`✘` degrade to `√`/`×` on legacy Windows consoles. DOC. Key
  every predicate on the exit code, as `parseCodexAuthResult` already does for the same reason.

### 7.4 The two bundled research servers (environment facts, NOT OSA dependencies)

OSA never imports, links, installs, or calls these. They are separate processes the operator's
own agent runs. Recorded here so an observed third-party version is never mistaken for a pin --
`package.json`'s `dependencies` stays exactly `zod` + `@modelcontextprotocol/sdk` (boundary B2).

| PyPI package | Latest (REGISTRY 2026-08-18) | License | Requires-Python | Installed here (LOCAL) | Module form | Console script |
|---|---|---|---|---|---|---|
| `arxiv-mcp-server` | `0.6.3` (2026-08-14) | Apache-2.0 | `>=3.11` | `0.4.11` | `arxiv_mcp_server` | declared, **not on PATH here** |
| `paper-search-mcp` | `0.1.4` (2026-07-02) | MIT | `>=3.10` | `0.1.3` | `paper_search_mcp.server` | **none declared** |

REGISTRY `pypi.org/pypi/<pkg>/json`. LOCAL `py -m pip show`, `importlib.metadata`, Python `3.14.4`.

**Invocation, corrected.** Upstream documents `uvx arxiv-mcp-server` and `uvx paper-search-mcp` as the
current registration commands (DOC, each project's own README); `arxiv-mcp-server` documents **no**
module-form invocation at all. `py` is the **Windows-only** launcher (LOCAL `where py` ->
`C:\Windows\py.exe`), and `uv`/`uvx` is **not installed on this machine** (LOCAL) -- which is why this
operator's own config uses the module form. OSA resolves the launcher deterministically per
machine (`uvx` -> a Python interpreter that can import the module -> skip by name with remediation)
rather than hardcoding either. PRD §8.8.3, `PHASE_9_SPEC.md` §6.4.

**Registered server names are fixed**: `OSA`, `arxiv-mcp`, `paper-search-mcp`. The PRD's own
§8.5/§8.6/§8.7 cite `mcp__arxiv-mcp__*` / `mcp__paper-search-mcp__*` tool identifiers, which derive from
these names; changing them would silently invalidate this project's documented Step 10 procedure.

### 7.5 Codex CLI's own MCP surface -- recorded, deliberately unused

`codex mcp {list,get,add,remove,login,logout}` exists on `codex-cli 0.147.0` (LOCAL `codex mcp --help`),
and upstream documents `codex mcp add arxiv -- uvx arxiv-mcp-server` (DOC). Confirmed scope edge 5 defers
every vendor mechanism other than Claude Code's. Recorded so a later feature need not rediscover it.


## 8. Durable append-only logging + the ignore mechanism (pinned, Phase 10 pass 2026-09-06)

Everything here was either read from the current vendor docs or **executed on this machine during
the Phase 10 pass**. PRD §8.9 carries the per-fact citations and the full capability account.
**Nothing else in this file changed this pass**, and no provider-CLI fact was re-probed -- §3's
existing `[UNVERIFIED]`-for-`0.147.0` caveat on the §4.2 `codex exec` facts still stands.

### 8.1 The append primitive (no dependency; boundary B2 unchanged)

- `fsPromises.appendFile(path, data[, options])` -- `options.encoding` **Default `'utf8'`**;
  `options.flag` **Default `'a'`**; "Asynchronously append data to a file, creating the file if it
  does not yet exist." DOC
  https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesappendfilepath-data-options
- **No logging, serialisation, rotation, or file-locking library is added, needed, or authorized.**
  `dependencies` stays exactly `zod@4.4.3` + `@modelcontextprotocol/sdk@1.30.0` (boundary B2). A
  `package.json` diff in a Phase 10 review is a defect signal. If an implementation believes it needs
  a third dependency, that is HALT-and-escalate, not a silent addition. PRD §5.1 Phase 10 note.
- **The reference implementation is this project's own, not an external one.** `appendDriverLog()`
  (`src/dispatch/driver-loop.ts`, Phase 6, shipped): `mkdir(dirname, { recursive: true })` then
  `appendFile(path, JSON.stringify(entry) + "\n", "utf8")`, one JSON object per line, written as the
  loop proceeds, sole-writer because the loop is strictly sequential. LOCAL, direct read 2026-09-06.

### 8.2 Crash consistency, measured

| Probe | Setup | Result |
|---|---|---|
| Small entries | Node v24 child `await appendFile(...)` one JSON object per line, parent sends `SIGKILL` mid-loop | **11 lines present, 11/11 parsed as valid JSON**, no torn/partial line |
| Large entries | Same, 5 MB payload per line | file = 10,000,034 bytes, **2 complete lines, 0 torn** |

LOCAL, 2026-09-06. This is durability against **process death** -- an already-awaited append's bytes
are in the OS page cache before the next append begins.

**Bound on the claim, stated rather than glossed:** this is **not** durability against OS crash or
power loss. Neither `appendFile` nor OSA calls `fsync`, and the Node docs make no flush
guarantee for `appendFile`. An `fsync` per turn would buy nothing against the failure this feature
actually models (a killed run), so it is deliberately not done. The format's contract is therefore:
**every line except possibly a final partial line is a complete JSON object** -- a reader must
tolerate one truncated final line.

### 8.3 Gitignore-by-default with a working override

A **directory-local `.gitignore` whose sole content is `*`** ignores that directory's entire contents
**including the `.gitignore` file itself**. No root-`.gitignore` edit, no `!.gitignore` negation, and
no effect on any path outside that directory.

Verified against real `git 2.54.0.windows.1`, LOCAL 2026-09-06, with the log at
`.osa/chat-log/` and the ignore file at `.osa/chat-log/.gitignore`:

| Command | Observed |
|---|---|
| `git status --porcelain -uall` | neither the `.jsonl` log nor the `.gitignore` appears |
| `git check-ignore -v .osa/chat-log/abc.jsonl` | exit `0`, `.osa/chat-log/.gitignore:2:*` |
| `git check-ignore -v .osa/chat-log/.gitignore` | exit `0` (it ignores itself) |
| `git add -A` then `git ls-files` | nothing from that directory staged |
| delete the `.gitignore`, re-run `git status --porcelain -uall` | `?? .osa/chat-log/abc.jsonl` -- immediately trackable |

**Why the log gets its own directory rather than living under `.osa/runs/<id>/`:** an ignore
file placed in `runs/<id>/` would newly ignore that run's `HandoffRecord` files too. That is a
behaviour change to a shipped feature and is not Phase 10's to make. PRD §8.9.4.

**The override** is `chat_log_gitignored: false` on `RunConfig`/`DriveConfig` (default `true`), which
makes OSA remove the managed ignore file instead of writing it. `PHASE_10_SPEC.md` §3/§6.

### 8.4 Credential-shaped-content detection (advisory, never altering)

- Pattern **reused, not reinvented**: `/(sk-|ghp_|xoxb-)[A-Za-z0-9_-]+/`, already present in
  `src/cli/doctor.ts` and `src/adapters/conformance.ts`. LOCAL, direct read.
- In the chat log it is used **only** to set a boolean flag on an entry and raise a run-level
  `warnings` line. It **never** redacts, masks, elides, or truncates -- confirmed scope edge 1 and
  PRD §7 I7 forbid altering captured content.
- It recognises three token shapes and **will miss others**. It is explicitly advisory and explicitly
  **not** a safety guarantee; the ignore-by-default in §8.3 is the control actually relied upon.
  PRD §9 FM17.

### 8.5 Two pre-existing caps that Phase 10 must NOT touch

Recorded here because "verbatim, never truncated" reads, wrongly, as licence to widen them:

| Constant | File | Value | Status |
|---|---|---|---|
| `DEFAULT_MAX_OUTPUT_BYTES` | `src/util/exec.ts` (Phase 1) | `10_000_000` bytes, per stream, self-marking | **unchanged; not to be raised** |
| `DIFF_CAP_CHARS` | `src/dispatch/prompt.ts` (Phase 3) | `20_000` chars, self-marking | **unchanged; not to be raised** |

Both already insert their own in-band `...truncated...` marker, so a reader of the chat log can see a
cap was hit -- and that marker is itself part of the real bytes and is recorded verbatim. Raising
either changes what a provider is actually sent and how much memory a run holds: a change to run
behaviour disguised as a logging improvement. PRD §7 I7, §9 FM18.

### 8.6 Capability outages observed in this pass

- **arXiv MCP (`mcp__arxiv-mcp__search_papers`): BROKEN.** Two attempts, two queries, both
  `SSLCertVerificationError ... self-signed certificate in certificate chain` against
  `export.arxiv.org` -- a TLS-interception/trust-store condition on this machine, not an empty result
  set. New this pass; the same tool worked on 2026-08-16 and 2026-08-18.
- **paper-search MCP `search_arxiv`: BROKEN.** Two attempts, both `ProxyError(... RemoteDisconnected)`
  against `127.0.0.1:18765`.
- **paper-search MCP `search_google_scholar`: empty**, as in every prior pass (§6).
- **GitHub MCP: unusable, sixth consecutive pass.** Configured this time but reporting
  `CONNECTION_CLOSED` with no tools exposed, rather than being absent from the registry as in passes
  1-5. Its narrow role here (confirming Node `fs` append semantics) was instead served **more
  strongly** by running the real thing on the real runtime (§8.2).

## 9. Antigravity CLI invocation facts (pinned, Phase 11 pass 2026-09-07)

Everything in this section marked LOCAL was produced by executing the real `agy` binary
(v`1.1.20`) on this machine on 2026-09-07. Per Â§1's standing rule, **a value absent from the installed
binary's own help is treated as unavailable**, and this section outranks any vendor document that
disagrees with it.

### 9.1 The complete flag surface (LOCAL, `agy --help`)

```
--add-dir                       Add a directory to the workspace (repeatable) (default [])
--agent                         Agent for the current CLI session
-c                              Short alias for --continue
--continue                      Continue the most recent conversation
--conversation                  Resume a previous conversation by ID
--dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
--disable-slash-commands        Disable slash command and skill expansion in print mode
--effort                        Reasoning effort for the current CLI session (low|medium|high)
-i                              Short alias for --prompt-interactive
--input-format                  Input format for print mode (text, stream-json). stream-json reads one NDJSON message per line from stdin and runs a turn for each; it requires --output-format stream-json (default text)
--json-schema                   Optional JSON schema string or path to a schema file to enforce structured output (for stream-json, only applicable to the final result)
--log-file                      Override CLI log file path
--mode                          Set the agent execution mode for this session (accept-edits, plan)
--model                         Model for the current CLI session
--new-project                   Create a new project for this session
--output-format                 Output format for print mode (text, json, stream-json) (default text)
-p                              Short alias for --print
--print                         Run a single prompt non-interactively and print the response
--print-timeout                 Timeout for print mode wait (default 5m0s)
--project                       Project ID or project name for the current CLI session
--prompt                        Alias for --print
--prompt-interactive            Run an initial prompt interactively and continue the session
--sandbox                       Run in a sandbox with terminal restrictions enabled
```

Subcommands (LOCAL): `agent`, `agents`, `changelog`, `help`, `install`, `mcp`, `mic-serve`, `models`,
`plugin`, `plugins`, `remote-control`, `update`.

**Four absences that are load-bearing, and are absences rather than omissions from this table:**
- **No system-prompt flag of any kind.** No `--system-prompt`, no `--append-system-prompt`. Role-profile
  injection for Antigravity is therefore done by composing the profile into the prompt payload --
  exactly the treatment Codex CLI already gets (PRD Â§4).
- **No working-directory flag.** No `-C`/`--cwd` equivalent (`--add-dir` adds to the workspace;
  `--project` selects a project). The child's `cwd` is the only mechanism, which is what
  `Invocation.cwd` already supplies.
- **No auth/login/logout/status subcommand.** Credential state cannot be probed by shelling out; see Â§9.4.
- **No `--allowed-tools` equivalent.** Tool access is all-or-nothing via `--dangerously-skip-permissions`.

### 9.2 The headless invocation contract OSA uses

`--print`/`-p` is print mode. There is no `--headless` flag. OSA drives the **NDJSON-stdin /
`stream-json`-stdout** pair, not the argv-prompt path:

| Element | Value | Source |
|---|---|---|
| Input | `--input-format stream-json`; one NDJSON message per line on stdin; **requires** `--output-format stream-json` | LOCAL `agy --help` (quoted above) |
| stdin message shape | `{ "event": "user", "message": { "content": "<prompt>" } }` (a `content` block-array form is also documented) | DOC https://antigravity.google/docs/cli/headless/ |
| Output | `--output-format stream-json` -> NDJSON events: `init` (once at stream start), `step_update` (per step transition / text delta), `result` (once, at the end) | DOC, same page |
| `--output-format json` envelope (the alternative, **not** used) | `conversation_id`, `status`, `response`, `error`, `duration_seconds`, `num_turns`, `structured_output`, `json_schema`, `usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}` | DOC, same page |
| `status` vocabulary | `SUCCESS`, `ERROR`, `CANCELED`, `INTERRUPTED`, `INVALID`, `WAITING`, `RUNNING` | DOC, same page |
| Exit codes | `0` on success, non-zero on failure -- but **the `status` field is the more specific signal**; a run ending `WAITING` on an approval is not a run that failed | DOC, same page |

**Why not the argv-prompt path.** `agy` takes its prompt as the *value* of `--print`/`-p`, and
`1.1.18` made both a valueless prompt flag and a stray trailing argument hard errors (LOCAL
`agy changelog`). An OSA reviewer prompt carries this build's own Step 12 prompt text plus a
diff capped at `DIFF_CAP_CHARS = 20_000`, which comfortably exceeds Windows' ~32,767-character
command-line limit. Keeping the prompt on stdin also keeps `Invocation.stdin` the single prompt
channel across all three providers. See PRD Â§9 FM24.

**[UNVERIFIED-P11] -- the one open item, and it is a blocking acceptance gate, not an assumption.**
Whether `--print` is accepted with **no value** when `--input-format stream-json` is set (the shape
`1.1.15` added the stdin path for) was **not** confirmed against the real binary: the live smoke test
was attempted and refused by the Step 10 session's own permission classifier. `PHASE_11_SPEC.md` Â§8
AC-A5 makes an executed non-TTY smoke test a blocking acceptance criterion, and Â§7 specifies a
HALT-and-escalate path if the shape is rejected -- because the only fallback (argv) is closed by the
length wall above.

### 9.3 Flags OSA emits, and flags it must never emit

**Always emitted, unconditionally in every branch** (never gated behind an `if`, matching the FM7/FM8
precedent set for the other two adapters):
- `--print`, `--input-format stream-json`, `--output-format stream-json`
- `--dangerously-skip-permissions` -- the analogue of `claude --permission-mode bypassPermissions` and
  `codex -c approval_policy="never"`. Without it a headless turn can end `WAITING` on an approval.
- `--disable-slash-commands` -- OSA's prompts embed loopr Step 11/12 prompt text containing
  literal `/arxiv`, `/paper-search`, `/loop` strings, and `agy` expands slash commands in print mode
  (LOCAL `agy --help`; `1.1.11`/`1.1.12` changelog entries document print-mode slash-command answers
  and refusals). PRD Â§9 FM24a.
- `--effort <low|medium|high>` from the abstract tier (Â§1).
- `--print-timeout ${req.timeoutMs}ms` -- **derived from `req.timeoutMs`, never omitted.** `agy`'s own
  default is `5m0s` while `RunConfig.turn_timeout_ms` defaults to 30 minutes; omitting it lets the
  provider's internal bound silently truncate a turn *inside* the provider, so
  `RawInvocationResult.timedOut` stays `false` and the failure is misattributed. PRD Â§9 FM23.

**Emitted only when the operator supplied it:** `--model <slug>` from `req.modelOverride`.

**Never emitted, under any `TurnRequest` value:**
- `-c`, `--continue`, `--conversation` -- every turn is a fresh conversation. Carrying `agy`'s own
  conversation state across turns smuggles raw transcript context past Â§6.4's isolation rule through a
  channel no relay check can see. **Note the trap:** in `agy`, `-c` is a short alias for `--continue`;
  in `codex exec`, `-c` is a config override. A copy-paste from `codex-cli.ts` lands `-c` in the `agy`
  argv and silently enables continuation. PRD Â§9 FM22.
- `--sandbox` -- a boolean here (unlike Codex's `--sandbox <mode>`), documented as "terminal
  restrictions". An executor turn must be able to run `git`; restricting the terminal would break the
  commit history AC1's continuity check reads. Tool access is already granted deliberately and
  explicitly by `--dangerously-skip-permissions`.
- `-i`, `--prompt-interactive` -- an interactive session in the run path.
- `--new-project`, `--project`, `--add-dir`, `--agent`, `--mode`, `--json-schema`, `--log-file`,
  `--input-format text` -- none is needed and each is a behaviour OSA has not specified.

### 9.4 Auth: observed, never established (boundary rule B6)

`agy` has **no** auth/login/status subcommand, so credential state cannot be probed by shelling out
the way `claude auth status` and `codex login status` are (LOCAL, subcommand list in Â§9.1). It is
observed from configuration instead, and only the headless mode counts:

| Condition | Probe verdict |
|---|---|
| `~/.gemini/antigravity-cli/settings.json` parses **and** contains `"modelProvider": "gemini"`, **and** `GEMINI_API_KEY` is a non-empty environment value | `"authenticated"` |
| The settings file parses and `modelProvider` is present but is **not** `"gemini"`, **or** `modelProvider` is `"gemini"` and `GEMINI_API_KEY` is unset/empty | `"unauthenticated"` -- a definite claim, and an actionable one |
| The settings file is missing, unreadable, or unparseable, **or** it parses with **no** `modelProvider` key at all | `"indeterminate"` -- the operator may well be signed in via the system keyring, which OSA cannot observe without spending quota. **Not** "signed out." |

Both halves are genuinely required by the CLI: `GEMINI_API_KEY` alone has no effect, and
`modelProvider: "gemini"` without the key prevents startup (DOC
https://antigravity.google/docs/cli/install/). Added in `1.1.13` (LOCAL `agy changelog`):
*"Added support for `GEMINI_API_KEY`, so the CLI can run against the Gemini API directly without
signing in. Set `modelProvider: \"gemini\"` in `settings.json`, export `GEMINI_API_KEY`, and point
`GOOGLE_GEMINI_BASE_URL` at a custom endpoint if you need one."*

OSA **reads** these two values and **never writes either**: it never edits `settings.json`,
never sets an environment variable, never forwards the key into `Invocation.env`, never logs it, and
never places it in an error `details` payload. `agy` reads the key from the inherited environment
itself, which `Invocation.env`'s "additive overlay, never a full replacement" contract already
guarantees. Calling `generativelanguage.googleapis.com`, a Vertex endpoint, or any
`GOOGLE_GEMINI_BASE_URL` value directly is a B3/B4 violation. PRD Â§9 FM19.

**Observed on this machine, 2026-09-07 (LOCAL):** the local `settings.json` contains no
`modelProvider` key and `GEMINI_API_KEY` is unset -- i.e. this machine is **not** currently in headless
mode, and the probe correctly reports `"indeterminate"`. Configuring it is the operator's action.

### 9.5 Known defect class this adapter is built against

GitHub issue #76 (**closed**), *"`agy --print / -p` silently drops stdout when run with a non-TTY
(pipe, subprocess, redirect)"*, reported against `1.0.0` -- DOC (public web; GitHub MCP was down)
https://github.com/google-antigravity/antigravity-cli/issues/76 . OSA spawns every provider
with piped stdio and no TTY, so this is exactly the environment that triggered it. Two fixes address
the class and are both in the pinned floor:
- `1.1.18` (LOCAL `agy changelog`): *"Fixed print mode (`-p`) exiting successfully with an empty
  response when the agent state stream was dropped mid-run, which reported a failed turn as a clean
  success; it now surfaces the stream error and exits non-zero."*
- `1.1.20` (DOC, public web releases page): *"Fixed print mode (`-p`/`--print`, including
  `--output-format json` and `stream-json`) treating benign tool execution errors and permission
  denials as fatal run failures."*

Regardless, `AntigravityCliAdapter.interpretResult` treats **exit `0` with no parseable `result`
event** as a failure unconditionally. PRD Â§9 FM20.

### 9.6 Two drift observations worth recording

1. **The embedded changelog lags the binary.** `agy --version` reports `1.1.20`; `agy changelog` on the
   same binary begins at `1.1.19` (LOCAL). The `1.1.20` entry therefore comes from the public releases
   page and is marked DOC, not LOCAL.
2. **A documented flag does not exist on the pinned version.** `1.1.12`'s changelog says
   `--output-format` was added to the `models` and `agents` subcommands; on `1.1.20`,
   `agy models --output-format json` fails with `Error: flags provided but not defined: -output-format`
   and `agy models --help` lists only `-h`/`--help` (LOCAL). Fresh evidence for Â§1's rule that the
   installed binary's own help outranks any document, **including the vendor's own changelog**.
   OSA uses no `agy` subcommand for anything.
