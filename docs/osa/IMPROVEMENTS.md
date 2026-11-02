# OSA improvements log

Observations from a real build (PAU Muslim Ummah inventory module, two OSA runs, Haiku/Sonnet/Opus seats) and what has been done about them.
Branch: `fix/handoff-recovery` (from `origin/main`, v0.5.0). Pushed to origin; not merged into main yet.

## Done on `fix/handoff-recovery`

| # | Change | Commit | Why |
|---|---|---|---|
| 1a | Every dispatched turn is told the session is headless: write the hand-over record before stopping, never start a command in the background and end the turn to wait, run a narrower test instead of a long one. | `69ae905` | Both real builds crashed because the executor started `npm install` in the background and ended its turn. |
| 1b | A turn that ends without its hand-over record is a modelled `MissingHandoffError` (`HANDOFF_MISSING`, exit 4) naming the path and the usual cause, not a raw `ENOENT`. | `824a2d9` | The raw `ENOENT` crashed the whole run with no explanation. |
| 1c | `osa doctor` warns when `package.json` lists dependencies but `node_modules` is missing. | `a1a2015` | Prevents the cause of 1a. Warning only; it does not block `osa_build`. |
| 1d | A turn with a missing hand-over record is re-prompted once. The failed attempt's work is kept (soft rewind to where the slot began, work staged), so the retry's own commit covers it and the reviewer's diff still starts before it. A second miss stops the run with `HANDOFF_MISSING`. | `1ef8d67` | One slow install should not lose a 30 to 60 minute build. A first version without the rewind failed reconciliation ("completed implies at least one commit"); the soft rewind fixed it. |
| 1e | New MCP tool `osa_cancel`: stops a running or parked run, kills the agent processes it started, and records the run as `cancelled` (not `stopped` with an error). Work already committed stays. | `3c654d2` | A spec call hung for 2.6 hours and could not be stopped; the only option was killing processes by hand. |
| 1f | On Windows the turn timeout now kills the child's whole process tree (same `killProcessTree` as cancel), not just the `cmd.exe` shim. | `2407eec` | The surviving agent kept the output pipes open, so a timed-out call did not return until it exited. Without the fix the new test hangs for the sleeper's full 60 s; with it the call returns in under 3 s. Likely part of the 2.6-hour spec hang. |
| 1g | `osa_plan`, `osa_build` and `osa_status` return `seats`: the provider and model each seat resolved to (read back from the run's own `seats_resolved` event), who writes and who reviews the build, whether OSA chose the providers, which config file was read, and a note when a seat names no model (it then runs on the provider's own default). `osa_spec` points to `osa_status`, because its seats resolve a moment after it returns. | `20b20ad` | The first Opus build went out while the config was believed to say Sonnet. Config is re-read each time a stage starts, so `osa_plan`'s seats can differ from the build's if the file is edited before `osa_spec`; `osa_status` shows what the run really used. |
| 1h | A run lost to a server restart while it waited for the person's approval is carried on from its saved spec. At the gate the run saves `resume-state.json` (spec path and phase count, research counts, architecture decision, the approval TL;DR). After a restart `osa_status` shows it as `awaiting_confirmation` (with a note that the server restarted) instead of `interrupted`, and `osa_build` re-verifies the spec hash and the risky-assumption acceptance, then builds in a new job without repeating intake, research or spec. The pipeline's `fromSpec` stub is now real. | `00368e5` | Restarts, sleeping laptops and crashes repeatedly cost a 15 to 20 minute research and spec run that was already finished and waiting for a yes. |

How `osa_cancel` works: the background job runs inside `runCancelScope` (`src/util/exec.ts`, an `AsyncLocalStorage` holding an `AbortSignal`). Every `runProcess` started in that context watches the signal and, on abort, kills its child's whole process tree (`taskkill /T /F` on Windows, because the provider CLIs sit behind a `cmd.exe` shim and `child.kill()` ends only the shim). A spawn attempted after the abort throws `RunCancelledError` (exit 25), so the pipeline unwinds at its next step. This needed no signal parameter threaded through the pipeline's call sites.

Tests added: the retry (2), the cancel scope against a real child process (1), `osa_cancel` on a stuck run and on a run parked at the gate (2), and tool-list assertions updated in three files. Last full run: 1269 tests, the only failure was a hard-coded tool list that did not know `osa_cancel`; fixed.

## Still to do

### 2. Resume a build that was interrupted part-way (not started)
The restart-at-the-gate case is done (1h). What is still lost: a run whose **build had begun** when the server stopped, a laptop slept or a crash hit. It shows as `interrupted` and the only advice is "start again with `osa_plan`", which repeats the research and spec and the phases already built.
- It is deliberately not offered from the gate: once `build_started` is in the events the repository has moved on (phase commits), so approving the same spec again would start the driver on a half-built tree.
- Per-phase handoff records and commits exist, so the driver could continue from the last completed phase. Needs a design for what "last good phase" means after a partial one (a phase with commits but no hand-over record, a reviewer verdict not yet written).
- The CLI's `--from-spec` is still disabled (it needs a way to name the run); the MCP path is the only way in today.
- A resumed run re-reads `osa.config.json` and re-resolves its seats (the `seats` echo shows which), so the build can use different seats from the research and spec if the file changed in between.

