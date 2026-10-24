# OSA -- Directive vs. Code Conflicts and Judgement Calls

Per Ground Rule 0: on *facts* the code wins; each conflict records the reading chosen (closest to the
directive's intent). Per the run instructions, judgement calls are recorded here as assumptions and the
work continues without asking. Format: **ID -- what conflicts -- resolution -- (assumption tag)**.

## Conflicts (directive assumes something the code contradicts)

**C-01 -- "Network access."** WS3 requires HTTP clients for arXiv, OpenAlex and GitHub. Boundary rules
**B3** (no `node:http(s)`/`fetch`/`undici`/...) and **B4** (no `http(s)://` literal in `src/**`) encode
the original product invariant "OSA itself makes zero network calls".
*Resolution:* amend B3/B4 with a narrowly-scoped, named exemption: network code may live **only** under
`src/research/net/` and may use only global `fetch`; the exemption is a single path-prefix constant in
`boundary.ts` (greppable, tested), every other path keeps B3/B4 exactly as before, and `src/research/net/`
may still not import `node:http(s)/net/tls`, `undici`, `axios`, `got`, `node-fetch`. No new dependency.
*(risky -- changes a stated invariant; user explicitly authorised "two plain HTTP clients" in WS3.3.)*

**C-02 -- "Spec phase" and "step 14" are not in this codebase.** They are loopr Steps 10 and 14, Claude
Code subagents (`.claude/agents/loopr-step10.md`, `loopr-step14.md`) run by a human; `drive` only
dispatches Steps 11/12. There is nothing to "fix so it always runs".
*Resolution:* OSA gains its own first-class pipeline stages in code: `spec` (research + spec authoring)
before the first dispatch, and a `step14` post-phase hook the driver runs after **every** approved phase
(not skippable by config except `trim.enabled`, which only degrades to the no-op trimmer, never skips the
plain-language summary). Why it "did not run during the PAU hostel build" is answered in WS4: the harness
never invoked it -- it only ran if the human launched the subagent. *(safe)*

**C-03 -- "Config: read `osa.config.*`; fall back to the old config filename."** No project-level config
file ever existed under the old name; only per-run `--config <path>` JSON existed.
*Resolution:* new project config `osa.config.json` (JSON only -- no YAML/JS loader, because B2 forbids a
parser dependency); the old config filename is no longer read (the clean repository has no users of it);
`run`/`drive --config` are unchanged. *(safe)*

**C-04 -- `runs/<run-id>/...` and `research/...` paths.** The existing on-disk layout is
`.osa/runs/<id>/...`, and `.osa/` is untracked. But the harness hashes `artifacts_read`
at `head_before`, so the locked PRD, research and spec **must be committed** to be attestable.
*Resolution:* OSA writes its human-facing artifacts to a **tracked** top-level `runs/<run-id>/` in the
target repo (`baby-prd.md`, `research/outline.yaml`, `research/fields.yaml`, `research/results/*.json`,
`research/report.md`, `spec/...`, `summary.md`), committed before dispatch; machine bookkeeping stays in
`.osa/`. The directive's literal paths are honoured as relative to `runs/<run-id>/`. *(safe)*

**C-05 -- `validate_json.py` equivalent: "port to TS or keep Python if already a dep".** Python is not
a dependency of this repo. *Resolution:* ported to TS (`src/research/validate.ts`). *(safe)*

**C-06 -- `agents.lateralArchitectureProvider: "codex"`.** Provider ids in this code are `codex-cli`,
`claude-code`, `antigravity-cli`. *Resolution:* config accepts the short aliases `codex`, `claude`,
`antigravity` and normalises them; canonical ids are used internally. *(safe)*

**C-07 -- "the existing spec-discipline interrogation (six stopping conditions)."** That interrogation
is loopr's, outside this repo. *Resolution:* OSA's post-lock gap resolution is implemented as a spec-stage
rule: gaps found during spec authoring become logged `spec_assumption` entries and are never surfaced as
questions. The six loopr stopping conditions are not re-implemented. *(safe)*

**C-08 -- "Antigravity equivalent" of web search.** No verified headless web-search tool for `agy`
exists in its `--help`. *Resolution:* `antigravity-cli` is declared `webSearch: false` in the capability
table (overridable by config); research routes to a provider that has it and logs
`research_routed`. *(safe)*

## Judgement calls / assumptions

**A-01 -- Branching.** One branch per workstream, *stacked* (each cut from the previous), named
`osa/wsN-<slug>`; nothing is merged to `main`, pushed, or published. The tip branch contains everything.
*(safe)*

**A-02 -- Product name.** The binary, MCP server, help text, log prefixes and README all say OSA; the npm package
`name` is `osa` (manifest only, not published); the data directory is `.osa/` (runs, chat logs, memory, index). *(risky: package name.)*

**A-03 -- Embeddings (WS7).** No new dependency and no network: the default embedder is a local
deterministic feature-hashing TF-IDF vector over identifier-split tokens; a provider-embedding backend is
config-selectable but off by default. *(safe)*

**A-04 -- Index storage (WS7).** Flat JSON-lines file index in `.osa/index/` (portable on
Windows/macOS/Linux, no native/vector extension). *(safe)*

**A-05 -- Live provider verification.** The auto-mode permission classifier in this environment refused
to launch `agy ... --dangerously-skip-permissions`; no live `agy` turn was run. Antigravity findings are
therefore from `--help`, the git history of the adapter, and the unit contract, with a documented manual
smoke test. See `ANTIGRAVITY.md`. *(risky)*

## Added during WS2

**C-09 -- WS3.3 says "Remove/do not add any arxiv or paper-search skill or MCP server", but `osa setup`
(Phase 9, "installer bundling") registers `arxiv-mcp` and `paper-search-mcp`.** *Resolution:* WS3 removes
both from the setup catalog and from the run/drive "optional research servers" note; research uses the
built-in HTTP clients instead. The earlier memory entry that filed bundling for a future phase is superseded
by the directive. Reversible via git history. *(risky -- removes a shipped feature, by the directive's order.)*

**C-10 -- No "dispatch function is the lock" seam existed.** `runDispatch`/`runDrive` start immediately.
*Resolution:* the lock is the OSA pipeline's own gate (`src/osa/lock.ts`) *before* anything is dispatched;
the existing dispatch functions are untouched. To enforce "PRD immutable for the run", WS2 adds the
`assertPrdUnchanged` check; the drive loop calls it via a generic before/after-phase hook added in WS4/6.
*(safe)*

**A-06 -- Codex's configured default model is unusable on this machine.** `~/.codex/config.toml` pins
`model = "gpt-5.5"`, which the Codex CLI 0.160.0 rejects for this ChatGPT account ("not supported when using
Codex with a ChatGPT account"; it is also absent from `codex debug models`, whose catalogue is
gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol/terra/luna). Not an OSA defect and the user's
config was **not** edited. OSA's answer is `providers.modelOverrides` in `osa.config.json` (e.g.
`{"codex-cli": "gpt-6-luna"}`), which applies to every text call and build turn. Live-verified: a Codex text
call succeeds with the override. Any real Codex dispatch on this machine needs it. *(risky -- run-blocking)*

**A-07 -- Test fixtures are named `*.test.ts`** (`src/osa/fixtures.test.ts`) so the boundary scan and the
publish build, which both exclude `*.test.ts`, never ship or scan test-only helpers. The test runner reports
it as an empty passing file. *(safe)*

**A-08 -- Live-verified vs. not.** Verified against the real CLIs on this machine: Claude text call (OK),
Codex text call with model override (OK), and a full live `osa "<prompt>" --yes` intake with Claude. Not
verified live: Antigravity (see A-05), Codex `web_search="live"` honouring, Claude `WebSearch`/`WebFetch`
quality of results.

## Added during WS3

**C-11 -- OpenAlex no longer has a mailto "polite pool".** The directive says to send `mailto` "for the polite
pool". Live-verified 2026-10-17: an unauthenticated response carries a notice that requests share one small
free daily budget (about $0.10, ~$0.001 per search) per IP, that `mailto` does **not** raise it, and that a
free `api_key` has its own larger budget. *Resolution:* `research.openalexMailto` is still sent when set
(harmless, identifies the client), `OPENALEX_API_KEY` is read from the environment when present, and a
budget/rate failure degrades to an empty result with the reason logged (`academic_query.problems`), never a
crash. Documented in `.env.example`. *(safe)*

**C-12 -- GitHub code search needs authentication.** Verified live: `GET /search/code` returns 401 without a
token; repository search, README and contents work unauthenticated (60 core requests/hour). *Resolution:* the
prior-art lookup uses repository search + README + key files (default 3 repos, within the hourly budget) and
notes in the report when `GITHUB_TOKEN` is absent. Code search is not used. *(safe)*

**C-13 -- The upstream skill files were read, not assumed.** `Weizhena/Deep-Research-skills` default branch is
`master`; its `research` skill's five human stops are `AskUserQuestion` calls (framework confirmation, time
range, existing fields, batch size, items-per-agent). `fields.yaml` upstream is category-grouped with
`detail_level`; OSA's is a typed flat schema (`string | string[] | sources`) with `required`, because OSA
validates results mechanically rather than by coverage percentage. See `ATTRIBUTION.md`. *(safe)*

