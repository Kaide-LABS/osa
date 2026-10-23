# Contributing to OSA

## Building and testing locally

```
npm ci
npm run check
```

`npm run check` runs, in order: `npm run typecheck` (`tsc -p tsconfig.json`, strict mode, zero
diagnostics required), `npm run test` (the full `node:test` suite), and
`node src/cli/main.ts doctor --boundary` (the hard-boundary scan). All three must pass before any
change is considered complete.

## Ground rules

- Node 24 runs the TypeScript directly (type stripping): no enums, no parameter properties, `.ts`
  import extensions. The only runtime dependencies are `zod` and `@modelcontextprotocol/sdk`.
- `child_process` is used in exactly one file (`src/util/exec.ts`); the boundary scan enforces this and
  the other rules listed in `src/verify/boundary-rules.ts`.
- A new optional feature gets one switch in `osa.config.json`, defaults to the safe setting, and runs none
  of its code when off.
- Decisions that depart from the brief are recorded in `docs/osa/CONFLICTS.md`.