### 3. Resume an interrupted research or spec run (not started)
The other half of resume. A run lost **before** it reaches the approval gate (server restart, sleeping laptop, a hung or timed-out spec call, a crash during research) shows as `interrupted`, and the only advice is "start again with `osa_plan`". That throws away up to 15 to 20 minutes of research and spec. The gate case (1h) does not help here: `resume-state.json` is only written once the gate is reached, so there is nothing saved to carry on from.
- **What already exists.** The research stage skips items that finished before the interruption: results land in `runs/<id>/research/results/<slug>.json` and a re-run reports them as `resumed` (covered by `src/research/resume-kill.test.ts`, which hard-kills the stage mid-batch). So research is resumable at the stage level; nothing in the MCP flow calls it for an interrupted run.
- **What does not.** The spec stage has no skip: it writes the spec again. Intake is not repeated (the plan is already on disk), and the lock is idempotent.
- **To check first (not yet verified).** `osa_spec` on an interrupted run's `run_id` may already pass its guards (no job, no `mcp-result.json`) and re-run the pipeline under the same run id, which would pick up the finished research items for free. If it does, a first slice is mostly honest messaging: `osa_status` for such a run should say "call `osa_spec` again with the same plan to carry on; finished research is kept" instead of "start again with `osa_plan`", plus a test that kills a run mid-research and shows the second `osa_spec` skips what finished.
- **Further slices.** Skip the spec stage when a complete spec already exists and matches the locked PRD; save progress marks after each stage (research done, spec written, agents done) so a run lost late in the agents stage does not redo the spec; make a hung spec call recoverable (see the sleep and timeout observation below), since that is the most common way a run is lost here.
- **Cautions.** A re-run re-reads `osa.config.json` and re-resolves its seats (the `seats` echo shows which). The repository can change between attempts, so the guard that matters is the locked PRD hash, as for the gate resume. Related to item 2 (build part-way) and the cloud idea (item 5).

### 4. Smaller observations
- **Sleep and network loss.** A sleeping laptop stalls child processes and triggers the 15-minute text-call timeout; a spec call timed out after 2.6 hours. Related to item 5 below.
- **CLI `doctor` has no `--repo-dir` or `--only`.** It runs against the current directory, unlike the MCP tool, which takes `repo_dir`.
- **`dist/` goes stale.** `doctor` reports it; the MCP serves `dist/`, so changes are invisible until `npm run build`.
- **One run per repository, with a lock.** Reasonable, but a cancelled or crashed run can leave the lock to be cleared by hand; worth checking that cancel releases it in every path.

### 5. NEW: run on the cloud or locally (to be specced by OSA)

**The idea, in the owner's words:** processes should run on the cloud in case I ever disconnect, but it can also run locally.

**Why:** a build takes 30 to 60 minutes after 15 to 20 minutes of research and spec. It currently lives in the MCP server process on one laptop. Closing the lid, losing Wi-Fi or restarting the server stalls or kills it (hit repeatedly in the real runs), and the only recovery today is starting over. Resume (item 2) softens that; cloud execution removes it.

**What it should be (intent, not a design):**
- An execution mode per run: `local` (today's behaviour, the default) or `cloud`.
- A cloud run keeps going when the laptop sleeps or disconnects. The person can reconnect later, from any session, and use `osa_status` / `osa_cancel` / `osa_build` against it.
- Same pipeline, same gates, same results: plan, spec, approval, build, final check. The person still approves the spec; only where the work executes changes.
- The result comes back to the person's repository (a branch or pull request) rather than staying in a remote sandbox.

**Open questions for the spec (deliberately not answered here):**
1. Where does a cloud run execute? Options to weigh: Claude Code's own remote/cloud sessions, a container the user hosts, or a CI job (for example GitHub Actions). Each differs in cost, setup and how it authenticates to the provider CLIs.
2. How does the run get the repository, and how does it hand work back (push a branch, open a PR)? What about repos with no remote, like a local-only project?
3. Credentials: how do the provider CLIs authenticate remotely without the person's machine, and where do API keys live? Nothing secret should be written into the run's files or events.
4. State: `.osa/` run files, the lock and the chat log are local today. Does a cloud run own them, and how does `osa_status` read them from elsewhere?
5. How does `osa_cancel` reach a remote run?
6. Mixed use: can a run start locally and move to the cloud (or the reverse) when the person is about to disconnect?
7. Cost and limits: does the person need to be told before a run goes to the cloud?
8. Failure behaviour when the cloud is unreachable: fall back to local, or refuse?

**Suggested first request to OSA (paste into `osa_plan`):**
> Add an execution mode to OSA so a run can execute on the cloud or locally. Local stays the default. A cloud run must keep going if the person's laptop sleeps or disconnects, and the person can reconnect later and use osa_status, osa_cancel and osa_build on it. The result must come back to their repository as a branch or pull request. Same pipeline and the same approval gates in both modes. Work out where a cloud run should execute, how it authenticates to the provider CLIs, how it gets the repository and returns work, and how status and cancel reach it. Depends on, and should reuse, the cancel mechanism in src/util/exec.ts (runCancelScope) and the resume work in docs/osa/IMPROVEMENTS.md item 2.