**A-09 -- Untrusted text.** Everything fetched from the network (abstracts, READMEs, web pages the agents
read) is third-party text. Prompts fence it as DATA and tell the model to ignore instructions inside it. This
reduces, not eliminates, prompt-injection risk; research agents run with read-only tools only (no Bash/Write)
so an injected instruction cannot modify the repository. *(risky -- residual)*

**A-10 -- Boundary-scan hygiene.** Writing the research code tripped B4 (URL literals) in three files outside
`src/research/net/`; they were fixed by moving URL construction into `net/urls.ts` and removing a scheme
literal from a prompt string, **not** by widening the exemption. *(safe)*

## Added during WS4

**C-14 -- Where "relay handoffs between providers/agents" are trimmed.** The existing in-phase relay (the
`HandoffRecord` passed from executor to reviewer, plus the reviewer's diff) is deliberately NOT trimmed: the
records are small and structured, and a reviewer must see the real diff ("the diff alone", PRD §6). Trimming
applies to the *free-text* handoffs OSA adds: research -> spec, and phase N -> phase N+1 (step 14). *(safe)*

**C-15 -- Injecting phase N's output into phase N+1.** `drive` builds a fresh `RunConfig` per phase and reads
`executor_prompt_path` / `reviewer_prompt_path` anew each time. OSA points both at
`runs/<id>/step14/executor-context.md` and has step 14 rewrite it after every phase, so the next phase's
turns receive the trimmed handoff without changing any dispatch code. The existing sanitiser prepends a
generic "this is the project's methodology prompt" notice to it; the file therefore opens by saying it is
background, not instructions, and that the locked PRD / context / spec remain the authority. *(safe)*

**C-16 -- Step 14 must be committed.** Anything OSA writes between phases and leaves untracked would be swept
into the next agent turn's *fallback commit* (`captureTurnLeftovers`), wrongly attributing harness output to
an agent and polluting `repo.commits`. Step 14, the lock, research and spec all commit their own paths with
`commitPaths` (a path-scoped commit; `stageAllAndCommit` is not used). *(safe)*

**A-11 -- Token estimate.** Budgets use `ceil(chars / 4)`. It is an estimate, labelled as such everywhere,
not a tokenizer. *(safe)*

## Added during WS5

**C-17 -- The Antigravity "dispatch failure" was reproducible, and it was not the flag shape.** The git history
shows two earlier fixes to `agy`'s `--print=` argument. The failure that remained on `agy` 1.3.3 was in
*interpreting* a successful run: the `result` event moved its fields under a nested `result` object. Fixed in the
adapter; see `ANTIGRAVITY.md`. *(safe)*

**A-05 (updated) -- Live verification.** The text-call path was verified against the real `agy` 1.3.3; the
permission-skipping turn path was not run (classifier denial, respected) and is a documented manual step
(`AGY_LIVE_TURN=1`). *(risky -- residual)*

## Added during WS6

**C-18 -- "Each agent: own prompt file."** The package ships `dist/` only (`package.json` `files`), so `.md`
prompt files under `prompts/` would not reach an installed copy. Each agent therefore has its own **module**
holding its prompt and schema (`src/agents/implication.ts`, `lateral-architecture.ts`, `application.ts`), plus a
declaration of its inputs, outputs, config gate, provider key and event in `src/agents/spec.ts`. *(safe)*

**A-12 -- "Must not run on the same provider as the planner unless explicitly pinned (loud warning)."** The
default `agents.lateralArchitectureProvider` is `codex`, so "explicitly pinned" cannot be read off a defaulted
value. Added `agents.lateralArchitecturePinned` (default false): when the configured provider equals the planner
(`providers.pair[0]`) and it is **not** pinned, the agent is re-routed to the pair's other provider and the
reroute is warned; when pinned, it runs on the planner's provider with a `LOUD WARNING` in the run report. *(safe)*

**A-13 -- Where the planner's "which was chosen and why" lives.** The lateral agent needs a *planned*
architecture to differ from, so the spec author must now write a `## Planned architecture` section in
`context.md`. After the lateral review the planner is called once more (`architecture-decision`) and must
answer `Chosen: planned | <alternative>` + `Why:`; if it adopts an alternative it must return the full revised
`context.md` and Phase 1 spec (documentation sources are re-guaranteed). The record is appended to `context.md`
as `## Architecture decision` and logged as a `spec_assumption`. An invalid decision is a loud `StageError`. *(safe)*

**A-14 -- Application agent: sandbox, evidence, and what "fails the run" means.** It runs in a disposable
`git clone --local` of the finished repo (committed state only), with a shell but **no file-edit tool**
(`TextRequest.execute`), so it cannot fix the project to make a check pass. A criterion is met only with
evidence (a command **and** observed output); a bare "met" is downgraded (`downgraded` in the event);
unreported or `blocked` criteria are unmet; an agent that cannot answer fails the check ("could not verify"
is never "passed"). Exit code **24**, stage `verify`. Checked criteria are the PRD's (`AC<n>`) plus the spec's
implication criteria (`S<n>`). **Screenshots are not captured** (the directive says "where possible"): the
default targets are CLIs/libraries/APIs; a UI would need a browser tool no provider print-mode exposes
verifiably. *(risky -- scope)*

**A-15 -- Live verification of the application check.** Against the real CLIs, in a throwaway repo with one
correct and one deliberately buggy project: Claude Code (19 s / 20 s) and Codex CLI with `gpt-6-luna` (34 s /
26 s) both **passed the correct project and failed the buggy one for the right reason, with real evidence**.
Antigravity is declared `execute: false` (unverified; the classifier blocked the permission-skipping mode),
so the check routes to a provider that can. *(safe)*

## Added during WS7

**C-19 -- "Agents use `code_search` first" cannot be done by exposing an MCP tool alone.** Build turns run provider
CLIs headlessly, and the Claude adapter passes `--strict-mcp-config` (no MCP servers at all); wiring an MCP server
into three different CLIs' headless modes is invasive and was not verifiable here. *Resolution:* (1) the
`code_search` MCP tool exists for any MCP host that has `osa` registered; (2) more importantly, the pipeline
**injects the ranked hits into the build agents' context** -- `runs/<id>/step14/executor-context.md`, which every
turn already receives -- before phase 1 (query: the PRD's TL;DR + the Phase 1 spec) and after every phase (query:
the PRD's TL;DR + the next phase's spec), telling them to open those first and grep only as a fallback. *(safe)*

**A-16 -- The "embedding" is lexical-semantic, not neural, and is labelled as such.** No dependency and no network are
allowed, and no provider CLI exposes an embeddings call. The default embedder is a hashed sub-word TF-IDF with
identifier splitting, light stemming and a small concept table that expands *queries*
(`src/code-index/tokenize.ts`). `index.embedder` currently accepts only `"local"`; `Embedder` is the seam for a real
model. Measured: fixture repo 11/11 queries with the right file in the top 3 (including ones with no literal
overlap, e.g. "where do we check the user's password when signing in"); this repository (203 files, 2,306 chunks)
9/9 after fixing a real stemming bug found by the first run (8/9); first build ~1.1 s, no-op refresh ~0.2 s,
query ~0.1-0.2 s. Honest limit: it will not bridge vocabulary the concept table lacks. *(safe)*

**A-17 -- Index storage.** Flat `meta.json` + `chunks.jsonl` under `.osa/index/` with its own `.gitignore` (`*`).
No SQLite / vector extension (the lightest thing that works on all three OSes; `node:sqlite` is still
experimental). The directory is never committable, which also keeps it out of the harness's fallback commits.
Incremental by `size + mtime` fast-path then `sha256File`; a touched-but-identical file is not re-chunked. *(safe)*

**A-18 -- Chunking is regex-based, not a parser.** TS/JS, Python, Go, Rust, Java-family and Markdown get symbol
boundaries; other text gets overlapping windows. A one-line `constructor(...) {}` is not recognised as a symbol.
Deliberately dependency-free. *(safe)*

## Added during WS8

**A-19 -- "Written at run end from the run log (not mid-run chatter)."** The facts are derived deterministically by
`deriveFacts` from the run's *record* -- the locked PRD, what the person changed at the lock (generated vs locked
PRD), the spec decisions, the recorded architecture decision, per-phase outcomes and retries, the application
check's unmet requirements, unconfirmed research claims, failed research items -- not from any model's free text
and not from the chat log. There is no LLM in the memory path, so memory cannot be poisoned by a hallucinated
"lesson". It is written at *every* run end that got past the lock (finished, stopped, or failed check, and spec-only
runs); a run that throws before its end (e.g. a PRD-tampering abort) records nothing. *(safe)*

