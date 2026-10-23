# OpenCode adapter

Verified against the installed **OpenCode v2.1.1** on 2026-10-23 (Windows 11). Everything below was run, not assumed.

```
opencode run --standalone --format json [--model provider/model#variant] [--auto]     prompt on stdin
```

| Fact | Evidence |
|---|---|
| The prompt can come from stdin, including 200 KB | `printf ... \| opencode run ...` and a 9000-line prompt both answered correctly |
| `--format json` prints one JSON event per line: `step_start`, `text`, `tool_use`, `step_finish` (with `reason`), `error` | captured streams are in `src/adapters/opencode-cli.test.ts` |
| The answer is the text of the **last** assistant message (text before a tool call is not the answer) | tool-use run: "I'll run that command", tool call, then the real answer |
| OpenCode runs shell and edit tools **without asking** by default, even without `--auto` | `echo hello-from-shell` executed with no flag |
| Tools can be removed with permission rules in the `OPENCODE_CONFIG_CONTENT` env var | with `bash` denied the model reported it had no shell; with `edit`/`write` denied likewise; the plan agent (`--agent plan`) also refuses edits |
| `opencode models --standalone` lists every usable `vendor/model`; without `--standalone` it failed ("Location plugins did not finish activating") | 40+ lines on this machine |
| `opencode auth list` prints `<name>  <id>  stored` per login | used for the auth probe |
| `websearch` answered "Web search cancelled" in every headless run, with the permission set to allow; `webfetch` worked | so OSA does **not** claim web search for OpenCode |
| A billing failure is an `error` event (`credit balance is too low ...`) and exit 1 | seen with this machine's credit-less Anthropic key |
| The built-in JS sandbox tool `execute` has `fetch`, so a read-only text call denies it too | listed in the tool names the model reported |

OSA's text calls deny `edit`, `write`, `task`, `subagent`, `question`, `websearch`, `webfetch`, `execute` and (unless the call must run the
built project) `bash`/shell. A build turn uses `--auto`. Each call uses `--standalone` so it never shares state with the background service.

Not verified: a paid-model run through OSA end to end (this machine's only OpenCode login has no credit; the free `opencode/*` models were used
for the probes). The free tier also rejected a config that denied `read` ("free tier can only be used from within OpenCode"), so OSA leaves
`read`, `glob` and `grep` allowed, as it does for Claude Code text calls.
