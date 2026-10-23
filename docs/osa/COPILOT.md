# GitHub Copilot CLI adapter: EXPERIMENTAL

**Not run against the real CLI.** The `copilot` on the author's PATH is only VS Code's installer shim ("GitHub Copilot CLI was not found"),
so this adapter was written from GitHub's documentation (docs.github.com, *Copilot CLI programmatic reference*, read 2026-10-23) and its
tests pin the invocation shape, not the CLI's behaviour. Treat it as a starting point until the smoke test below passes.

Invocation OSA builds:

```
copilot -p "Carry out the task given on standard input. Reply with the result only." -s --no-ask-user [--allow-all-tools | --deny-tool=shell --deny-tool=write --deny-tool=url] [--model=<model>]      (prompt on stdin)
```

Documented: `-p` runs one prompt and exits; `-s/--silent` prints only the answer; `--no-ask-user`; `--model=MODEL` (precedence: `--model`, then
`COPILOT_MODEL`, then settings); `--allow-all-tools`; `--deny-tool`; auth through `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`
(a fine-grained token with the "Copilot Requests" permission).

**Assumed, not documented:** that standard input is delivered to the agent when `-p` carries a short instruction (the docs mention piped input
for non-interactive use, community examples pipe command output with `-p`, but there is no statement of the contract). OSA never puts a prompt on
argv (Windows limits a command line to about 32 000 characters), so if this assumption is wrong every Copilot call returns an answer to the
one-line instruction only. Also assumed: the spelling and repetition of `--deny-tool`.

Smoke test once the real CLI is installed and signed in:

```
echo "The secret word is PINEAPPLE." | copilot -p "What is the secret word? Answer in one word." -s --no-ask-user
```

It must print `PINEAPPLE`. If it does not, the stdin assumption is wrong; the adapter then needs `--attachment=<file>` (documented for
non-interactive use) with the prompt written to a file by the caller, which a pure invocation builder cannot do today. Sign-in cannot be observed
from outside, so `osa doctor` reports Copilot as healthy only when one of the token variables is set.