**A-20 -- "Never stores secrets" is enforced, and visibly.** Every fact passes `findSecret` (private keys, sk-/ghp_/
xox/AKIA/AIza/JWT/Bearer tokens, `password=`/`token=` assignments, URLs with embedded credentials, long
high-entropy tokens) plus single-line and 300-character limits. A rejected fact is **not stored, not trimmed**; it is
returned to the caller, counted and reasoned in the `memory_written` event, and (for `memory_append`) in the tool
result. The filter is biased to false positives. It is a safety net, not a guarantee against a determined adversary
who controls the text of a fact. *(risky -- residual)*

**A-21 -- Memory is committed by default, and may be git-ignored.** `.osa/memory/` holds shareable project knowledge,
so the pipeline commits it with a path-scoped commit; if the project ignores that path (`git check-ignore`), it is
written but left uncommitted. Either way it can never be swept into an agent turn's fallback commit, because it is
only written after the last build turn. Per-file cap 200 facts (oldest dropped, counted). *(safe)*

**A-22 -- Memory informs intake *and* the spec.** The directive asks for intake only; the spec author also gets the
block, because conventions and past failures matter at least as much when choosing a stack and a layout. It is
passed as an extra prompt section; the locked PRD is unaffected. *(safe)*

## Found by the first live end-to-end run (real Claude Code + Codex CLI + real research APIs, 2026-10-17)

