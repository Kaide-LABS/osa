# OSA improvements log

Observations from a real build (PAU Muslim Ummah inventory module, two OSA runs, Haiku/Sonnet/Opus seats) and what has been done about them.
Branch: `fix/handoff-recovery` (from `origin/main`, v0.5.0). Nothing here is pushed or merged yet.

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

How `osa_cancel` works: the background job runs inside `runCancelScope` (`src/util/exec.ts`, an `AsyncLocalStorage` holding an `AbortSignal`). Every `runProcess` started in that context watches the signal and, on abort, kills its child's whole process tree (`taskkill /T /F` on Windows, because the provider CLIs sit behind a `cmd.exe` shim and `child.kill()` ends only the shim). A spawn attempted after the abort throws `RunCancelledError` (exit 25), so the pipeline unwinds at its next step. This needed no signal parameter threaded through the pipeline's call sites.

Tests added: the retry (2), the cancel scope against a real child process (1), `osa_cancel` on a stuck run and on a run parked at the gate (2), and tool-list assertions updated in three files. Last full run: 1269 tests, the only failure was a hard-coded tool list that did not know `osa_cancel`; fixed.

## Still to do

### 2. Resume an interrupted run (not started)
Today a run lost to a server restart, a sleeping laptop or a crash shows as `interrupted` and the only advice is "start again with `osa_plan`", which repeats 15 to 20 minutes of research and spec.
- The foundation is a stub: `fromSpec` in `src/osa/pipeline.ts` verifies the spec-gate hashes and then returns "TL;DR assembly not yet implemented", and the CLI's `--from-spec` is disabled with a matching message.
- Smallest useful slice: a run that reached the post-spec gate and then lost its in-memory gate (server restart). The spec files and `spec-gate.json` are on disk, so `osa_build` could rebuild the TL;DR from them and carry on to the build.
- A harder slice: resume a build part-way. Per-phase handoff records and commits exist, so the driver could continue from the last completed phase. Needs a design for what "last good phase" means after a partial one.

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
