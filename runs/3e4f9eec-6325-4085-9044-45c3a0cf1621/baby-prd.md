# Baby PRD -- OSA's intake/lock/spec gate internals and the reshaped one-shot plan/spec/build flow across CLI and MCP

## TL;DR
- We will rebuild the decision point in OSA's one-shot build flow so it stops interrogating people up front.
- For vague prompts it shows up to 3 recommended questions with best-guess defaults, but keeps going on those defaults unless answered.
- It locks the draft spec automatically, then asks for ONE real yes/no approval only after the full spec is ready, tied to that exact spec.
- You will know it works when the test suite and type checks pass green, and a broad prompt flows: questions -> spec -> approval -> build.
- Wrong-spec or risky approvals are refused, hands-off mode (--yes --accept-risky) proceeds, and all docs/records are updated.

## Baby PRD

### Problem
OSA's current gate puts a blocking human lock BEFORE research for vague prompts, and the MCP flow confirms before the spec exists. For a vague prompt this either interrogates the person or forces a decision with too little information, and a wrong direction wastes a ~20-minute research+spec run.

### Users / who it's for
Developers using OSA (One-Shot Anything) via its CLI and via its MCP tools from an assistant, who give a single prompt and want a build with exactly one meaningful confirmation.

### In scope
- Phase 1: extend the zod intake schema with scope ('narrow'|'broad') and recommended_questions [{question, default}] (max 3, empty when narrow); update intake prompt, parsing, normalisation and BabyPrd types.
- Phase 1: add a third assumption risk value 'defaulted' through parseBabyPrd/renderBabyPrd, counts(), the backstop (must not silently upgrade 'defaulted' to 'risky') and every consumer, keeping the baby-prd.md round trip lossless.
- Phase 1: support optional answers (a map question->answer) appended to the request as 'Clarifications from the person:' triggering one intake re-run; unanswered recommended questions become 'defaulted' assumptions.
- Phase 2: auto-lock the baby PRD before research with no prompt, keeping the hash, prd_locked event and prd_integrity_verified checks exactly as they are; remove the human-facing pre-research lock/edit loop from the default flow.
- Phase 2: generalise lockBabyPrd into a reusable gate over an artifact+hash so the same unattended/refused/accept-risky rules apply to the new spec gate; keep lock tests that still describe real behaviour.
- Phase 2: add pipeline options stopAfterSpec and fromSpec; write .osa/runs/<id>/spec-gate.json with prd_sha256 and a spec-gate hash (sha256 of a manifest of all spec files: sorted paths + each file's sha256); fromSpec verifies BOTH hashes and skips intake/research/spec, reusing existing resume support.
- Phase 2: assemble the TL;DR deterministically from existing artifacts (PRD goal/scope, logged spec decisions, research uncertainties/unconfirmed claims, risky and defaulted lists, build-phase count, review-independence line); add no model call, and STOP and report if no readable TL;DR can be built that way.
- Phase 2: CLI post-spec gate -- default interactive y/N showing the TL;DR; --yes proceeds only with zero risky assumptions else exits 19; --yes --accept-risky fully hands-off; 'no' ends cleanly keeping the run folder and a line on how to change direction; --accept-risky without --yes is a usage error.
- Phase 3: MCP tools reshaped to plan/spec/build -- osa_plan stays intake-only and returns plan, scope, recommended_questions and plan_sha256; new osa_spec(run_id, plan_sha256, answers?) auto-locks the PRD and runs research+spec as a background job.
- Phase 3: osa_status reports stage/progress and, when finished, status 'awaiting_confirmation' with TL;DR, risky/defaulted lists and spec_sha256; osa_build(run_id, spec_sha256, accept_risky_assumptions) refuses on hash mismatch and refuses risky items without the flag; jobs survive as files.
- Phase 3: tool descriptions instruct the assistant to relay recommended questions as highly recommended, show the TL;DR before osa_build, and never set accept_risky_assumptions itself; update the surfaces test pinning the tool list.
- Phase 4: add CONFLICTS.md entries (next free S-number) for lock moved to post-spec, 'defaulted' tag, nudge-not-interrogation, plan/spec/build MCP flow, and --accept-risky, each stating old rule, new rule, decider (user, 2026-10-24) and tests replaced; update README MCP and CLI sections.
- Tests for each phase via the fake textCall seam plus integration tests of the whole new flow; run npm run typecheck and touched tests after each phase and npm run check at the end.
- Commit locally per phase by explicit path, author Kaide-LABS <Hafeedh.balogun@gmail.com>, no Co-Authored-By or 'Generated with' lines.

### Out of scope
- Any new model, small LLM/NN or extra classifier -- scope detection and TL;DR must be deterministic/non-model.
- Version bump, npm publish, git push, tagging, or any release.
- Starting a real provider run or a real build -- only prepare the exact commands for the person.
- Touching other worktrees (OSA-clean, OSA-mcp, OSA-router and others) or writing outside this directory.
- Committing osa.config.json, runs/ or .osa/.
- Adding dependencies beyond zod and @modelcontextprotocol/sdk.
- Weakening, skipping or deleting tests except replacing ones encoding the reversed pre-research human-lock rule.
- Keeping the pre-spec confirmation in the MCP two-step (osa_plan -> osa_build); it is reversed into plan/spec/build.
- Changing boundary rules B1-B12 placement (child_process only in src/util/exec.ts; model names only in src/adapters/**; network only in src/research/net/**).

### Acceptance criteria
1. npm run check completes green: typecheck passes, the full test suite passes, and the boundary scan reports 0 violations.
2. A broad prompt through the fake textCall seam yields scope 'broad' and 1-3 recommended_questions each with a default; a narrow prompt yields scope 'narrow' and an empty recommended_questions array.
3. Given a broad prompt with no answers, each unanswered recommended question becomes an assumption tagged 'defaulted'; given answers to those questions, intake re-runs once and those items are NOT tagged 'defaulted'.
4. A baby-prd.md containing 'safe', 'risky' and 'defaulted' assumptions survives a render -> parse round trip byte-for-byte, and counts() reports each risk value separately.
5. The backstop never changes a 'defaulted' assumption into 'risky'.
6. The PRD is locked automatically before research with no prompt, and prd_locked plus prd_integrity_verified behave exactly as before (verified by the retained lock tests).
7. spec-gate.json is written with prd_sha256 and a spec-gate hash equal to the sha256 of the sorted-path + per-file-sha256 manifest of all spec files; fromSpec with both hashes correct skips intake/research/spec, and fromSpec with either hash wrong is refused.
8. The TL;DR is produced with no model call from existing artifacts; if a readable TL;DR cannot be assembled, the run stops and reports instead of calling a model.
9. In the integration flow: broad prompt -> questions -> osa_spec -> osa_status returns 'awaiting_confirmation' with TL;DR, risky/defaulted lists and spec_sha256 -> osa_build with the matching spec_sha256 proceeds.
10. osa_build (and the CLI gate) with a wrong/mismatched spec hash is refused; a risky assumption without the accept flag is refused in the same refusal style as today.
11. CLI --yes with at least one risky assumption exits with code 19 and a plain-language message; --yes with only defaulted/safe assumptions proceeds; --yes --accept-risky proceeds and writes every risky and defaulted item to the run report and summary.
12. --accept-risky passed without --yes is rejected as a usage error.
13. The CLI interactive gate shows the TL;DR and asks y/N; answering no exits cleanly, keeps the run folder, and prints how to change direction.
14. The surfaces test asserts the tool list is osa_plan, osa_spec, osa_build, osa_status (not the old osa_plan/osa_build two-step), and the assertions are replaced not weakened.
15. osa.config.json, runs/ and .osa/ are not staged in any commit; each phase has its own local commit authored Kaide-LABS <Hafeedh.balogun@gmail.com> with no Co-Authored-By or 'Generated with' lines.
16. docs/osa/CONFLICTS.md has new entries at the next free S-number covering all five reversals, each with old rule, new rule, decider and replaced tests; README MCP and CLI sections describe the plan/spec/build flow and the post-spec gate.
17. Tool descriptions state the assistant must relay recommended questions as highly recommended, show the TL;DR before osa_build, and never set accept_risky_assumptions itself.

### Constraints
- Work only inside the current worktree (branch feat/spec-gate, cut from origin/main 67e1961); never read or write outside it or touch other worktrees.
- Dependencies limited to zod and @modelcontextprotocol/sdk; no new dependencies.
- Node 22+/24 with TypeScript run via type stripping (erasableSyntaxOnly): no enums, no parameter properties.
- Boundary rules B1-B12: child_process only in src/util/exec.ts; concrete model names only in src/adapters/**; network only in src/research/net/**.
- No new model call anywhere in the gate or TL;DR path.
- Windows shell: backslashes in heredocs/sed collapse -- edit files with file-editing tools, not shell redirection.
- Commit locally per phase by explicit path; do not push, tag, or publish; never commit osa.config.json, runs/ or .osa/; never paste secrets.
- Do not start a real provider run or a real build; only prepare exact commands for the person.
- If the brief contradicts the code, stop that phase, say exactly where, and do not guess.

### Research plan
- Topic: OSA's intake/lock/spec gate internals and the reshaped one-shot plan/spec/build flow across CLI and MCP
- Time range: current repo state at 67e1961; reference material last 2 years
- Items:
  1. intake-schema-and-babyprd | Intake schema, baby PRD types and backstop | How do intake.ts, baby-prd.ts (parseBabyPrd/renderBabyPrd, counts, applyRiskBackstop) and the BabyPrd zod schema fit together so scope, recommended_questions and the 'defaulted' risk can be added losslessly? | modules: github-debug
  2. lock-gate-generalisation | lockBabyPrd gate semantics | What exact unattended/--yes/refused (exit 19)/accept-risky rules does lock.ts lockBabyPrd implement, and how can it be generalised into a gate over an arbitrary artifact+hash for reuse at the spec gate? | modules: github-debug
  3. pipeline-stages-and-resume | Pipeline stages, hashing and resume | How does pipeline.ts sequence intake/lock/research/spec with stopAfterPlan and fromDraft, how is prd_sha256 computed/verified (prd_integrity_verified), and what resume support exists (research_validated 'resumed' count)? | modules: github-debug
  4. spec-manifest-hashing | Deterministic spec-file manifest hashing | What is a robust way to build a sorted-path + per-file-sha256 manifest of all spec files and hash it reproducibly across platforms for the spec-gate hash? | modules: general-web, stackoverflow
  5. deterministic-tldr-sources | Artifacts available for the deterministic TL;DR | Which events/artifacts (PRD goal/scope, spec_assumption / 'N spec decisions logged', research open uncertainties, unconfirmed claims, risky/defaulted lists, build-phase count, review-independence line) exist and are readable for assembling the TL;DR without a model? | modules: github-debug
  6. mcp-tools-and-jobs | MCP tool wiring and durable background jobs | How do src/mcp/tools/osa.ts and the server register tools, persist plan-request.json / mcp-result.json, and run background jobs so a restarted server still answers osa_status, to reshape into plan/spec/build? | modules: github-debug
  7. mcp-sdk-tool-contract | @modelcontextprotocol/sdk tool declaration | What is the current SDK-supported way to declare tools, their input schemas and descriptions, and return results, so osa_spec can be added and the surfaces test re-pinned? | modules: general-web
  8. surfaces-and-boundary-tests | Surfaces test and boundary scan | How does the surfaces test pin the tool list and how does the boundary scanner enforce B1-B12, so the tool-list assertions can be replaced and 0 violations kept? | modules: github-debug
- Official docs to read:
  - zod
  - @modelcontextprotocol/sdk
  - Model Context Protocol
  - Node.js
  - TypeScript
  - Node.js crypto
  - Node.js test runner
- Academic searches:
  - (none)
- Prior-art searches:
  - Model Context Protocol server stdio tool implementation TypeScript
  - long-running background job durable status MCP tool node
  - deterministic directory file manifest sha256 reproducible hash node

## Assumptions
- [risky] 'Commit locally per phase' means one commit per phase (4 phases), each authored Kaide-LABS <Hafeedh.balogun@gmail.com>, even though the branch git user is Kaide-LABS <Hafeedohwork@gmail.com>; the brief's author line takes precedence.
- [risky] The spec-gate hash covers every file written under the spec output directory for the run; 'all spec files' excludes research and run-metadata files not part of the spec artifact.
- [risky] The scope 'broad' vs 'narrow' signal is produced by the single existing intake model call via the extended prompt/schema, not by any added heuristic code, satisfying the no-new-model rule.
- [risky] The interactive post-spec gate defaults to 'No' on empty/EOF input (y/N convention), so an accidental enter does not trigger a build.
- [safe] The project uses the built-in Node test runner (node:test) rather than an external framework, inferred from the zod + @modelcontextprotocol/sdk-only dependency constraint.
- [safe] 'next free S-number' in CONFLICTS.md means continuing the existing S-prefixed numbering sequence already in that file; the exact next number will be read from the file at implementation time.
- [safe] recommended_questions defaults are used verbatim as the 'defaulted' assumption text when unanswered; no rephrasing is applied.
- [safe] osa_spec returning immediately means it starts the background job and returns a run/job handle without waiting for research+spec to finish, matching the existing background-job pattern.
- [safe] 'answers' at osa_spec and the CLI are matched to recommended questions by exact question-string key; a non-matching key is ignored rather than erroring.
- [safe] When spec decisions carry no risk tag, they are listed untagged in the TL;DR and the gap is reported, rather than inferring a tag.
- [safe] The GitHub repo link github.com/Kaide-LABS/osa was not opened; its contents are assumed to match the local worktree at 67e1961 and were not independently verified.
- [safe] 'exit 19' is the existing refusal exit code already used by lockBabyPrd and is reused unchanged at the new spec gate.

## Original request (authoritative)

The person's own words, unedited. Where anything above differs from this, this request wins.

> TASK: Rebuild OSA's gate for the one-shot flow. Repo: OSA (github.com/Kaide-LABS/osa, package @kaide-labs/osa 0.4.1). You are ALREADY inside the git worktree for this work (branch feat/spec-gate, cut from origin/main 67e1961). Work ONLY inside this directory: never read or write outside it, never touch any other worktree (C:\Users\hp\OSA-clean, OSA-mcp, OSA-router and the others belong to other sessions). Commit locally per phase, by explicit path, author Kaide-LABS <Hafeedh.balogun@gmail.com>, NO Co-Authored-By or "Generated with" lines. Never commit osa.config.json, runs/ or .osa/ (they belong to the harness that is running you). Do NOT push, tag, or publish. Never paste secrets.
>
> BACKGROUND (verified in the code, do not re-derive)
> - Today: intake (src/osa/intake.ts, ONE model call) writes the baby PRD and tags each assumption risky/safe; applyRiskBackstop (src/osa/baby-prd.ts) deterministically upgrades some safe -> risky. There is NO separate classifier model. Then src/osa/lock.ts lockBabyPrd is a human gate BEFORE research (unattended/--yes locks only when zero risky, else exit 19 "refused"). Then research and spec run, anchored on the locked PRD's sha256 (prd_integrity_verified is checked before research).
> - src/osa/pipeline.ts has stopAfterPlan and fromDraft. src/mcp/tools/osa.ts has osa_plan -> (person confirms) -> osa_build(plan_sha256, accept_risky_assumptions) -> osa_status; files .osa/runs/<id>/plan-request.json and mcp-result.json; background jobs live in the server process.
> - A real spec-only run took ~22 min and 27 model calls (research ~14 min, spec ~6 min). That is why a human gate cannot sit only after the spec for a vague prompt, and why osa_plan cannot wait for the spec over MCP.
>
> THE AGREED DESIGN (user decided; implement it, do not relitigate)
> 1. NO blocking interrogation. Intake detects a broad prompt (e.g. "build me the next Instagram") and returns up to 3 recommended questions, each with a best-guess default. It is a NUDGE: the run proceeds on the defaults unless the person answers. Wording is strong but honest: highly recommended; a full research+spec run is ~20 minutes and a wrong direction means paying for it again plus the prompt rework. Quote only measured numbers. Specific prompts get no nudge and no questions. No new model, no small LLM/NN, no extra classifier.
> 2. The baby PRD is locked AUTOMATICALLY before research (keep the hash, the prd_locked event and the prd_integrity_verified checks exactly as they are). The human-facing pre-research lock/edit loop is removed from the default flow.
> 3. ONE real confirmation, AFTER the spec and BEFORE the build. A TL;DR is shown and approval is bound to a spec hash.
> 4. Third assumption tag "defaulted": a nudge default the person did not answer. It is always listed at the gate; --yes accepts it; only --accept-risky covers genuinely risky ones.
> 5. Modes at the post-spec gate: default = confirm (interactive y/N in the CLI; explicit osa_build over MCP). --yes = proceed only if zero risky assumptions, otherwise refuse with exit 19 and a plain-language message (current semantics, moved to the new gate). --yes --accept-risky = fully hands-off; every risky and defaulted item is written to the run report and summary. --accept-risky without --yes is a usage error. An assistant must never set accept_risky_assumptions itself (keep that rule in the tool description).
>
> PHASES (do in order; commit after each; run npm run typecheck and the touched tests after each)
> Phase 1 - scope signal and "defaulted" tag.
>   - Extend the intake output schema (zod) with scope: "narrow" | "broad" and recommended_questions: [{question, default}] (max 3, empty when narrow). Update the intake prompt, parsing, normalisation and the BabyPrd types.
>   - Add risk value "defaulted" through parseBabyPrd/renderBabyPrd, counts(), the backstop (it must not upgrade defaulted to risky silently), and every consumer; the baby-prd.md round trip must stay lossless.
>   - Optional answers: a map of question -> answer. When given, they are appended to the request as "Clarifications from the person:" and intake re-runs once; unanswered questions become "defaulted" assumptions.
>   - Tests with the fake textCall seam: broad prompt yields questions; narrow yields none; unanswered -> defaulted; answered -> not defaulted; render/parse round trip.
> Phase 2 - pipeline: automatic PRD lock, stop after spec, resume from spec.
>   - Auto-lock the PRD before research (no prompt). Keep lockBabyPrd's logic reusable: generalise it into a gate that works on a given artifact + hash, so the same unattended/refused/accept-risky rules apply to the spec gate. Do not delete the lock tests that still describe real behaviour.
>   - Add pipeline options stopAfterSpec and fromSpec. The spec gate hash is the sha256 of a manifest of ALL spec files (sorted paths + each file's sha256), written to .osa/runs/<id>/spec-gate.json together with prd_sha256. fromSpec verifies BOTH hashes and skips intake/research/spec. First find out what resume support already exists (research_validated has a "resumed" count) and reuse it.
>   - TL;DR is assembled DETERMINISTICALLY from artifacts that already exist: PRD goal and scope, the spec's logged decisions (spec_assumption events / "N spec decisions logged"), research open uncertainties and unconfirmed claims, the risky and defaulted lists, number of build phases, and the review-independence line. NO new model call. If a readable TL;DR cannot be assembled that way, STOP and report instead of adding a model call. If spec decisions carry no risk tag, list them untagged and report that gap.
>   - CLI: --yes and --accept-risky as in the design; the interactive gate shows the TL;DR and asks y/N; "no" ends cleanly with the run folder kept and a line saying how to change direction (re-run with a refined prompt / answers).
> Phase 3 - MCP tools.
>   - osa_plan stays FAST (intake only): returns the plan, scope, recommended_questions and plan_sha256 (it now identifies the draft, nothing is locked). New osa_spec(run_id, plan_sha256, answers?): auto-locks the PRD and starts research+spec as a background job, returns immediately. osa_status reports stage/progress and, when finished, status "awaiting_confirmation" with the TL;DR, the risky/defaulted lists and spec_sha256. osa_build(run_id, spec_sha256, accept_risky_assumptions) refuses on hash mismatch and refuses risky items without the flag (same refusal style as today). Keep jobs surviving as files (mcp-result.json style) so a restarted server can still answer osa_status.
>   - Tool descriptions must tell the assistant: relay the recommended questions and say they are highly recommended; show the TL;DR to the person before osa_build; never set accept_risky_assumptions itself.
>   - Update the surfaces test that pins the tool list. This is a reversed contract (osa_plan/osa_build two-step becomes plan/spec/build): replace those assertions, do not weaken them, and record it.
> Phase 4 - docs and records.
>   - docs/osa/CONFLICTS.md: add entries (next free S-number) for: the human lock moved from before research to after the spec; "defaulted" tag; nudge instead of interrogation; MCP flow now plan/spec/build; --accept-risky. State the old rule, the new rule, who decided (the user, 2026-10-24) and which tests were replaced.
>   - README MCP and CLI sections updated. Bump nothing (no version change, no publish).
>
> RULES THAT STILL APPLY
> - Never weaken, skip or delete a test to make it pass. A test may be REPLACED only when it encodes a rule the user reversed (the human lock before research); say which and why in CONFLICTS.md.
> - Boundary rules B1-B12 stay clean (child_process only in src/util/exec.ts; concrete model names only in src/adapters/**; network only in src/research/net/**). Dependencies stay zod + @modelcontextprotocol/sdk only. Node 22+/24, TypeScript run via type stripping (erasableSyntaxOnly: no enums, no parameter properties).
> - Windows: backslashes in heredocs/sed get collapsed. Write and edit files with fil
> [... the rest of the request is not repeated here ...]