The full pipeline was run once against the real providers in a throwaway repo. Intake, lock, research (cross-checked by
Codex, which contested 5 claims), the lateral architecture review and the planner's recorded decision, the implication
review, the spec, a real **Claude Code executor turn that wrote the project and committed it**, and a Codex executor turn
all ran. The run then **stopped honestly** -- and in doing so exposed four defects, all fixed with regression tests:

**C-20 -- Codex CLI on Windows writes handoff JSON with a UTF-8 BOM.** `JSON.parse` rejects a BOM, so a valid record was
refused (`Unexpected token` at character 0). This is a defect in the *pre-existing* harness (`readHandoffRecord`), not in
the OSA additions; it would have bitten any Codex turn on Windows. `readHandoffRecord` now drops a leading BOM
(`src/domain/relay.ts`). *(safe)*

**C-21 -- The secret filter false-positived on UUIDs.** Failure notes carrying a run id were rejected as "a long
random-looking token" (2 of 29 memory facts in that run). Canonical UUIDs are now exempt from the scan; a `token=<uuid>`
assignment, hex keys and everything else are still caught. Derived failure facts are also scrubbed of run ids, absolute
machine paths and BOMs (`<id>`, `<path>`), because "Failed to parse C:\Users\...\84ef52b0-...json" is junk the next run
cannot use. *(safe)*

