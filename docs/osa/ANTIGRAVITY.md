# Antigravity dispatch -- repro, root cause, fix, and what is still unverified

## 1. Reproduction (done first, per the directive)

Machine: `agy` **1.3.3**, Windows 11, Node 24.15. (The adapter was originally built and its `--print=` flag shape
verified against `agy` **1.1.27** -- commits `5f540be`, `f2aa815`, `7015116`.)

Using the adapter's own invocation (a text call, which never skips permissions and offers no extra tools):

```
agy --input-format stream-json --output-format stream-json --disable-slash-commands --effort low \
    --print-timeout 90000ms --print=
stdin: {"event":"user","message":{"content":"Reply with exactly the single word OK and nothing else."}}
```

Observed: exit code **0**, the model answered `OK`, the stream was well-formed -- and the adapter reported

```
antigravity-cli reported result status undefined
```

i.e. a successful call was classified as a failure. The same defect applies to build **turns**, because
`interpretResult` is shared: every Antigravity turn on 1.3.x would have been recorded as failed.

## 2. Root cause

The shape of the terminal `result` event changed between CLI versions.

| agy | `result` event |
|---|---|
| 1.1.x (what the adapter was written for) | `{"event":"result","status":"SUCCESS", ...}` -- fields directly on the event |
| **1.3.3 (installed)** | `{"event":"result","result":{"conversation_id":"...","status":"SUCCESS","response":"OK\n","duration_seconds":3.9,"num_turns":1,"usage":{...}}}` -- fields **nested under `result`** |

`interpretResult` read `event["status"]` -> `undefined` -> "not SUCCESS". Related 1.3.3 facts captured from the
real stream: `init` carries `permission_mode: "request-review"` and a 59-entry `tools` list (including
`search_web`, `read_url_content`, `run_command`); the answer is also streamed as `step_update` events with
`step_type: "agent_response"` and a `text_delta`; `--effort` now accepts `low|medium|high|xhigh|max` (the adapter
still emits only `low`/`high`, which remain valid).

## 3. Fix (in the provider adapter, `src/adapters/antigravity-cli.ts`)

- `resultPayload(event)` returns the merged fields of a `result` event whichever shape it has (nested wins).
  `interpretResult` and `interpretTextResult` both read through it, so failures keep their real `status` and
  `error` (`WAITING`, `ERROR`, ...) in the message/details.
- `interpretTextResult` takes the answer from `result.response`, then the `agent_response` step deltas, then the
  legacy flat fields.
- Nothing about the invocation changed: `--print=`, NDJSON stdin and the pinned flags are exactly as before.

## 4. Verification

| Check | Result |
|---|---|
| Regression test using the **verbatim captured 1.3.3 stream** (`AGY_1_3_3_STDOUT`) | passes; it fails on the old code |
| Flat 1.1.x shape still accepted; non-SUCCESS (`WAITING`, `ERROR`) still failures; SUCCESS + non-zero exit still a failure | unit tests pass |
| **Live**, real binary, after the fix: text call -> `{"ok":true,"text":"OK\n"}` | verified 2026-10-17; reproducible with `AGY_LIVE=1 node --test src/adapters/antigravity-cli.test.ts` |
| `osa doctor --providers` / MCP `doctor` for `agy` 1.3.3 | healthy: in range, authenticated (subscription OAuth) |

## 5. NOT verified here: a real build turn (manual smoke test required)

A build turn differs from the verified text call in exactly one flag, `--dangerously-skip-permissions` (so agy may
edit files and run `git`), plus a much longer prompt. In this session the environment's auto-mode permission
classifier **refused** to launch `agy` with that flag ("Create Unsafe Agents"); that decision was respected and not
worked around. The result-parsing fix is common to both modes and is covered by the captured-stream tests, but the
end-to-end turn behaviour on 1.3.3 (permission mode, that the agent actually edits and commits) is unconfirmed.

Run this yourself (creates and edits a throwaway repo under your temp directory only):

```
AGY_LIVE_TURN=1 node --test src/adapters/antigravity-cli.test.ts
```

It runs a real turn through the adapter, then asserts `hello.txt` exists with the right content, a commit
`add hello` exists, and `interpretResult` reports success. If it fails, the test output and
`.osa/chat-log/*.jsonl` (verbatim stdout/stderr) are the first things to read. Then confirm a whole
cross-provider phase with `osa doctor --providers` followed by an `osa` run whose `providers.pair` includes
`"antigravity"` (see `osa.config.json` -> `providers`).

## 6. Web search

`agy` 1.3.3 lists `search_web` and `read_url_content` among its tools, so Antigravity *may* be able to do
research. It is still declared `webSearch: false` in `TextCapabilities` because print-mode use of those tools
needs permission approval that a headless text call (which never skips permissions) cannot grant, and this was
not verified. Flip it only after a live check; until then research routes to a provider that has verified web
search (`research_routed` is logged). See `CONFLICTS.md` C-08.
