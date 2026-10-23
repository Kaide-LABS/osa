# examples/toy-build -- the wordcount toy build

A small, real, single-phase build (`wordcount.mjs`) meant to be driven end to end through
OSA, as a live demonstration of PRD §2's AC1/AC2/AC3. Every step below is either an
already-shipped `OSA` command or a single, already-standard `git`/`node` command -- no
bespoke script exists for this procedure.

Run every command below from this repository's own root (`C:\Users\hp\OSA`) unless a step
says otherwise.

## 1. Materialize the toy repository

Create a fresh directory **outside this repository** (never nested inside OSA's own working
tree), `git init` it, copy this directory's `loopr/` folder into it, and commit it as the toy
repository's own initial commit -- authored by you, the operator, not by either dispatched agent.

```
mkdir /path/to/toy-build-target
cd /path/to/toy-build-target
git init
git config user.email "you@example.com"
git config user.name "Your Name"
cp -r /path/to/OSA/examples/toy-build/loopr .
git add loopr
git commit -m "initial toy-build fixture"
```

## 2. Generate the run config

Copy `run-config.template.json` and fill in its two placeholders:

```
node -e "console.log(crypto.randomUUID())"
```

Use that value for `run_id`, and the absolute path of the directory you created in step 1 for
`repo_dir`. Save the result as, e.g., `toy-run-config.json`.

## 3. Preflight (recommended, not required)

From this repository's own root:

```
node src/cli/main.ts doctor --providers
```

Confirm both `claude-code` and `codex-cli` show `authenticated: true` before dispatching for real.

## 4. Dispatch

From this repository's own root:

```
node src/cli/main.ts run --config /path/to/toy-run-config.json --json
```

This runs against the toy repository via the config's own `repo_dir` field.

## 5. Collect evidence

From this repository's own root:

```
node src/cli/main.ts evidence --repo-dir /path/to/toy-build-target --run-id <the same run_id> --final-phase --json
```

A clean, genuinely continued, genuinely artifact-referencing run reports `"ok": true` with all three
of AC1, AC2, and AC3 `"satisfied": true`.