**C-22 -- A stopped run's summary leaked engineering text.** The "It did not finish" section pasted a Windows path and a
JSON error. The reason is now chosen from the *kind* of failure (`plainStop`, by exit code) and the raw problems appear only
under a clearly labelled last section, "For engineers (technical detail)". *(safe)*

**C-23 -- GitHub prior-art returned nothing for long queries.** Repository search ANDs every word; two seven-word queries
matched nothing. A query that matches nothing is now retried once with at most three meaningful words
(`simplifyQuery`), and the retry is noted in the report. *(safe)*

**C-24 -- (second live run) A tiny project leaves the second executor with nothing to commit.** With the BOM fixed, the
run reached a harder, legitimate wall: Claude (executor A) built the whole word counter in one commit; Codex (executor B)
honestly verified it ("9 tests passed") and reported *completed* with no commit; the harness rejected the turn under rule
**R3** ("completed implies at least one commit"). R3 is a core guarantee and was **not** weakened. The cause is upstream:
the harness always runs executor A, executor B, then the reviewer, but the spec gave B nothing to do. Fix: the spec prompt now
states the execution model and **requires** `## Part A (first agent)` / `## Part B (second agent)` sections (Part B = what
depends on A: edge cases and their tests, error handling, integration tests, usage docs); a spec without both is rejected
and retried (`assertTwoParts`; also enforced on an architecture rewrite); and every build turn's context now opens with
"Turn rules" ("if the earlier agent seems finished, check against the acceptance criteria and your Part, add the missing tests,
edge cases or documentation, and commit that; never an empty or cosmetic commit"). *(safe)*

**C-25 -- `osa evidence` / the MCP `evidence` tool reported a false AC3 failure for an OSA-built project.** Found by running
the MCP `evidence` tool against the third live run: AC1, AC2 and production passed, but the references check looked for
`runs/<id>/spec/baby_prd.md` (the old loopr layout) while OSA locks the PRD at `runs/<id>/baby-prd.md`. `assessAc3` now asks
`resolveOsaPrdPath`, which reads `prd_path` from `.osa/runs/<id>/prd.lock.json` for specs under `runs/<uuid>/spec/`;
with no lock record (or a corrupt one) the old convention applies unchanged, so non-OSA behaviour is the same. *(safe)*

**C-26 -- The run summary's "Choices made for you" still read like an engineer's note.** The third live run's summary listed
CommonJS, shebangs, `fs.readFileSync` and exit codes, against the directive's plain-language rule for anything shown to the
person. The spec's raw decisions are now rewritten by one short model call (`plain-choices`, at most 8 bullets, code ticks
stripped). If that call fails, the plain part says only how many technical decisions were made; the raw text appears **only**
under "For engineers (technical detail)" at the end. *(safe)*


## Added during WS10 (modular features: CBM and trim-1 off, one switch each)

**C-27 -- The defaults flipped, so four existing tests that encoded the old defaults were updated (not weakened).** `trim.enabled`
is now `false` (it was `true`); `index.engine` was already `lexical`; `intake.quoteStatedRules` is new and `false`. The one
defaults assertion (`osa-config.test.ts`) now pins the new values. Three trim tests (`trim.test.ts`, two in `trim-live.test.ts`)
exercise what happens when trim-1 is switched ON and used to get that from `defaultOsaConfig()`; they now say `enabled: true`
explicitly and every assertion in them is unchanged (an explicit `enabled: false` still wins). My own `runIntake` quoting test
sets `quoteStatedRules: true` the same way. *(safe)*

**C-28 -- `DoctorReport` gains a third optional key, `features`.** The user wants `osa doctor` to report each feature as
"disabled". As with `build` and `warnings` before it (J-02 of the test-hardening report) the pinned key-set test `AC3-c` was
extended by that one key; it is still an exact-set equality. *(safe)*

**C-29 -- What `intake.quoteStatedRules` switches off.** Only the behaviour of commit `5e7e1b9`: asking the model for
`statedRequirements`, verifying the quotes against the prompt, and appending them as acceptance criteria. The *verbatim request
section* in the PRD (`6cbef29`) and the intake rule "what the person stated is a requirement, not an assumption" (`23180a5`) cost no
extra criteria and no extra call, so they stay on. *(safe)*

**C-30 -- Which commands take the feature flags.** `osa "<prompt>"`, `osa search`, `osa doctor` and `osa features`. Not `osa index`
(it only builds the lexical index), not `run`/`drive`/`evidence`/`mcp`. The MCP `code_search` tool reads `osa.config.json` only
(an MCP call has no command line). A flag affects one command and writes nothing. *(safe)*

**C-31 -- "No imports with side effects" is enforced by a test, not a convention.** `src/osa/modular-features.test.ts` walks the
static import graph (`import … from`, `export … from`, bare `import "x"`; not `import type`, not dynamic `import()`) from every entry
point -- CLI, MCP server, pipeline, searcher, trimmer resolver, doctor -- and fails if it reaches `src/trim/trim1.ts`,
`src/code-index/cbm/**` or `src/code-index/fusion.ts`. The only places that load them are `import()` calls inside
`createCodeSearcher` (when the engine is `cbm`) and `resolveTrimmerLazily` (when trim is enabled). A mutation check proves the
walker would catch a planted static import. *(safe)*

**C-32 -- The repository's own `osa.config.json` was invalid JSON.** The file created in the test-hardening round contained
unescaped backslashes in `trim.binaryPath` (`"C:\Users\…"`), so every OSA run in this repository would have refused it. The new
`osa doctor` feature report surfaced it as a warning ("could not be read"); it is rewritten with forward slashes and now sets all
three switches explicitly to off, as asked. The file is git-excluded (machine-specific). *(safe)*

**C-33 -- `osa doctor` and an ENABLED feature whose binary is missing.** A disabled feature is only reported: its binary is never
looked for, so a missing CBM or trim-1 binary neither fails nor warns. An enabled one whose configured binary path does not exist is
a non-fatal warning (it never changes `ok` or the exit code), because the user asked for the feature and it will fall back. An
unreadable project config is also only a warning in doctor. *(safe)*

## Added in this repository (S-series: decisions made after the original directive)

**S-01 -- Cross-provider review is no longer enforced; review independence is by MODEL.** This reverses the directive's ground rule 5
("never weaken cross-provider review ... loud failure on self-review configs") at the owner's explicit instruction: many users can afford
only one provider. `providers.pair` may name one provider twice; a seat is a provider plus a model (`providers.seatModels`); `src/domain/independence.ts`
ranks how independent the reviewer is (different family > different class > different provider > different model > unverified > same
model); `src/osa/seats.ts` chooses seats (from the installed tools when `pair` is unset, with different models when only one provider exists);
the result is logged (`seats_resolved`, `review_independence`), shown in the run report and warned about, with advice, when weak. Nothing
refuses. Removed: the `providers.pair` distinctness refine, the `executor_providers` distinctness refines (RunConfig, DriveConfig), the
research cross-check's same-provider throw, the lateral agent's re-route/pin logic (`lateralArchitecturePinned` is gone; the agent picks
the most independent seat or the one the operator names), the acceptance AC1 same-provider structural failure, and the two-healthy-providers
preflight minimum (now one). *(risky -- a weaker default guarantee; the guarantee is now measured and reported instead of mandated)*
Documented in `INDEPENDENCE.md`.

**S-02 -- Tests that encoded the old rule were replaced, not weakened.** Eight tests asserted the refusal ("providers.pair must be two
different providers", DriveConfig identical ids, the research check refusing a same-provider pair, AC1 failing on one provider, the lateral
re-route and pin warnings, the CLI's same-provider config failure). Each is now a test of the new behaviour (one provider runs; the
independence level is reported; a weak review warns with advice). Every other assertion is unchanged.

**S-03 -- Two tests asserted the author's machine.** `runPreflight` and `doctor --providers` tests asserted "all three providers are healthy
here". Which CLIs a person has installed is not part of the contract; they now assert consistency with the one-healthy-provider rule and
that a provider that is not installed is never mentioned. The 30 s child-process timeouts in the test helpers are 120 s (a timeout, not an
assertion): a Windows Modern Standby of 13 minutes made two tests fail on resume in the original repository.

**S-04 -- OpenCode and GitHub Copilot CLI adapters.** OpenCode was verified against v2.1.1 (`OPENCODE.md`); Copilot was not (the CLI is not
installed here) and is marked experimental in `COPILOT.md`, `osa doctor` and the README. New provider ids: `opencode-cli`, `copilot-cli`.

**S-05 -- Codex is optional.** Nothing defaults to Codex any more (no default lateral provider, no default pair when the config sets none).
The Codex adapter is kept.

**S-06 -- Not carried over: the spec chain (Steps 6-8) and the first-output window.** The chain's default providers included Codex, its
audit loop was unproven on this machine (two Antigravity timeouts, one permission failure, a REPOSITION-REQUIRED halt on a small project)
and it cost about 4x the wall time of the single spec author for a better URL-validation rule. It lives on the original repository's
`osa/ws9-spec-chain` branch and can be ported as a patch.

**S-07 -- Naming.** Every mention of the previous product name, its run directory (`.osa/` is now the single data directory), its alias
binary, its config-file fallback and its legacy MCP server name was removed; the build-process documents of the original project were dropped.
The licence line "the OSA contributors" replaces the previous contributors line (the copyright holder is the owner's to set).

**S-08 -- Semantic code search is a third value of the one index switch, not a default.** `index.engine: "hybrid"` re-ranks the lexical index's
candidates with an embeddings model reached through an operator-configured OpenAI-compatible endpoint (`index.semantic`), cached on disk, with a
fallback to the lexical index on any failure (`SEMANTIC.md`). Requested as "I want it semantic"; implemented as an option because (a) no provider CLI
or Anthropic API gives embeddings, so an endpoint (a key, or a local server with none) is unavoidable; (b) the earlier spike found an embedding path
ranking the right function 31st of 50 on a paraphrase, so it must be tried and measured per project before it replaces the offline default; (c) it
could not be run live here (no endpoint or key), only against a fake embeddings server; `scripts/embeddings-smoke.ts` is the real-endpoint check.
The embeddings client lives in `src/research/net/` (the one network-exempt directory, held to B9) and contacts only the configured host. No
dependency was added. *(risky -- unverified live)*

**S-09 -- The CBM engine runs ranked, with a query rewrite, instead of abstaining.** Requested: optimise codebase-memory-mcp rather than accept the earlier
negative result. Findings (docs/osa/CBM_NOTES.md section 6): the earlier tuning optimised "confident-wrong <= 2%" by abstaining on 65% of questions;
CBM's text-search channel alone beat the fused engine; and the question was never translated into code vocabulary. The engine now defaults to
`guard: false` with `RANKED_TUNING`, plus a model-written rewrite (`index.rewrite`, a cheap model, cached, fail-soft, run in an empty directory).
`index.cbm.abstain: true` restores the previous mode. `index.engine` still defaults to `lexical`. The gain is measured on retrieval only (79% vs 64% right file in
the top 5 on 70 queries, 30 of them held out); token savings and answer quality are not yet measured, and for greenfield builds the ceiling is low.
*(risky -- changes what CBM returns for anyone who had enabled it; reversible with index.cbm.abstain)*

**S-11 -- The one human decision moves from the lock (before research) to a confirmation after the spec, before the build.** Requested and agreed by the
user, 2026-10-24: the lock reasoned from the raw one-shot prompt alone, so for a vague prompt ("build the next Instagram") the plan the person was asked to
lock was generic, and a blocking gate before any work sits badly with one-shot. New rule: (1) the baby PRD is locked AUTOMATICALLY before research (same
SHA-256, lock record, `prd_locked` event and integrity checks; it never refuses and asks nothing); (2) intake classifies the prompt `narrow` or `broad` and,
when broad, offers up to 3 recommended questions with best-guess defaults (a nudge, not a gate); defaults the person did not answer carry the new assumption
tag `defaulted`; (3) after research and spec the person sees a TL;DR assembled deterministically from existing artifacts (no extra model call) and approves
once; (4) `--yes` proceeds only when no assumption is `risky` (`defaulted` ones are accepted, and always listed), otherwise exits 19 at that gate; with
`--accept-risky` (only valid with `--yes`) it proceeds and every risky and defaulted item is recorded. Old rule, replaced: exit 19 / Cancel (22) AT THE LOCK with
nothing researched or committed, and "no I/O after the lock". Tests replaced (the rule they pinned was reversed, not weakened): `pipeline.test.ts` "osa --yes
with a risky assumption" and "interactive: Cancel ...", and `lock-hardening.test.ts` "NO MID-RUN QUESTIONS" (still exactly one human prompt per run and every
model prompt still forbids questions; the prompt is now after the spec). Not changed: the PRD hash is still checked before research, around every build phase and
at the end. Cost of the new order: a refusal or a cancel now happens after about 20 minutes of research and spec, not before them; the broad-prompt nudge exists
to make that rare. *(risky -- changes when the person decides; reversible by restoring `lockBabyPrd` in the pipeline)*
