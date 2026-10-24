# Research report -- OSA's intake/lock/spec gate internals and the reshaped one-shot plan/spec/build flow across CLI and MCP

Generated 2026-10-24T09:24:59.264Z by OSA. Researched by claude-code using its built-in web search. Time range: current repo state at 67e1961; reference material last 2 years.
Values marked [uncertain] could not be verified from a source the agent opened; they are repeated under *Open uncertainties*.

## Findings

### Official documentation: zod
*Find the OFFICIAL documentation for "zod": its current stable version, how it is installed or enabled, the API surface this build will use, and any breaking changes or pitfalls in the current repo state at 67e1961; reference material last 2 years.*

Zod is the official TypeScript-first schema validation library; the current stable line is Zod 4 (installed via `npm install zod`, zero dependencies, requires TypeScript 5.5+ with strict mode). For this build Zod 4 is already an allowed dependency and is the natural choice for validating MCP tool inputs, spec-gate.json, and PRD/assumption shapes, giving static `z.infer` types alongside runtime `.parse`/`.safeParse` validation. The main caution at repo state 67e1961 is Zod-3-to-4 breaking changes: unified `error` param (old `message`/`invalid_type_error`/`required_error`/`errorMap` deprecated or removed), two-argument `z.record`, deprecated `z.nativeEnum`/`.merge`/`z.promise`/`z.function`, and shifted `.default()`/optional and `z.coerce` input-type semantics. None of Zod's `z.enum` usage conflicts with the repo's `erasableSyntaxOnly` 'no TypeScript enums' rule, since `z.enum` is a runtime value, not a TS `enum` declaration.

**Key findings**
- Current stable version is Zod 4, with 4.6 noted as the latest available on the official site (as of fetch 2026-10-24).
- Installation is `npm install zod`; it has zero external dependencies, ~2kb gzipped core, works in Node.js and modern browsers, and is also published on jsr.io.
- Official docs state Zod requires TypeScript v5.5 or later with strict mode enabled.
- Zod 4 unified error customization under a single `error` parameter: `message` is deprecated, `invalid_type_error` and `required_error` are dropped entirely, and `errorMap` was renamed to `error`.
- `z.record()` now requires two arguments (key schema AND value schema); the single-argument form `z.record(z.string())` no longer works.
- `z.nativeEnum()` is deprecated; `z.enum()` is overloaded to accept enum-like inputs directly. `.merge()` is deprecated in favor of `.extend()`; `z.promise()` and schema-form `z.function()` are deprecated/changed.
- `.default()` behavior shifted: `z.string().default('x').optional()` now applies the default even on optional fields; `.prefault()` restores the old parse-the-default-as-input behavior.
- `z.coerce` schemas now have input type `unknown` instead of the coerced type, and missing coerced object keys error unless `.default()` is set.
- The `ZodType` base generic changed from three generics to two (`ZodType<Output, Input = unknown>`); the `Def` generic was removed and `z.ZodTypeAny` is no longer needed.
- String-format validators were promoted to top level (`z.email()`, `z.uuid()`, `z.ipv4()`, `z.cidrv4()`, etc.); `z.string().ip()` and `.cidr()` were dropped, chained `.email()/.uuid()` are deprecated.
- Zod 4 adds first-party JSON Schema conversion via `z.toJSONSchema()` and an `.overwrite()` transform that preserves the inferred type.
- Reported performance gains vs Zod 3: ~14x faster string parsing, 7x array, 6.5x object parsing.

**Recommendations**
- Author all schemas against the Zod 4 API: use the single `error` parameter for custom messages, not the removed `invalid_type_error`/`required_error` or deprecated `message`.
- Write every `z.record(...)` with both key and value schemas (e.g. `z.record(z.string(), SomeSchema)`) to satisfy the Zod 4 two-argument requirement.
- Validate MCP tool inputs and the spec-gate.json / assumption shapes with `z.object(...).safeParse(...)` and derive static types with `z.infer<typeof Schema>`, so refusals (wrong spec hash, risky assumption) can branch on `success`/`error` without throwing.
- Model the assumption `risk` field ('safe'|'risky'|'defaulted') and the scope field ('broad'|'narrow') as `z.enum([...])` literals — this is a runtime Zod value and does NOT violate the repo's `erasableSyntaxOnly` no-TS-enum rule; avoid `z.nativeEnum`.
- [removed by OSA: this line looked like an instruction aimed at an AI (governance)]
- Pin zod to the 4.x line and confirm the lockfile resolves to Zod 4 (not a stray Zod 3) before relying on the above signatures; add no other dependencies per the constraint.
- Avoid deprecated/removed APIs (`.merge`, `z.promise`, `z.string().ip()`, chained string-format validators, `z.ZodTypeAny` as a public type) to keep the code aligned with the stable v4 surface.

**current version:** Zod 4 (site lists 4.6 as latest)

**api surface**
- npm install zod
- z.object({...}) for MCP tool input / spec-gate / PRD assumption schemas
- z.string(), z.number(), z.boolean(), z.array(...)
- z.enum([...]) for risk ('safe'|'risky'|'defaulted') and scope ('broad'|'narrow') literals (runtime value, not a TS enum)
- z.literal(...) and z.discriminatedUnion(...) for tagged variants
- Schema.parse(data) / Schema.safeParse(data) returning { success, data | error } for refusal branching
- z.infer<typeof Schema> for static types
- z.record(keySchema, valueSchema) — two-argument form
- single `error` parameter for custom validation messages
- optional/default modifiers: .optional(), .default(x), .prefault(x)

**pitfalls**
- z.record single-argument form removed — must pass key and value schemas (breaking in v4).
- Error API changed: invalid_type_error/required_error removed, errorMap renamed to error, message deprecated — v3 code using these breaks or warns.
- z.nativeEnum deprecated; .merge deprecated (use .extend); z.promise and schema-form z.function deprecated/changed.
- `.default()` now applies through `.optional()` in v4, which can inject values where v3 omitted them — relevant to byte-for-byte PRD render/parse round trips; use .prefault() for old behavior.
- z.coerce schemas now have input type `unknown` and error on missing coerced keys unless .default() set.
- String-format methods moved to top level; z.string().ip()/.cidr() dropped and chained .email()/.uuid() deprecated.
- ZodType generics reduced to two (Output, Input); Def generic and z.ZodTypeAny removed — affects any code typing schemas generically.
- Requires TypeScript 5.5+ with strict mode; older TS will mis-infer.
- Do not confuse z.enum (allowed Zod runtime value) with TypeScript `enum` declarations, which the repo's erasableSyntaxOnly rule forbids.

*As of: 2026-10-24; Zod 4 (site shows 4.6 latest)*

**Sources**
- [Zod — Introduction (official docs)](https://zod.dev) (official-docs) -- "Zero external dependencies ... Tiny: 2kb core bundle (gzipped) ... Zod requires TypeScript v5.5 or later with strict mode enabled."
- [Zod v4 Migration guide / changelog (official docs)](https://zod.dev/v4/changelog) (official-docs) -- "z.record(z.string()) no longer works; you must specify both key and value schemas ... message param is deprecated; use error instead ... invalid_type_error and required_error dropped entirely."
- [Zod v4 changelog source (colinhacks/zod repo)](https://github.com/colinhacks/zod/blob/main/packages/docs/content/v4/changelog.mdx) (repo) -- "Official changelog source for the Zod v4 breaking changes and migration notes."


### Official documentation: @modelcontextprotocol/sdk
*Find the OFFICIAL documentation for "@modelcontextprotocol/sdk": its current stable version, how it is installed or enabled, the API surface this build will use, and any breaking changes or pitfalls in the current repo state at 67e1961; reference material last 2 years.*

This build is locked to the `@modelcontextprotocol/sdk` package, which is the MCP TypeScript SDK v1.x maintenance line implementing the MCP spec up to 2025-11-25. For an MCP server the build uses `McpServer` (from `@modelcontextprotocol/sdk/server/mcp.js`), `registerTool()` with a Zod raw-shape `inputSchema`, `StdioServerTransport` (from `@modelcontextprotocol/sdk/server/stdio.js`), and `await server.connect(transport)`; tool handlers return `{ content: [...] }`. The SDK's only required peer is zod (it imports from `zod/v4` internally but is backward-compatible with zod >=3.25), which fits the locked dependency set (zod + @modelcontextprotocol/sdk). Note a separate v2 now exists as split packages (`@modelcontextprotocol/server` / `@modelcontextprotocol/client`); it is NOT this package and must not be adopted, since the build forbids new dependencies.

**Key findings**
- Package name for this build is `@modelcontextprotocol/sdk` (the v1.x line); its current published stable version is 1.32.1 as of ~Oct 2026 per the npm registry listing (not directly openable).
- v1.x implements the MCP spec 'up to 2025-11-25' and is explicitly in maintenance mode; v2 (spec 2026-07-28) is a separate release shipped as `@modelcontextprotocol/server` and `@modelcontextprotocol/client`.
- v1.x 'continues to receive bug fixes and security updates for at least six months after the v2 release (2026-07-27)'.
- Install: `npm install @modelcontextprotocol/sdk zod` — zod is a required peer; the SDK 'internally imports from zod/v4 but maintains backwards compatibility with projects using Zod v3.25 or later'.
- Server imports are deep subpath ESM specifiers with `.js` suffix: `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';` and `import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';`.
- `registerTool(name, { description, inputSchema }, handler)` takes `inputSchema` as a Zod RAW SHAPE object (e.g. `{ paramName: z.string() }`), NOT a wrapping `z.object(...)`.
- Tool handlers are async and return `{ content: [{ type: 'text', text }] }` (also supports `image`/`audio` content and `isError: true`).
- Server lifecycle: `const server = new McpServer({ name, version }); const transport = new StdioServerTransport(); await server.connect(transport);`.

**Recommendations**
- Keep the dependency exactly as `@modelcontextprotocol/sdk` (v1.x); do NOT migrate to the v2 split packages `@modelcontextprotocol/server`/`@modelcontextprotocol/client`, as that would add/change dependencies, which the build forbids.
- Register the four tools (osa_plan, osa_spec, osa_build, osa_status) via `registerTool` passing `inputSchema` as a Zod raw shape (plain object of zod validators), not a `z.object()` wrapper.
- Return structured results from handlers as `{ content: [{ type: 'text', text }] }`; set `isError: true` for refusals (e.g. wrong spec hash, risky-without-accept) rather than throwing.
- Use the exact deep-import specifiers with the `.js` extension (ESM) to satisfy Node 22+/24 TypeScript type-stripping; bare `@modelcontextprotocol/sdk` has no root export for these classes.
- Keep zod at >=3.25 (or zod v4) to match the SDK's peer requirement; since zod is already an allowed dependency this needs no change.
- Put the tool descriptions (relay recommended questions, show TL;DR before osa_build, never self-set accept_risky_assumptions) in the `description`/annotations passed to `registerTool`.

**current version:** 1.32.1 [uncertain] (v1.x line of @modelcontextprotocol/sdk; npm page was not directly openable, value from registry search synthesis)

**api surface**
- import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
- import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
- new McpServer({ name, version })
- server.registerTool(name, { description, inputSchema: <zod raw shape> }, async (inputs) => ({ content: [{ type: 'text', text }], isError? }))
- await server.connect(transport)
- zod as peer dependency (>=3.25 or v4) for inputSchema validation

**pitfalls**
- Two distinct product lines exist: `@modelcontextprotocol/sdk` (v1.x, this build) vs the v2 split packages `@modelcontextprotocol/server`/`@modelcontextprotocol/client`; mixing them or 'upgrading' to v2 adds dependencies, which the build forbids.
- v1.x is in maintenance mode and will NOT gain 2026-07-28 spec features; security updates are only guaranteed ~6 months past the v2 release (through ~2026-07-27).
- `inputSchema` must be a Zod RAW SHAPE (plain object of validators), NOT a `z.object(...)` instance; passing a wrapped object is a common mistake.
- Imports require the `.js` extension on deep subpaths (ESM); omitting it or importing these classes from the bare package root fails under Node 22+/24 type-stripping.
- SDK imports `zod/v4` internally; a project pinned below zod 3.25 can break type/compat expectations.
- Exact latest v1 patch version could not be confirmed from an opened page (npm returned 403), so treat 1.32.1 as approximate and verify against the lockfile at 67e1961.

*As of: 2026-10-24 (SDK v1.x line; latest published v1 version reported as 1.32.1)*

**Sources**
- [MCP TypeScript SDK v1 documentation (overview/install)](https://ts.sdk.modelcontextprotocol.io/) (official-docs) -- "This documentation covers v1.x of the MCP TypeScript SDK, which implements the MCP spec up to 2025-11-25. ... npm install @modelcontextprotocol/sdk zod ... V2 is the current stable release with separate packages (@modelcontextprotocol/server and @modelcontextprotocol/client)."
- [MCP TypeScript SDK v1 quickstart (zod peer dependency)](https://ts.sdk.modelcontextprotocol.io/quickstart) (official-docs) -- "The SDK internally imports from zod/v4, but maintains backwards compatibility with projects using Zod v3.25 or later. ... implementing the 2025-11-25 MCP specification."
- [typescript-sdk v1.x docs/server.md (API surface)](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/docs/server.md) (official-docs) -- "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'; ... import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'; ... registerTool(... inputSchema: { paramName: z.string() } ...) ... return { content: [{ type: 'text', text: 'result' }] }; ... await server.connect(transport);"
- [typescript-sdk README (v1.x maintenance / v2 split)](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/README.md) (repo) -- "This is v1.x ... continues to receive bug fixes and security updates for at least six months after the v2 release (2026-07-27). ... v2 (the current stable release) ships as separate packages: @modelcontextprotocol/server and @modelcontextprotocol/client."
- [@modelcontextprotocol/sdk - npm (version listing)](https://www.npmjs.com/package/@modelcontextprotocol/sdk) (official-docs) -- "The latest version is 1.32.1 ... npm i @modelcontextprotocol/sdk (npm page returned 403 to the fetcher; version read from registry search synthesis)."


### Official documentation: Model Context Protocol
*Find the OFFICIAL documentation for "Model Context Protocol": its current stable version, how it is installed or enabled, the API surface this build will use, and any breaking changes or pitfalls in the current repo state at 67e1961; reference material last 2 years.*

This build depends on the v1.x line of the official MCP TypeScript SDK, published on npm as @modelcontextprotocol/sdk (current stable 1.32.2, Node >=18, zod as a peer dependency). That line implements the MCP specification up to revision 2025-11-25. It is installed with `npm i @modelcontextprotocol/sdk` and used by instantiating the high-level `McpServer`, registering each tool (osa_plan/osa_spec/osa_build/osa_status) via `registerTool(name, {description, inputSchema}, handler)` with zod schemas, and connecting over `StdioServerTransport`. The major pitfall is that the SDK has forked into a new v2 line published under different package names (@modelcontextprotocol/server / @modelcontextprotocol/client) implementing the newer 2026-07-28 spec; the PRD constraint pins @modelcontextprotocol/sdk, so the build must stay on v1.x and not drift to v2 APIs.

**Key findings**
- Latest stable @modelcontextprotocol/sdk is 1.32.2 ('Model Context Protocol implementation for TypeScript'), engines node >=18, with zod ^3.25 || ^4.0 as a required peer dependency (per registry.npmjs.org/@modelcontextprotocol/sdk/latest).
- The v1.x branch 'implements the MCP spec up to 2025-11-25'; v2 (@modelcontextprotocol/server, 2.3.1) implements the newer 2026-07-28 spec.
- MCP spec revision history in range: 2025-06-18 (initial), 2025-11-25 (stable), and a 2026-07-28 release candidate (later/out of the v1 line).
- High-level server imports: `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'` and `import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'` (verified in v1.x docs/server.md).
- registerTool signature in v1.x: server.registerTool(name, { title?, description, inputSchema, outputSchema? }, handler); inputSchema is a raw zod shape object e.g. `{ weightKg: z.number() }` (ZodRawShape), NOT a wrapping z.object().
- Server lifecycle: `const server = new McpServer({ name, version }); const transport = new StdioServerTransport(); await server.connect(transport);` (verified).
- A tool handler returns `{ content: [{ type: 'text', text: ... }], structuredContent? }`; structuredContent pairs with outputSchema.
- The low-level Server class is reachable via `server.server` and supports setRequestHandler for custom request types; v1.x also keeps a standalone low-level `Server` class.
- v1.x receives bug/security fixes for at least six months after v2's release (through 2026-07-27).

**Recommendations**
- Stay on the @modelcontextprotocol/sdk v1.x line (1.32.x) as the PRD constrains; do NOT migrate to @modelcontextprotocol/server / @modelcontextprotocol/client v2 packages or 2026-07-28 spec APIs — that would add/rename a dependency and break the pin.
- Register the four tools (osa_plan, osa_spec, osa_build, osa_status) through McpServer.registerTool with zod ZodRawShape inputSchema objects, not z.object(...) wrappers, matching the v1.x high-level API.
- Connect over StdioServerTransport via server.connect(transport); use the documented subpath imports ('.../server/mcp.js', '.../server/stdio.js') since the package ships ESM subpath exports and bare 'index' imports will not resolve the server/stdio classes.
- Keep concrete transport/network usage inside the allowed boundary (src/research/net/**) and model names in src/adapters/**; the SDK's own transport is stdio local IPC, not outbound network, so it is fine in the MCP surface layer.
- Put tool-relay guidance (relay recommended questions as highly recommended, show TL;DR before osa_build, never set accept_risky_assumptions) in the registerTool `description` strings, which are the client-visible surface.
- Pin zod to the version already in the repo within the ^3.25 || ^4.0 peer range; do not bump it independently of the SDK to avoid peer-dep mismatch.

**current version:** @modelcontextprotocol/sdk 1.32.2 (v1.x line, implementing MCP spec 2025-11-25)

**api surface**
- new McpServer({ name, version }) — from '@modelcontextprotocol/sdk/server/mcp.js'
- server.registerTool(name, { title?, description, inputSchema, outputSchema? }, async handler) — inputSchema is a zod ZodRawShape object
- handler return shape { content: [{ type: 'text', text }], structuredContent? }
- new StdioServerTransport() — from '@modelcontextprotocol/sdk/server/stdio.js'
- await server.connect(transport)
- Low-level: server.server / Server class with setRequestHandler(RequestSchema, handler) for custom protocol handling

**pitfalls**
- Package fork: v2 is published as @modelcontextprotocol/server and @modelcontextprotocol/client (2026-07-28 spec); accidentally depending on these breaks the PRD pin to @modelcontextprotocol/sdk.
- v1.x registerTool inputSchema expects a raw zod shape ({ field: z.number() }) — passing a wrapping z.object(...) is a common mistake and differs from some v2/third-party examples that use z.object.
- ESM subpath imports required: McpServer and StdioServerTransport live at '/server/mcp.js' and '/server/stdio.js'; importing from the package root does not expose them.
- zod is a peer dependency, not bundled — version must satisfy ^3.25 || ^4.0; a mismatched local zod causes schema validation/type errors.
- v1.x is maintenance-only with security fixes for ~6 months after v2 (through ~2026-07-27); long-term it is a legacy line, though acceptable for this pinned build.
- The SDK pulls many transitive deps (express, hono, jose, ajv, etc.) for HTTP/auth transports; the build only needs the stdio path, so avoid importing HTTP transport modules to keep boundary rules clean.

*As of: @modelcontextprotocol/sdk 1.32.2; MCP spec 2025-11-25; checked 2026-10-24*

**Sources**
- [@modelcontextprotocol/sdk latest package metadata (npm registry)](https://registry.npmjs.org/@modelcontextprotocol/sdk/latest) (official-docs) -- ""version": 1.32.2 ... Engines Node >=18 ... Peer Dependencies zod: ^3.25 || ^4.0 (required)"
- [modelcontextprotocol/typescript-sdk (official repo, main/v2 overview)](https://github.com/modelcontextprotocol/typescript-sdk) (repo) -- "v1.x: @modelcontextprotocol/sdk (legacy) ... v2 implements the newer 2026-07-28 specification ... Package names changed from @modelcontextprotocol/sdk to split packages"
- [MCP TypeScript SDK v1.x docs/server.md](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/docs/server.md) (official-docs) -- "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'; import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'; ... server.registerTool('calculate-bmi', { ... inputSchema: { weightKg: z.number() } }, async ... ) ... await server.connect(transport)"
- [MCP TypeScript SDK v1.x branch overview](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x) (repo) -- "implements the MCP spec up to 2025-11-25 ... High-level McpServer class ... Low-level Server class ... via setRequestHandler ... requires zod as a peer dependency (v3.25+)"
- [Releases / spec version timeline (modelcontextprotocol)](https://github.com/modelcontextprotocol/modelcontextprotocol/releases) (official-docs) -- "2025-06-18 initial revision; 2025-11-25 stable; 2026-07-28 release candidate"


### Official documentation: Node.js
*Find the OFFICIAL documentation for "Node.js": its current stable version, how it is installed or enabled, the API surface this build will use, and any breaking changes or pitfalls in the current repo state at 67e1961; reference material last 2 years.*

This build targets Node.js 22+/24 and runs TypeScript via Node's built-in type stripping with the erasableSyntaxOnly discipline, so the Node facts that matter are the native TypeScript support surface and its restrictions. Type stripping is stable and enabled by default on both LTS lines the repo supports (default-on since v22.18.0 / v23.6.0; marked stable in v24.12.0 and v25.2.0), replaces type syntax with whitespace and does no type checking, and does not read tsconfig.json. Node's unsupported-syntax rules exactly match the brief's constraints: enums, parameter properties, namespaces with runtime code, and import aliases throw ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX, which is precisely what erasableSyntaxOnly in tsconfig prevents at the TypeScript level. The current 'Current' release is Node 26, where --experimental-transform-types was removed, so nothing in this build may rely on transform-only features.

**Key findings**
- Current/Current-stable release line is Node.js 26.0.0 (released April 2026, scheduled to enter LTS October 2026); the active LTS lines this repo targets are Node 24 'Krypton' and Node 22 'Jod'.
- Native TypeScript type stripping (--experimental-strip-types) was introduced in v22.6.0, became enabled by default in v22.18.0 and v23.6.0, and was marked stable in v24.12.0 and v25.2.0.
- Type stripping replaces TypeScript-only syntax with whitespace and performs NO type checking; type errors must be caught by a separate typecheck step (tsc --noEmit), not by Node.
- Type stripping does NOT read tsconfig.json; compiler options like erasableSyntaxOnly apply to your own tsc typecheck pass, not to Node's runtime behavior.
- Unsupported syntax that throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX under type stripping: enums, parameter properties, namespaces containing runtime code, and import aliases (import X = require). Type-only namespaces are allowed.
- WebAssembly support is required for type stripping; there is no non-Wasm fallback.
- tsconfig 'erasableSyntaxOnly' (TypeScript 5.8+) is the recommended guard that makes tsc reject exactly the non-erasable constructs Node's type stripper cannot handle — a clean match for this repo's constraint.
- --experimental-transform-types was added in v22.7.0 and REMOVED in v26.0.0; relying on transform-only features (e.g. enums compiled to runtime code) is therefore unavailable on current Node.
- Node is moving to one major per year starting with v27 (Alpha Oct 2026, 27.0.0 April 2027); every line becomes LTS, ending the odd/even distinction. [uncertain]

**Recommendations**
- Keep erasableSyntaxOnly: true (and noEmit, verbatimModuleSyntax, module: nodenext, target: esnext) in tsconfig so the typecheck pass rejects enums/parameter properties/runtime namespaces before they ever reach Node — this is what makes the brief's 'no enums, no parameter properties' constraint enforceable.
- Treat 'npm run check' typecheck as the only type-error gate: because Node strips types without checking, the test run alone cannot catch type errors — the tsc pass must stay in the green-check pipeline.
- Do not introduce any TypeScript construct requiring code generation (enums, parameter properties, runtime namespaces, import aliases, decorators); use plain const objects/unions instead of enums.
- Do not depend on --experimental-transform-types anywhere; it is gone in Node 26, and the build's stated runtime is type stripping only.
- Pin CI/local to a Node version where strip-types is default-on and stable (Node 24 LTS is the safest target; Node 22.18+ also works); avoid versions below v22.18.0 where it is not default.
- Use node: prefixed core modules (node:child_process confined to src/util/exec.ts, node network modules confined to src/research/net/**) consistent with boundary rules B1–B12; these are stable Node APIs on 22/24.

**current version:** Node.js 26.0.0 (Current); Node.js 24 'Krypton' and 22 'Jod' are the active LTS lines this build targets

**api surface**
- node <file>.ts — built-in type stripping to run TypeScript without a separate transpile step (default-on in v22.18+/v24)
- --no-strip-types — flag to disable type stripping (NOT used by this build)
- tsconfig.json compilerOptions: erasableSyntaxOnly, noEmit, verbatimModuleSyntax, module=nodenext, target=esnext (for the tsc typecheck pass only)
- node:child_process (confined to src/util/exec.ts per B1–B12)
- node: core network modules (confined to src/research/net/** per boundary rules)
- ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX — runtime error thrown for non-erasable syntax

**pitfalls**
- Type stripping does no type checking — a passing `node` run says nothing about type correctness; a dedicated tsc --noEmit step is mandatory.
- Node does not read tsconfig.json at runtime, so erasableSyntaxOnly only guards the typecheck pass; the two must stay in sync.
- Enums, parameter properties, runtime namespaces, and import aliases throw ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX under type stripping — exactly the constructs the brief forbids.
- --experimental-transform-types was removed in Node 26.0.0; any workaround that relied on transform (e.g. real enums) will not run.
- Type stripping requires WebAssembly with no fallback; constrained/embedded runtimes without Wasm cannot strip types.
- On Node <22.18.0 strip-types is not default-on, so forgetting to pin the Node version can produce 'cannot run .ts' failures in some environments.

*As of: 2026-10-24; Node.js 26.0.0 current, Node 24/22 LTS*

**Sources**
- [Modules: TypeScript — Node.js API Documentation](https://nodejs.org/api/typescript.html) (official-docs) -- "Type stripping ... Enabled by default (as of v23.6.0, v22.18.0) ... Does NOT support features requiring code generation (Enums, namespaces with runtime code, parameter properties, import aliases) ... erasableSyntaxOnly ensures only erasable syntax is used"
- [Evolving the Node.js Release Schedule / Node.js Releases](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule) (official-docs) -- "Node.js 26.0.0 was released in April 2026 and will enter LTS in October 2026 ... Node.js v24 (Krypton) and v22 (Jod) are currently in LTS status"


### Official documentation: TypeScript
*Find the OFFICIAL documentation for "TypeScript": its current stable version, how it is installed or enabled, the API surface this build will use, and any breaking changes or pitfalls in the current repo state at 67e1961; reference material last 2 years.*

For this build, TypeScript's relevant surface is the `erasableSyntaxOnly` compiler option, which the official TSConfig docs describe as causing TypeScript to error on TypeScript-specific constructs that have runtime behavior so that files can be run directly via Node.js type stripping. This exactly matches the build's constraint set (no enums, no parameter properties) — the option errors on enum declarations, namespaces/modules with runtime code, parameter properties, non-ECMAScript `import =`/`export =`, and prefix-style type assertions. As of October 2026 the current stable TypeScript line is 7.0 (the new native/Go-based compiler), with 6.0 (March 2026) being the last JavaScript-codebase release; erasableSyntaxOnly has been available since the 5.8 line and remains in 5.9/6.0/7.0. The build should pin a TypeScript version >= 5.8 (any of 5.9, 6.0, or 7.0 supports the flag), enable `erasableSyntaxOnly` together with `verbatimModuleSyntax`, and rely on `tsc --noEmit` for the typecheck in `npm run check`.

**Key findings**
- `erasableSyntaxOnly` (TSConfig flag `--erasableSyntaxOnly`) 'will cause TypeScript to error on most TypeScript-specific constructs that have runtime behavior' — official TSConfig reference page.
- Constructs that error under erasableSyntaxOnly: enum declarations; namespaces and modules with runtime code; parameter properties in classes; non-ECMAScript `import =` and `export =` assignments; `<prefix>`-style type assertions (official docs).
- Official docs example: `constructor(public x: number)` errors with 'This syntax is not allowed when erasableSyntaxOnly is enabled.' — confirms the build's 'no parameter properties' constraint.
- Official docs recommend combining erasableSyntaxOnly with `--verbatimModuleSyntax` to ensure proper import syntax and prevent import elision.
- Official docs: 'Node.js supports running TypeScript files directly as of v23.6' and only syntax that can be erased leaving valid JavaScript is supported — this is the type-stripping mode the flag guards.
- erasableSyntaxOnly was introduced in the TypeScript 5.8 line [uncertain] (the official TSConfig page itself notes it 'does not specify which TypeScript version introduced this feature').
- TypeScript 5.9 was announced August 1, 2025; install via `npm install -D typescript`; 5.9.3 patch released October 1, 2025.
- TypeScript 6.0 was announced March 23, 2026 and is 'the last release based on the current JavaScript codebase'; the compiler/language service is being rewritten in Go for 7.0.
- As of October 24, 2026, the typescript npm package has 7.1.0-dev builds dated 20261024, indicating the 7.0 line is the current stable release line and 7.1 is in development; the exact latest stable patch is 7.0.2 (July 8, 2026) [uncertain] — could not open npm versions page (HTTP 403).
- Install/enable: TypeScript is installed as a dev dependency via `npm install -D typescript`; the flag is enabled under `compilerOptions` in tsconfig.json as `"erasableSyntaxOnly": true`.

**Recommendations**
- Pin TypeScript at a version >= 5.8 so `erasableSyntaxOnly` is available; any of 5.9.x, 6.0.x, or 7.0.x works. Do NOT add TypeScript as a new runtime dependency — it is a build/dev tool only, consistent with the zod + @modelcontextprotocol/sdk dependency limit.
- Enable `"erasableSyntaxOnly": true` and `"verbatimModuleSyntax": true` in compilerOptions; this is what mechanically enforces the build's 'no enums, no parameter properties' rule at typecheck time.
- Run the typecheck as `tsc --noEmit` inside `npm run check`; TypeScript is used for type checking only, since the build runs TS directly via Node type stripping rather than emitting JS.
- Avoid, in all new code: enums (use `as const` object maps or union literals), namespaces with runtime code, constructor parameter properties, `import =`/`export =`, and `<T>`-prefix type assertions (use `as T`) — all are rejected by the flag.
- If adopting the 7.0 native compiler, validate that project tooling (test runner, boundary scan) still invokes the correct `tsc`; 6.0 introduced migration-oriented breaking changes (e.g. `--stableTypeOrdering`) ahead of 7.0 — stay on whatever version the repo already pins at 67e1961 unless a deliberate upgrade is in scope, which it is not for this build.
- Do not rely on Node type stripping requiring a specific flag assumption; the official docs tie unflagged direct execution to Node v23.6 — confirm the repo's actual Node target (22+/24) handles `.ts` execution as configured before assuming behavior.

**current version:** TypeScript 7.0 is the current stable line as of 2026-10-24 (native/Go-based compiler; exact latest patch 7.0.2, released 2026-07-08 [uncertain]). TypeScript 6.0 (2026-03-23) was the last JavaScript-codebase release; 5.9.3 (2025-10-01) is the final 5.9 patch. erasableSyntaxOnly is available in all lines from 5.8 onward.

**api surface**
- tsconfig.json compilerOptions: "erasableSyntaxOnly": true (errors on non-erasable TS syntax)
- tsconfig.json compilerOptions: "verbatimModuleSyntax": true (recommended companion to erasableSyntaxOnly)
- CLI: tsc --noEmit (typecheck used by npm run check)
- Install/enable: npm install -D typescript (dev dependency only)

**pitfalls**
- erasableSyntaxOnly rejects enum declarations, namespaces/modules with runtime code, class parameter properties, import =/export = assignments, and <prefix>-style type assertions — any such code in new build files fails the typecheck.
- The official TSConfig page does not state which version introduced erasableSyntaxOnly; it is the 5.8 line [uncertain] — a repo pinned below 5.8 would reject the option as unknown (observed as 'Unknown compiler option' errors in older tooling).
- TypeScript 6.0 is the final JavaScript-codebase release and introduced migration-oriented breaking changes (e.g. --stableTypeOrdering) ahead of the Go-based 7.0 rewrite; an unplanned version bump could change typecheck/diagnostic behavior — the repo's pinned version at 67e1961 should be respected, not upgraded, for this build.
- Node direct-execution of .ts relies on erasable-only syntax; the official docs cite Node v23.6 for direct support, so behavior on the build's Node 22 target must be verified rather than assumed.
- Could not open the npm versions page (HTTP 403), so the precise latest stable patch number is unverified from a primary source.

*As of: 2026-10-24; TypeScript stable line 7.0 (erasableSyntaxOnly docs current; TS 6.0 announced 2026-03-23, TS 5.9 announced 2025-08-01)*

**Sources**
- [TypeScript: TSConfig Option: erasableSyntaxOnly](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html) (official-docs) -- "The --erasableSyntaxOnly flag will cause TypeScript to error on most TypeScript-specific constructs that have runtime behavior ... enum declarations ... Parameter properties in classes ... Non-ECMAScript import = and export = assignments ... <prefix>-style type assertions."
- [Announcing TypeScript 5.9 - TypeScript DevBlog](https://devblogs.microsoft.com/typescript/announcing-typescript-5-9/) (official-docs) -- "TypeScript 5.9 ... install ... npm install -D typescript ... minimal tsc --init, import defer, --module node20."
- [Announcing TypeScript 6.0 - TypeScript DevBlog](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/) (official-docs) -- "TypeScript 6.0 is the last release based on the current JavaScript codebase ... a new codebase for the TypeScript compiler and language service written in Go ... TypeScript 7.0 is actually extremely close to completion."
- [typescript on npm (releasealert mirror)](https://releasealert.dev/npmjs/_/typescript) (other) -- "pre-release versions ranging from 7.1.0-dev.20260711.1 - 7.1.0-dev.20261024.1 (July 11 - October 24, 2026)."


### Official documentation: Node.js crypto
*Find the OFFICIAL documentation for "Node.js crypto": its current stable version, how it is installed or enabled, the API surface this build will use, and any breaking changes or pitfalls in the current repo state at 67e1961; reference material last 2 years.*

Node.js crypto is a core module (no install; import via `require('node:crypto')` or `import ... from 'node:crypto'`) that wraps OpenSSL. For this build's needs (prd_sha256 and the spec-gate manifest hash), the relevant surface is `crypto.createHash('sha256')` plus `hash.update(...)` and `hash.digest('hex')`. The module is Stability 2 - Stable and is the right primitive for the sorted-path + per-file-sha256 manifest hashing in acceptance criteria 6 and 7. No new dependency is needed since crypto ships with Node 22+/24, matching the build's dependency constraint.

**Key findings**
- crypto is a built-in Node.js core module; it requires no install and is imported with `require('node:crypto')` or `await import('node:crypto')`. The docs warn Node can be built without crypto support, in which case importing throws.
- Module stability is 'Stability: 2 - Stable'.
- `crypto.createHash(algorithm[, options])` returns a Hash object; algorithm is a string (e.g. 'sha256'), and available algorithms depend on the platform OpenSSL and can be listed via `crypto.getHashes()`.
- `hash.update(data[, inputEncoding])` accepts string | Buffer | TypedArray | DataView and can be called multiple times with new data.
- `hash.digest([encoding])` returns a Buffer by default, or a string when an encoding such as 'hex' is passed; it can only be called once — after calling digest() the Hash object cannot hash more data and a second digest() call throws.
- Documentation reviewed is current for Node.js v24.22.1 (LTS), within the build's Node 22+/24 target.

**Recommendations**
- Use `createHash('sha256').update(data).digest('hex')` to produce the hex sha256 strings for prd_sha256 and per-file hashes; this matches acceptance criteria 6/7 with no new dependency.
- Import from `node:crypto` (prefixed specifier) for clarity and to keep crypto usage explicit; this is a pure stdlib call with no network or child_process, so it does not touch boundary rules B1-B12.
- Build the spec-gate manifest deterministically: sort file paths, hash each file, then hash the concatenation of sorted-path + per-file-sha256 — feed a single stable, canonical byte sequence into one Hash instance (or concatenate per-file digests) so the result is reproducible across runs and platforms.
- Create a fresh Hash per digest; do not reuse a Hash object after calling digest() (it throws), and do not rely on mutating a shared hasher across files.
- Normalize inputs before hashing (consistent string encoding, e.g. explicit 'utf8' on update for string data, and consistent newline/path separators) so the byte-for-byte round trip in criterion 4 and cross-platform Windows/Linux hashes stay equal.

**current version:** Node.js v24.22.1 (LTS); crypto is a core module versioned with Node, Stability 2 - Stable

**api surface**
- require('node:crypto') / import from 'node:crypto'
- crypto.createHash('sha256') -> Hash
- hash.update(data[, inputEncoding])
- hash.digest('hex')
- crypto.getHashes() (to confirm 'sha256' availability if needed)

**pitfalls**
- hash.digest() can be called only once; calling it again, or calling update() after digest(), throws — create a new Hash per file/manifest.
- crypto can be absent if Node is built without OpenSSL support; importing then throws (edge case, not typical for standard Node 22/24 builds).
- digest() returns a Buffer unless an encoding ('hex') is given — omitting the encoding yields a Buffer, which would not match an expected hex string.
- Available algorithms depend on the platform OpenSSL; rely on standard 'sha256' and avoid platform-specific digests to keep hashes reproducible.
- String inputs are encoded per inputEncoding (default utf8); inconsistent encodings or OS-specific path separators/newlines across platforms produce different hashes — normalize inputs for the byte-for-byte round trip and cross-platform determinism.

*As of: Node.js v24.22.1 (docs reviewed 2026-10-24)*

**Sources**
- [Crypto | Node.js v24.x Documentation](https://nodejs.org/dist/latest-v24.x/docs/api/crypto.html) (official-docs) -- "crypto.createHash(algorithm[, options]) ... Returns a Hash object ... Once hash.digest() method has been called, the Hash object can no longer be used to hash additional data."
- [Crypto | Node.js Documentation (crypto.html)](https://nodejs.org/api/crypto.html) (official-docs) -- "It is possible for Node.js to be built without including support for the node:crypto module. In such cases, attempting to import from crypto or calling require('node:crypto') will result in an error being thrown. ... Stability: 2 - Stable"


### Official documentation: Node.js test runner
*Find the OFFICIAL documentation for "Node.js test runner": its current stable version, how it is installed or enabled, the API surface this build will use, and any breaking changes or pitfalls in the current repo state at 67e1961; reference material last 2 years.*

The `node:test` module (the built-in Node.js test runner) is marked Stability 2 - Stable since Node v20.0.0 and is available without any dependency install; it is imported only via the `node:test` scheme (e.g. `import { test, describe, it, mock } from 'node:test'`). For this build on Node 22+/24, the relevant surface — `test`/`it`/`describe`/`suite`, lifecycle hooks (`before`/`after`/`beforeEach`/`afterEach`), the `mock` object (notably `mock.fn()` for the fake textCall seam), `assert`, and the programmatic `run()` API with built-in reporters — is all stable in that version range. `npm run check` can drive it through the `node --test` CLI flag or a programmatic `run()` call, with code coverage still gated behind the experimental `--experimental-test-coverage` flag.

**Key findings**
- `node:test` is Stability: 2 - Stable as of Node.js v20.0.0 (initial release v18.0.0, backported to v16.17.0); confirmed on the latest docs page (v26.x) which still shows Stability 2 - Stable.
- The module is ONLY available under the `node:` scheme: `import test from 'node:test'` or `const test = require('node:test')`; a bare `'test'` specifier does not resolve.
- Core API: `test([name][,options][,fn])`, `it` (alias of test), `describe`/`suite`, each with `.skip()`, `.todo()`, `.only()` variants.
- Lifecycle hooks: `before`, `after`, `beforeEach`, `afterEach`.
- Mocking (stable): top-level `mock` object with `mock.fn()`, `mock.method()`, `mock.getter()/setter()`, `mock.module()`, `mock.reset()`, `mock.restoreAll()`, plus `mock.timers`; `MockTracker` assertion helpers like `context.assert.calledWith`-style exist.
- Programmatic `run([options])` returns a stream; key options include `files`, `concurrency`, `isolation` ('process' default | 'none'), `timeout`, `watch`, `coverage`, `testNamePatterns`.
- CLI flags: `--test`, `--test-name-pattern`, `--test-only`, `--test-reporter` (spec|tap|dot|junit|lcov), `--test-reporter-destination`, `--watch`; coverage via `--experimental-test-coverage`.
- Built-in reporters importable from `node:test/reporters`: `spec` (default), `tap`, `dot`, `junit`, `lcov`.
- Test fails => process exit code 1; subtests must settle before parent completes.
- Snapshot testing stabilized around v23.4.0 (added v22.3.0); global setup/teardown added v24.0.0; test tags/randomization added in v26.x — these are newer than the Node 22/24 baseline and should not be relied on. [uncertain: exact snapshot-stable version]

**Recommendations**
- Use only the stable surface guaranteed on Node 22 LTS / 24: `test`/`it`/`describe`, the four lifecycle hooks, `mock.fn()` for the fake textCall seam, `assert` (node:assert), and either `node --test` or programmatic `run()` — all available with zero extra dependencies, satisfying the zod + MCP-SDK-only constraint.
- Drive the suite via `node --test` (or an npm script wrapping it) and pick a deterministic reporter for `npm run check`; the default `spec` reporter is fine for green/red.
- For the fake textCall seam, prefer `mock.fn()` / `mock.method()` and call `mock.reset()`/`mock.restoreAll()` (or `t.mock` on the test context) in `afterEach` to avoid cross-test leakage.
- Do NOT depend on `--experimental-test-coverage`, snapshot testing, global setup/teardown, test tags, or randomization as load-bearing for the acceptance criteria — coverage is Stability 1 (experimental) and the others are either experimental or only landed after the Node 22/24 baseline.
- Remember the `node:` prefix is mandatory; a plain `'test'` import will fail — ensure all test files import from `node:test`.
- Since tests throw to fail and exit non-zero, rely on process exit code 1 for CI gating rather than parsing reporter output.

**current version:** node:test is Stability 2 - Stable since Node.js v20.0.0; current docs reflect Node.js v26.x (v26.12.1). On the build's Node 22 LTS / 24 baseline the stable surface is fully available.

**api surface**
- import { test, it, describe, suite } from 'node:test'
- before / after / beforeEach / afterEach lifecycle hooks
- mock.fn() / mock.method() / mock.reset() / mock.restoreAll() (and t.mock on test context) for the fake textCall seam
- node:assert (strictEqual, deepStrictEqual, etc.) for assertions
- run([options]) programmatic runner ({ files, concurrency, timeout, isolation, testNamePatterns })
- CLI: node --test, --test-name-pattern, --test-only, --test-reporter=spec, --watch
- reporters from 'node:test/reporters' (spec default, tap, dot, junit, lcov)

**pitfalls**
- The `node:` prefix is mandatory; importing from bare `'test'` does not resolve to the runner.
- Code coverage is still Stability 1 - Experimental behind `--experimental-test-coverage`; do not treat it as stable in the check gate.
- Features such as snapshot testing (stable ~v23.4.0), global setup/teardown (v24.0.0), test tags and randomization (v26.1/26.2) landed after the Node 22 baseline — using them reduces portability across the supported 22/24 range.
- Subtests must be awaited/settled before the parent test completes or they may be orphaned and silently miss assertions.
- A failing test makes the process exit with code 1; relying on reporter text instead of exit code for CI gating is fragile.
- `isolation: 'none'` in run()/CLI shares a single process — mocks and globals can leak between files unless reset.

*As of: Node.js v26.12.1 docs (latest) / stable since v20.0.0; verified 2026-10-24*

**Sources**
- [Test runner | Node.js v26.x Documentation (latest)](https://nodejs.org/docs/latest/api/test.html) (official-docs) -- "The node:test module is marked as Stability: 2 - Stable (as of v20.0.0)."
- [Test runner | Node.js API Documentation](https://nodejs.org/api/test.html) (official-docs) -- "The module is only available under the node: scheme. ... run([options]) ... isolation: 'process' (default) or 'none'."


### Intake schema, baby PRD types and backstop
*How do intake.ts, baby-prd.ts (parseBabyPrd/renderBabyPrd, counts, applyRiskBackstop) and the BabyPrd zod schema fit together so scope, recommended_questions and the 'defaulted' risk can be added losslessly?*

The OSA repository and its internal modules (intake.ts, baby-prd.ts, the BabyPrd zod schema, and the parseBabyPrd/renderBabyPrd/counts/applyRiskBackstop functions) are not public or indexed: targeted searches for the project and these exact symbols returned nothing matching this codebase, and I have web tools only, so I cannot read the worktree at 67e1961 to describe how these files actually fit together [uncertain]. What is verifiable is the zod mechanics that make the three additions (scope, recommended_questions, the new 'defaulted' risk) losslessly addable: adding fields as optional-with-default is backward compatible, a fixed value set like risk is a z.enum you extend by adding a literal, and object parsing defaults to 'strip' (unknown keys dropped) so byte-for-byte round-trips require you NOT to rely on default-stripping and to preserve field order/formatting in renderBabyPrd. Treat the per-file interaction description as a design recommendation grounded in zod behavior, not as a verified reading of the repo.

**Key findings**
- Could not verify any OSA/baby-prd/intake/spec-gate source: web searches for 'OSA One-Shot Anything baby-prd intake spec-gate' and for the symbols 'applyRiskBackstop/renderBabyPrd/parseBabyPrd' returned only unrelated repos (optical-networks one-shot learning, baby-tracker parsers), indicating a private/unindexed codebase [uncertain].
- zod z.enum(['safe','risky']) extends to z.enum(['safe','risky','defaulted']) by adding the string literal; existing values keep validating, so the new 'defaulted' risk is additive and does not break prior parses (zod.dev/api).
- Adding an optional field with a fallback uses .default() (e.g. z.enum(['broad','narrow']) for scope, z.array(...).default([]) for recommended_questions); .parse(undefined) returns the default, so older PRDs lacking the field still parse (zod.dev/api).
- Zod object parsing defaults to 'strip' — unrecognized keys are removed from the output; z.strictObject() throws on unknown keys and z.looseObject() passes them through. For a byte-for-byte render->parse round trip, scope/recommended_questions/defaulted must be explicit known fields, not unknown keys that strip would silently drop (zod.dev/api).
- A per-question 'default' and a per-assumption risk value are separate concerns: recommended_questions[].default is the best-guess answer; an unanswered question becomes an assumption whose risk is 'defaulted'. Both can be modeled as optional-with-default without touching the existing 'safe'/'risky' branch (zod.dev/api; AC 3-5 of the brief).
- z.default() values must be assignable to the schema's output type, and string enum arrays need `as const` (or be passed inline) for literal-type inference — relevant if scope/risk value lists are declared as variables (zod.dev/api; colinhacks/zod issue #2738).

**Recommendations**
- Do not treat this research as a substitute for reading the actual files: open intake.ts, baby-prd.ts and the BabyPrd zod schema in the worktree at 67e1961 before implementing, because the wiring between them (who calls counts/applyRiskBackstop, what renderBabyPrd's exact text format is) is not verifiable from any public source.
- Model scope as z.enum(['broad','narrow']) and recommended_questions as z.array(questionSchema) where each question carries a default; keep both additive so a narrow prompt yields scope 'narrow' with an empty array (AC 2).
- Extend the risk enum to add 'defaulted' as a third literal alongside 'safe'/'risky'; do NOT reuse 'risky' for defaulted items, so applyRiskBackstop can be written to never upgrade 'defaulted' -> 'risky' (AC 5) and counts() can tally each value separately (AC 4).
- For the byte-for-byte render->parse round trip (AC 4), ensure every new field is a recognized schema key (avoid relying on strip to hide anything) and make renderBabyPrd emit the new fields in a stable, canonical order/format; verify with a round-trip test rather than trusting zod to preserve formatting — zod validates values, it does not preserve source bytes.
- Prefer .default([]) / .default(...) over bare .optional() where a missing field should become a concrete value, so downstream code (counts, backstop, TL;DR assembly) never has to branch on undefined.
- Avoid any new dependency and any new model call in this path (per locked constraints); all three additions are pure schema/serialization changes expressible with zod alone.

*As of: 2026-10-24; zod docs current as of this date, repo state unverified*

**Sources**
- [Zod — Defining schemas (API reference)](https://zod.dev/api) (official-docs) -- "Default (strip): unrecognized keys are stripped from the parsed result ... z.strictObject() throws on unknown keys ... z.looseObject() allows unknown keys to pass through"
- [z.enum with default give type incompatibility · Issue #2738 · colinhacks/zod](https://github.com/colinhacks/zod/issues/2738) (repo) -- "z.enum with a default value and TypeScript type inference interaction when the enum array is declared as a variable rather than inline/as const"
- [OSA networks one-shot learning (unrelated repo returned by search)](https://github.com/carlosnatalino/osa-networks-one-shot-learning) (repo) -- "One-Shot Learning for Modulation Format Identification in Evolving Optical Networks — the only 'OSA one-shot' repo surfaced, confirming the target codebase is not public"


### lockBabyPrd gate semantics
*What exact unattended/--yes/refused (exit 19)/accept-risky rules does lock.ts lockBabyPrd implement, and how can it be generalised into a gate over an arbitrary artifact+hash for reuse at the spec gate?*

The item asks for the exact exit-code-19 / --yes / accept-risky semantics currently implemented in OSA's src/*/lock.ts lockBabyPrd, and how to generalise them into a reusable artifact+hash gate for the new spec gate. This is private repository code (branch feat/spec-gate at 67e1961); I have web tools only and no file access, and web search surfaced no public source for OSA (One-Shot Anything), lock.ts, lockBabyPrd, baby-prd.md, or its exit-19 gate — the GitHub hits (Miosa-osa/OSA, aimclub/OSA, prd-os, etc.) are unrelated projects. I therefore cannot verify the current lockBabyPrd signature or branch logic from any source I opened; the exact-rules portion is unverifiable and the generalisation below is design inference from the locked brief itself, not from a cited source.

**Key findings**
- No public source for OSA's lock.ts / lockBabyPrd exists in web results; the repo is private, so the precise current semantics (signature, parameters, exit codes, branch order) cannot be verified from any opened source. [uncertain]
- The only authoritative description of the intended gate behaviour available to me is the locked brief's acceptance criteria 10-13, which define the *target* rules (wrong/mismatched hash refused; risky-without-accept refused in the same style; --yes + >=1 risky exits code 19 with a plain-language message; --yes with only defaulted/safe proceeds; --yes --accept-risky proceeds and records every risky/defaulted item; --accept-risky without --yes is a usage error; interactive gate shows TL;DR and asks y/N, 'no' exits cleanly keeping the run folder). These are requirements, not observations of current lock.ts. [uncertain]
- GitHub search returned no matching issue/PR documenting a behaviour change or bug for lockBabyPrd, so the github-debug module yields nothing citable for this symptom.

**Recommendations**
- Do NOT treat anything in this report as the ground truth for what lockBabyPrd currently does — read src/*/lock.ts directly in the worktree at 67e1961 and extract the real signature, the order of its guard checks, and the literal exit code / message strings before refactoring. The generalisation must preserve today's observable behaviour exactly (criterion 6: prd_locked and prd_integrity_verified unchanged; criterion 10: same refusal *style* as today).
- Generalise by extracting a single gate primitive that is independent of which artifact it guards. Suggested shape (adapt to the real code's conventions): a pure checkArtifactGate({ artifactPath, expectedHash, actualHash, assumptions, flags:{ yes, acceptRisky, interactive } }) -> a discriminated result union ('proceed' | 'refused-hash-mismatch' | 'refused-risky' | 'usage-error' | 'awaiting-confirmation'), with all process.exit / stdout side effects pushed to a thin caller wrapper so the decision logic is testable without a process.
- Keep the hash comparison artifact-agnostic: the PRD gate compares prd_sha256; the spec gate compares both prd_sha256 and the spec-gate hash (sha256 of the sorted-path + per-file-sha256 manifest, criterion 7). The primitive should accept one or more (name, expected, actual) hash pairs and refuse if ANY mismatches, reusing the same refusal path for both gates so criterion 10's 'same refusal style' holds for free.
- Encode the flag precedence once, in the primitive: --accept-risky without --yes => usage-error (criterion 12) must be rejected before any hash/risk evaluation; then hash mismatch => refuse; then (risky present && !acceptRisky) => exit 19 under --yes or the interactive refusal otherwise; defaulted/safe-only => proceed. Never let the gate itself set accept_risky (criterion 17).
- Preserve exit code 19 as a named constant shared by both gates, and route the 'plain-language message', 'keep the run folder', and 'print how to change direction' behaviours (criteria 11, 13) through the caller wrapper so both PRD-lock and spec-gate callers emit identical UX.
- Add no model call and no new dependency in the extracted primitive (constraints); keep it pure/deterministic so it can be unit-tested across safe/risky/defaulted assumption matrices, and ensure the backstop cannot promote 'defaulted' to 'risky' (criterion 5) lives outside this gate, upstream of it.
- Because the exact current rules are unverified here, if the real lock.ts contradicts the brief's assumed semantics, stop that phase and report exactly where (per the brief's final constraint) rather than coding to this report.

*As of: 2026-10-24*

**Sources**
- [Miosa-osa/OSA (unrelated: Elixir/Rust terminal agent, no lock.ts/lockBabyPrd)](https://github.com/Miosa-osa/OSA) (repo) -- "The codebase uses Elixir and Rust, not TypeScript ... contains no mentions of lock.ts or lockBabyPrd function, baby-prd.md, spec-gate, exit code 19 or accept-risky gate logic."
- [assafkip/prd-os (unrelated PRD/DSSE Claude Code plugin surfaced by search)](https://github.com/assafkip/prd-os) (repo) -- "Standalone PRD + DSSE execution plugin for Claude Code ... gates them through Codex review ... with scope enforcement and receipts."
- [aimclub/OSA issue #287 (unrelated OSA docstring exit-code bug)](https://github.com/aimclub/OSA/issues/287) (repo) -- "bug: Incorrect Exit Code Status during Docstring Generation"


### Pipeline stages, hashing and resume
*How does pipeline.ts sequence intake/lock/research/spec with stopAfterPlan and fromDraft, how is prd_sha256 computed/verified (prd_integrity_verified), and what resume support exists (research_validated 'resumed' count)?*

The question is about internals of a specific private/internal codebase (OSA / "One-Shot Anything", org Kaide-LABS) at commit 67e1961 on branch feat/spec-gate — specifically how src pipeline.ts sequences intake/lock/research/spec with stopAfterPlan and fromDraft, how prd_sha256 is computed and verified via prd_integrity_verified, and the research_validated 'resumed' resume path. I have web tools only and cannot read this repo's files; nothing about these exact symbols or flow is indexed anywhere on the public web. Targeted searches (including the github-debug approach) returned only unrelated projects that happen to share generic terms like 'one-shot', 'sha256', 'PRD' and 'resumed', none of which are this codebase. Therefore I cannot verify the actual sequencing, hashing scheme, or resume-count semantics from any source I opened, and the concrete answer must come from reading pipeline.ts (and its callers/tests) directly in the worktree rather than from research.

**Key findings**
- No public GitHub repo, issue, discussion, release note, or changelog for the OSA 'One-Shot Anything' project (Kaide-LABS) appears in web search; the identifiers pipeline.ts, prd_sha256, prd_integrity_verified, stopAfterPlan, fromDraft, spec-gate.json, and research_validated 'resumed' return zero matching results against this codebase [uncertain].
- Search hits for 'OSA' resolve to unrelated projects (Miosa-osa/OSA terminal agent, aimclub/OSA repo-quality tool, carlosnatalino optical-networks one-shot-learning), none of which implement the intake/lock/spec-gate flow described in the brief.
- Searches for the exact internal symbols ('prd_integrity_verified', 'stopAfterPlan', 'fromDraft', research_validated 'resumed') surfaced only generic third-party PRD/workflow issues (Vaquum/Limen, careeros, AI_Dev_Workflow) with superficially similar vocabulary but no shared code or design.
- General (non-OSA) reference pattern seen across those unrelated repos: a 'resumed' workflow that finds its plan/manifest missing parks or stops rather than silently re-planning, and integrity checks that fail admission when stored manifest content does not match — a convention the OSA resume/verify path may or may not follow [uncertain].

**Recommendations**
- Do not treat this item as answerable from web research: the sequencing of intake/lock/research/spec, the stopAfterPlan and fromDraft branch behavior, the prd_sha256 computation/verification backing prd_integrity_verified, and the research_validated 'resumed' count must be read directly from pipeline.ts and its tests in the worktree — read the file, do not infer.
- Determine prd_sha256 semantics from code, not assumption: confirm whether it is a plain sha256 of the locked PRD bytes and how prd_integrity_verified gates downstream phases, before relying on it for the spec-gate hash work in acceptance criteria 6–7.
- Keep the spec-gate hash distinct and verifiable: per criterion 7, the spec-gate hash must equal sha256 of the sorted-path + per-file-sha256 manifest of all spec files, and prd_sha256 must be stored alongside; derive both from reading the existing hashing helper rather than from any web pattern.
- For the resume path, verify in code how research_validated's 'resumed' count is incremented and under what re-run conditions (e.g., intake re-running once when answers are supplied per criterion 3), and preserve existing lock-test behavior (criterion 6) rather than reshaping it.
- Avoid importing external conventions: the unrelated 'park instead of re-plan' pattern from other repos is not evidence about OSA and should not drive design decisions here.

*As of: 2026-10-24*

**Sources**
- [Miosa-osa/OSA (unrelated terminal AI agent named OSA)](https://github.com/Miosa-osa/OSA) (repo) -- "An AI agent for your terminal, built on signal theory... works with any model."
- [aimclub/OSA (unrelated open-source quality tool named OSA)](https://github.com/aimclub/OSA) (repo) -- "Tool that just makes your open source project better using LLM agents."
- [paysdoc/AI_Dev_Workflow Issue #1078 (unrelated resume/park pattern)](https://github.com/paysdoc/AI_Dev_Workflow/issues/1078) (repo) -- "a resumed workflow whose plan is missing parks instead of re-planning"
- [Vaquum/Limen Issue #1082 (unrelated manifest-integrity pattern)](https://github.com/Vaquum/Limen/issues/1082) (repo) -- "Verify stored manifest content before admission"


### Deterministic spec-file manifest hashing
*What is a robust way to build a sorted-path + per-file-sha256 manifest of all spec files and hash it reproducibly across platforms for the spec-gate hash?*

The canonical, cross-platform-reproducible way to hash a set of files is the pattern used by Go's golang.org/x/mod/sumdb/dirhash.Hash1: compute the hex SHA-256 of each file's raw bytes, build one text line per file in a fixed format (hex-digest, two spaces, path, newline), sort those lines by path, concatenate them, and take the SHA-256 of that concatenation as the final manifest hash. For this build, read each spec file as a Buffer and hash the exact bytes with Node's crypto.createHash('sha256').digest('hex'), normalize every path to POSIX forward slashes and sort byte/code-point-wise before assembling the manifest, then sha256 the joined manifest string to produce the spec-gate hash. Determinism across Windows/Linux comes from the forward-slash normalization, the stable sort, a fixed line format, and hashing content as raw bytes rather than through any text decoding.

**Key findings**
- Node.js crypto (docs current as of v26.12.1) provides createHash('sha256'); you call hash.update(data[, inputEncoding]) and hash.digest('hex') to get a deterministic hex digest. The docs state the same input always produces the same output. Pass a Buffer to update() to hash exact bytes with no encoding ambiguity.
- Go's dirhash.Hash1 ('h1:' algorithm) is the reference design: for each file it emits a line of `<hex-sha256-of-file-content><two spaces U+0020><name><newline U+000A>`, sorts by file name, concatenates the lines into a summary, then SHA-256-hashes that summary (equivalent to `sha256sum $(find . -type f | sort) | sha256sum`). Our spec-gate hash is this inner->outer construction, differing only in output encoding (hex vs base64).
- dirhash.Hash1 constraints: file names containing a newline (U+000A) are disallowed (they would corrupt the line-oriented summary), and names always use forward slashes even on Windows.
- The Dirhash Standard (andhus/dirhash) confirms the cross-platform rules: entries are sorted before hashing, paths are normalized to the unix standard with forward slash '/' separating directories, and file content is hashed first with its hex digest becoming the value fed into the summary (indirection), rather than raw bytes being concatenated inline.
- Sorting must be on the normalized path bytes/code points (byte-wise / C-locale), not a locale-aware collation, so that order is identical on every platform. For ASCII spec paths JavaScript's default Array.sort (UTF-16 code-unit order) matches byte order; for non-ASCII paths a UTF-8 Buffer.compare keeps it equal to byte-wise sort.
- Reproducibility depends on three things being pinned: the exact set of files included, the path normalization (relative-to-spec-root + path.sep -> '/'), and hashing content as raw bytes. CRLF vs LF differences in a file's on-disk bytes will change that file's content hash, so line endings must be consistent in the committed spec files (hash the bytes as-is; do not re-normalize at hash time).

**Recommendations**
- Implement the spec-gate hash as a two-layer SHA-256 modeled on dirhash.Hash1: (1) per file, hex = createHash('sha256').update(readFileSync(absPath)).digest('hex'); (2) line = `${hex}  ${posixRelPath}\n` (exactly two spaces, '\n'); (3) sort lines by posixRelPath byte-wise; (4) manifest = sorted lines joined; (5) specGateHash = createHash('sha256').update(manifest,'utf8').digest('hex').
- Normalize every path with path.relative(specRoot, file) then split(path.sep).join('/') so Windows backslashes become forward slashes; this is what makes a manifest built on Windows equal to one built on Linux. Never put absolute paths in the manifest.
- Read file content with readFileSync (Buffer), not as a utf8 string, so the content hash reflects exact bytes and is encoding-independent. Do not strip/convert CRLF at hash time; instead keep committed spec files' line endings stable (e.g., via .gitattributes/text eol) so the bytes are reproducible.
- Sort on the normalized path only (ignore the hash and file size in the sort key), ascending, using a deterministic comparator (Buffer.from(a).compare(Buffer.from(b)) for full byte-wise correctness, or plain < comparison for guaranteed-ASCII paths). Pre-sort the file list before hashing so filesystem/readdir order never affects the result.
- Validate/guard inputs: reject any spec path containing a newline (U+000A) since it would break the line-oriented manifest; enumerate the spec file set explicitly/deterministically rather than relying on raw directory iteration order.
- Store prd_sha256 and the spec-gate hash as lowercase hex in spec-gate.json, and recompute-and-compare both on fromSpec; refuse if either differs. Stay on Node's built-in crypto only (no new dependency), which satisfies the zod/@modelcontextprotocol/sdk-only constraint.

*As of: 2026-10-24 (Node.js crypto docs v26.12.1; Go golang.org/x/mod/sumdb/dirhash and andhus/dirhash README current)*

**Sources**
- [Node.js Documentation — Crypto: crypto.createHash / Hash class](https://nodejs.org/api/crypto.html) (official-docs) -- "hash.update(data[, inputEncoding]) ... hash.digest([encoding]) ... If encoding is specified, returns a string; otherwise a Buffer. Cryptographic hash functions are deterministic: the same input data will always produce the same hash output."
- [dirhash package - golang.org/x/mod/sumdb/dirhash - Go Packages](https://pkg.go.dev/golang.org/x/mod/sumdb/dirhash) (repo) -- "Hash1 ... line containing the hexadecimal SHA-256 hash of the file content, two spaces (U+0020), the file name, a newline (U+000A) ... equivalent to: sha256sum $(find . -type f | sort) | sha256sum ... File names with newlines (U+000A) are disallowed ... File names always use forward slashes (even on Windows)."
- [The Dirhash Standard (andhus/dirhash README)](https://github.com/andhus/dirhash/blob/master/README.md) (repo) -- "dir_descriptor = '\000\000'.join(sorted(entry_descriptors)) ... The path is normalized according to the unix standard (with a forward slash / separating directories) ... the file's binary data is first hashed separately, then that hexdigest becomes the property value."


### Artifacts available for the deterministic TL;DR
*Which events/artifacts (PRD goal/scope, spec_assumption / 'N spec decisions logged', research open uncertainties, unconfirmed claims, risky/defaulted lists, build-phase count, review-independence line) exist and are readable for assembling the TL;DR without a model?*

The artifacts named in this item (PRD goal/scope, spec_assumption events / 'N spec decisions logged', research open uncertainties, unconfirmed claims, risky/defaulted lists, build-phase count, review-independence line) are internal to the OSA repo on branch feat/spec-gate at commit 67e1961. That repository is private and is not published or indexed anywhere I can reach: web search for 'One-Shot Anything', the Kaide-LABS org, and the specific identifiers (osa_plan/osa_spec/osa_build, spec-gate.json, baby-prd.md, spec_assumption) returned only unrelated OSA-named projects. [uncertain] Therefore I cannot confirm from any source I opened which of these artifacts actually exist on disk or are readable at that commit; that determination requires reading the worktree, which is outside my web-only tools. The only authoritative description of these artifacts available to me is the locked brief itself, which already enumerates them as the intended TL;DR inputs.

**Key findings**
- No public/web source exists for this codebase. Searches for 'OSA One-Shot Anything', the Kaide-LABS org, and the exact identifiers (spec-gate.json, baby-prd.md, osa_plan/osa_spec/osa_build, spec_assumption, prd_locked, prd_integrity_verified) matched only unrelated projects (Miosa-osa/OSA, aimclub/OSA, admax12959/OneShot, optical-networks one-shot learning). [uncertain]
- The question is a repo-state question (AC8: 'TL;DR produced with no model call from existing artifacts'); it can only be answered by inspecting the run record/artifact schema at 67e1961, not by external reference material. [uncertain]
- The locked brief is the sole trusted enumeration of the candidate TL;DR inputs: PRD goal/scope, spec_assumption events, research open uncertainties, unconfirmed claims, risky/defaulted assumption lists, build-phase count, and a review-independence line. These are named as targets, not confirmed as present. [uncertain]
- AC8 requires a stop-and-report path if a readable TL;DR cannot be assembled, which implies the intended design treats some of these artifacts as possibly absent at assembly time rather than guaranteed. [uncertain]

**Recommendations**
- Resolve this item by reading the repo directly (run record event log, PRD/spec/research artifact files, and their TypeScript/zod schemas at 67e1961) rather than by any web lookup — no external source can answer it.
- Treat each listed input as optional at assembly time: read PRD goal/scope from the locked PRD artifact, spec decision count and risky/defaulted lists from the spec_assumption records, open uncertainties and unconfirmed claims from the research artifact, and build-phase count from the build plan/record — but gate each behind a presence check.
- Assemble the TL;DR purely by reading and formatting these existing fields (string concatenation/templating). Per the constraint and AC8, make zero model calls on the gate/TL;DR path; if any required piece is missing or unreadable, stop the run and report instead of synthesizing text.
- Do not infer the artifact schema from the similarly-named public OSA/OneShot repos found in search — they are different projects and would mislead field names and shapes.
- Confirm the exact event/field names (e.g. whether it is literally 'spec_assumption', the 'N spec decisions logged' string, and a 'review-independence' line) against the code before wiring them into the deterministic assembler; the brief's names may be descriptive rather than literal identifiers.

*As of: 2026-10-24*

**Sources**
- [GitHub search — OSA / One-Shot Anything MCP projects (no match for this repo)](https://github.com/Miosa-osa/OSA) (repo) -- "An AI agent for your terminal, built on signal theory — unrelated project; does not contain spec-gate.json, baby-prd.md, osa_plan/osa_spec/osa_build."
- [admax12959/OneShot Issue #14 — Assemble the build-ready spec (unrelated project)](https://github.com/admax12959/OneShot/issues/14) (repo) -- "Assemble the build-ready spec — name-adjacent but not the Kaide-LABS OSA repo; no matching artifact identifiers."


### MCP tool wiring and durable background jobs
*How do src/mcp/tools/osa.ts and the server register tools, persist plan-request.json / mcp-result.json, and run background jobs so a restarted server still answers osa_status, to reshape into plan/spec/build?*

MCP tool handlers in the TypeScript SDK are per-call and effectively stateless: `McpServer.registerTool(name, config, handler)` validates args against a Zod `inputSchema`, runs an `async` handler, and returns `{ content, structuredContent }`. The SDK itself gives you no durability — anything that must survive a server restart (OSA's plan-request.json / mcp-result.json and background job state) has to be persisted by your own code to disk and re-read on each call, exactly so a tool like osa_status can answer from the file system rather than in-memory state. The emerging MCP 'Tasks' standard (io.modelcontextprotocol/tasks, 2026-07-28 spec; formerly the SEP-1391 'long-running operations' proposal, superseded by SEP-1686) formalizes the right shape for this: a call returns a handle immediately, work continues in the background, and the client polls a status RPC (tasks/get) until a terminal state — but the reference implementations still persist task records to an external store (Redis/QStash) because the protocol does not provide durability. For the reshape, keep that split: osa_plan/osa_spec write their request + result artifacts and launch the background job; osa_status is a pure read of persisted artifacts so a restarted server reconstructs answers from disk.

**Key findings**
- `registerTool(name, config, handler)` on the high-level `McpServer` class validates arguments against a Zod `inputSchema` before the handler runs; invalid args return `isError: true` and never reach the handler.
- Handlers are `async` and return `{ content: [...], structuredContent?: ... }`; `structuredContent` is validated against an optional `outputSchema`. Long-running work 'works naturally' because the handler is async, but the SDK provides no built-in background/task machinery.
- `registerTool` returns a `RegisteredTool` handle exposing `enable()`, `disable()`, `remove()`, and `update()` for runtime toggling — relevant if plan/spec/build tools must be gated per run.
- The official SDK docs give no explicit guidance on stateful/background operations; state is 'managed at the server level outside individual handlers' — i.e., durability is the application's responsibility, not the SDK's.
- MCP 'Tasks' shipped as an extension (`io.modelcontextprotocol/tasks`) with the 2026-07-28 MCP specification: a `tools/call` returns a task handle immediately, work continues in background, client polls `tasks/get`; states are `working`, `input_required`, `completed`, `failed`, `cancelled` (last three terminal), with a server-provided `pollIntervalMs`.
- SEP-1391 'Long-Running Operations' (created 2025-08-26, Standards Track) proposed operation tokens plus `tools/async/status` and `tools/async/result` RPCs; it was closed and superseded by SEP-1686 (Tasks), which generalizes tasks to all JSON-RPC requests.
- Durability across restarts is achieved in reference implementations (e.g. Upstash) by persisting task records to an external store (Redis) and dispatching work to a durable queue (QStash/Upstash Workflow), explicitly 'enabling survival across request boundaries and function restarts' — the protocol itself does not persist anything.
- Client opt-in is required for Tasks: servers must not return task handles to clients that did not advertise task capability, and async-only tools are filtered out via protocol-version negotiation for older clients.

**Recommendations**
- Model osa_plan/osa_spec as the write side and osa_status as a pure read side: on each call, persist plan-request.json and mcp-result.json to the run folder and reconstruct every osa_status answer by reading those artifacts, so a restarted server with empty memory still answers correctly. Do not rely on in-process maps or promises to hold job state.
- Treat the background job as fire-and-detach that journals progress to disk (status + partial results) rather than holding the MCP request open; the MCP handler should return a handle/run id quickly and let osa_status report progress from persisted files — matching the standardized task-handle + poll pattern without adopting the full Tasks extension (which would add protocol surface and is unnecessary given osa_status already exists).
- Keep the four-tool surface (osa_plan, osa_spec, osa_build, osa_status) and register each with its own Zod inputSchema and an outputSchema so osa_status can return structuredContent carrying awaiting_confirmation, TL;DR, risky/defaulted lists and spec_sha256 as machine-readable fields, not just text — this directly serves acceptance criteria 9 and 14.
- Do NOT add Redis/QStash or any external store or new dependency: you are limited to zod and @modelcontextprotocol/sdk, so the durable store must be the existing run folder on disk. Use atomic writes (write-temp-then-rename) for plan-request.json and mcp-result.json so a crash mid-write never leaves osa_status reading a torn file.
- Write a terminal-state marker into the persisted result (e.g. a status enum value in mcp-result.json) so osa_status is idempotent and distinguishes working vs completed vs failed exactly like the standard task states, without re-running any work — and with no model call, honoring the 'no new model call in the gate/TL;DR path' constraint.
- Because the MCP handler is validated-then-async with no SDK-level concurrency guard, add your own per-run lock/guard on disk (the existing prd_locked / spec-gate.json mechanism) so two overlapping osa_build calls cannot both proceed; the SDK will not serialize them for you.
- Avoid the SEP-1391 async RPC shape (tools/async/status, invocationMode): it is closed/superseded and unimplemented in the pinned SDK — osa_status already fills that role. Prefer plain registered tools reading persisted artifacts.

*As of: 2026-10-24; MCP Tasks per the 2026-07-28 spec; SEP-1391 closed (superseded by SEP-1686)*

**Sources**
- [Tools — MCP TypeScript SDK (v2 docs)](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html) (official-docs) -- "Tools are registered using registerTool(name, config, handler)... Invalid arguments never reach your handler—instead, they return an error result with isError: true... The handler signature is already async, so long-running operations work naturally."
- [Tool Registration and Execution — MCP TypeScript SDK](https://deepwiki.com/modelcontextprotocol/typescript-sdk/3.2-tool-registration-and-execution) (repo) -- "registerTool returns a RegisteredTool handle with enable(), disable(), remove(), and update(), so you can toggle a tool at runtime."
- [MCP Tasks and Events, Explained: Long-Running Tools and Agents That Wake Up](https://upstash.com/blog/mcp-tasks-and-events) (article) -- "Instead of making the client wait, a server answers a tools/call right away with a task handle. The work continues in the background, and the client polls tasks/get until the task is done... Task records persist in Redis, enabling survival across request boundaries and function restarts."
- [SEP-1391: Long-Running Operations · Issue #1391 · modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1391) (repo) -- "Status: Closed (superseded by SEP-1686)... New tools/async/status RPC method accepts operation tokens and returns status values: submitted, working, completed, canceled, failed, input_required, or unknown."


### @modelcontextprotocol/sdk tool declaration
*What is the current SDK-supported way to declare tools, their input schemas and descriptions, and return results, so osa_spec can be added and the surfaces test re-pinned?*

The current @modelcontextprotocol/sdk (v1.x, the package OSA already depends on) declares tools via server.registerTool(name, config, handler). The config object carries title, description, a Zod inputSchema (optionally outputSchema and annotations), and the SDK auto-derives JSON Schema, validates arguments, and infers handler param types from that one Zod schema. The async handler returns { content: [{ type: 'text', text }], structuredContent?, isError? }. registerTool is the modern replacement for the deprecated server.tool()/tool() API; to add osa_spec, register it alongside osa_plan/osa_build/osa_status and re-pin the surfaces test to assert exactly those four names.

**Key findings**
- registerTool signature: server.registerTool(name: string, config: { title?: string; description: string; inputSchema?: ZodRawShape|ZodObject; outputSchema?; annotations?: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } }, handler: async (args) => result).
- In v1.x the imports are: import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'; import { z } from 'zod'; registerTool is available from ^1.6.1 (per anthropics/skills mcp-builder reference).
- The handler result shape is { content: Array<{ type: 'text'|'image'|'audio'|'resource'|'resource_link', ... }>, structuredContent?: object (must match outputSchema if given), isError?: boolean }.
- A single Zod schema is the source of truth: the SDK converts it to the JSON Schema the model sees, validates args before the handler runs, and infers the handler's TypeScript arg types (via z.infer). Per-field descriptions come from .describe(); JSDoc is NOT auto-extracted.
- registerTool replaces the older tool()/server.tool() API; the v2 docs note 'registerTool replaces tool()'. Both v1.x and v2 expose registerTool, so OSA can stay on the @modelcontextprotocol/sdk (v1.x) package it already has rather than switching to the v2 '@modelcontextprotocol/server' package.
- Known perf caveat (issue #2838): registerTool converts Zod schemas eagerly per McpServer instance, so a stateless/per-request server re-converts every tool each request — relevant only if OSA constructs a new server per call.
- The anthropics reference example uses z.nativeEnum for a format field; that relies on a runtime TS enum, which OSA's erasableSyntaxOnly/no-enums constraint forbids — use z.enum(['markdown','json']) with string literals instead.

**Recommendations**
- Add osa_spec with server.registerTool('osa_spec', { title, description, inputSchema: z.object({...}) , annotations }, handler) using the same import path (@modelcontextprotocol/sdk/server/mcp.js) and pattern as the existing osa_plan/osa_build so no new dependency is introduced.
- Define inputSchema as a z.object with per-field .describe() calls; put the 'relay recommended questions / show TL;DR before osa_build / never set accept_risky_assumptions' guidance in the tool description string (AC 17), since descriptions are the only thing the model reads.
- Return results as { content: [{ type: 'text', text: JSON.stringify(payload) }] } and, if you want machine-readable output (e.g. awaiting_confirmation status, spec_sha256, risky/defaulted lists), add a matching outputSchema and structuredContent.
- Do NOT use z.nativeEnum or any TS enum (erasableSyntaxOnly / no-enums); use z.enum([...]) string-literal unions for any scope/format fields.
- Stay on the v1.x @modelcontextprotocol/sdk package already in deps; do not migrate to the v2 '@modelcontextprotocol/server' package, as that would be a dependency change outside the allowed set.
- Re-pin the surfaces test to assert the tool list is exactly ['osa_plan','osa_spec','osa_build','osa_status'] (strict equality, replaced not weakened), matching AC 14.
- Set annotations honestly (e.g. osa_spec/osa_status readOnlyHint where applicable; osa_build destructiveHint:false but openWorldHint as appropriate) so clients get correct behavior hints.

*As of: 2026-10-24; v1.x SDK registerTool confirmed from ^1.6.1, v2 docs reference MCP spec 2026-07-28.*

**Sources**
- [anthropics/skills — mcp-builder reference: node_mcp_server.md](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/reference/node_mcp_server.md) (repo) -- "Use the modern registerTool() method (not deprecated APIs like server.tool())... import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"; ... @modelcontextprotocol/sdk: ^1.6.1 ... return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output }"
- [MCP TypeScript SDK — Tools (v2 docs)](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html) (official-docs) -- "registerTool replaces tool()—run the codemod, then see the upgrade guide. config: title?, description, inputSchema?, outputSchema?, annotations (readOnlyHint, destructiveHint, idempotentHint). Handler returns { content: [...], structuredContent?, isError? }"
- [typescript-sdk issue #2838 — registerTool converts zod schemas eagerly per McpServer instance](https://github.com/modelcontextprotocol/typescript-sdk/issues/2838) (repo) -- "registerTool converts zod schemas eagerly per McpServer instance, so stateless servers re-convert every tool on every request"
- [registerTool: accept ZodType<object> for input and output schema (PR #816)](https://github.com/modelcontextprotocol/typescript-sdk/pull/816) (repo) -- "allows any Zod schema extending ZodType<object>, which unblocks MCP servers' ability to define tool schemas that use z.union(...) and z.intersection(...)"


### Surfaces test and boundary scan
*How does the surfaces test pin the tool list and how does the boundary scanner enforce B1-B12, so the tool-list assertions can be replaced and 0 violations kept?*

The OSA-specific 'surfaces test' and the B1-B12 boundary scanner are internal to the private feat/spec-gate repo at 67e1961; no public source documents them, and I have web tools only (no access to the worktree), so I cannot verify their exact implementation here. From verifiable MCP/testing practice: a 'surfaces test' pins the tool list by invoking the server's tools/list handler (ListToolsRequestSchema) and asserting the exact set/order of tool names against a committed expected value, failing CI on any drift. To keep 0 violations while swapping osa_plan/osa_build for osa_plan/osa_spec/osa_build/osa_status, replace the expected tool-list literal with the new exact set (keep strict equality, don't relax to `contains`), and ensure the moved/added code respects the boundary rules (child_process only in src/util/exec.ts, concrete model names only in src/adapters/**, network only in src/research/net/**).

**Key findings**
- No public documentation exists for OSA's surfaces test or boundary scanner B1-B12; these are repo-internal and verifiable only by reading src/ at 67e1961, which this web-only agent cannot do [uncertain].
- MCP tool registration is done via a ListToolsRequestSchema handler returning an array of tools (name, description, inputSchema); a test can call client.listTools()/the handler and assert the returned names, per MCP SDK docs.
- Established MCP practice is to snapshot the tools/list output, commit it to version control, and fail CI on any breaking change -- directly matching the intent of a 'surfaces test' that pins the exact tool list.
- Tool names and descriptions are part of the contract surface (they act as prompt text influencing model tool choice), so an exact-match assertion on names is the correct strength; weakening to substring/superset checks would defeat the test's purpose (dev.to, 2025).
- The acceptance criteria require the surfaces assertions be 'replaced not weakened' -- i.e. strict equality against the new 4-tool set [osa_plan, osa_spec, osa_build, osa_status], not a loosened check.

**Recommendations**
- To confirm exactly how the surfaces test pins the list and how the scanner enforces B1-B12, read the repo directly (likely under test/ or tests/ for the surfaces test, and a scripts/scan or tooling file for the boundary scan referenced by `npm run check`); do not infer the mechanism from external sources.
- Replace the tool-list expectation with the exact new set [osa_plan, osa_spec, osa_build, osa_status] using the same strict equality/ordering the existing test uses; do not downgrade to `toContain`/superset matchers (criterion 14).
- Keep boundary scan at 0 by placing any new child_process use only in src/util/exec.ts, any concrete model name only in src/adapters/**, and any network I/O only in src/research/net/**; the gate/TL;DR path must add no model call (B-rules + no-new-model-call constraint).
- If the brief's description of the surfaces/boundary mechanism contradicts what the code actually does, stop that phase and report the exact file/line rather than guessing (per the stop-on-contradiction constraint).

*As of: 2026-10-24*

**Sources**
- [Tool Schemas Are an API Contract (Treat Them Like One)](https://dev.to/andriiboyko/tool-schemas-are-an-api-contract-treat-them-like-one-bj2) (article) -- "Snapshot the contract: Commit tools/list output to version control and fail CI on breaking schema changes."
- [Build an MCP server - Model Context Protocol](https://modelcontextprotocol.io/docs/develop/build-server) (official-docs) -- "you define them by setting a request handler for ListToolsRequestSchema that returns an object containing an array of available tools with their names, descriptions, and input schemas"
- [listTools - Kotlin MCP SDK](https://kotlin.sdk.modelcontextprotocol.io/kotlin-sdk-client/io.modelcontextprotocol.kotlin.sdk.client/-client/list-tools.html) (official-docs) -- "listTools accepts a ListToolsRequest and returns a ListToolsResult containing the list of available tools on the server"

## Documentation sources

- [Zod — Introduction (official docs)](https://zod.dev)
- [Zod v4 Migration guide / changelog (official docs)](https://zod.dev/v4/changelog)
- [MCP TypeScript SDK v1 documentation (overview/install)](https://ts.sdk.modelcontextprotocol.io/)
- [MCP TypeScript SDK v1 quickstart (zod peer dependency)](https://ts.sdk.modelcontextprotocol.io/quickstart)
- [typescript-sdk v1.x docs/server.md (API surface)](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/docs/server.md)
- [@modelcontextprotocol/sdk - npm (version listing)](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [@modelcontextprotocol/sdk latest package metadata (npm registry)](https://registry.npmjs.org/@modelcontextprotocol/sdk/latest)
- [Releases / spec version timeline (modelcontextprotocol)](https://github.com/modelcontextprotocol/modelcontextprotocol/releases)
- [Modules: TypeScript — Node.js API Documentation](https://nodejs.org/api/typescript.html)
- [Evolving the Node.js Release Schedule / Node.js Releases](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule)
- [TypeScript: TSConfig Option: erasableSyntaxOnly](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html)
- [Announcing TypeScript 5.9 - TypeScript DevBlog](https://devblogs.microsoft.com/typescript/announcing-typescript-5-9/)
- [Announcing TypeScript 6.0 - TypeScript DevBlog](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/)
- [Crypto | Node.js v24.x Documentation](https://nodejs.org/dist/latest-v24.x/docs/api/crypto.html)
- [Crypto | Node.js Documentation (crypto.html)](https://nodejs.org/api/crypto.html)
- [Test runner | Node.js v26.x Documentation (latest)](https://nodejs.org/docs/latest/api/test.html)
- [Test runner | Node.js API Documentation](https://nodejs.org/api/test.html)
- [Zod — Defining schemas (API reference)](https://zod.dev/api)
- [Tools — MCP TypeScript SDK (v2 docs)](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html)
- [Build an MCP server - Model Context Protocol](https://modelcontextprotocol.io/docs/develop/build-server)
- [listTools - Kotlin MCP SDK](https://kotlin.sdk.modelcontextprotocol.io/kotlin-sdk-client/io.modelcontextprotocol.kotlin.sdk.client/-client/list-tools.html)

## Academic literature

_No relevant academic papers were found. This is a valid result, not a failure._

_No academic queries were planned for this project._
_No relevant academic papers were found; this is a valid result, not a failure._

## Prior art

- [to-mc/checksumdir](https://github.com/to-mc/checksumdir) -- 102 stars, Python, licence MIT. Simple package to compute a single deterministic hash of the file contents of a directory.
- [JarvusInnovations/background-action](https://github.com/JarvusInnovations/background-action) -- 43 stars, JavaScript, licence Apache-2.0. GitHub Action: run a long-running process (server, emulator, tunnel) in the background and wait until the http endpoints, tcp ports, sockets or files it provides are ready. Output is captured to files, not your job log, and replayed only when you choose, such as on failure. If it dies on startup you fail instantly with its logs.
- [jerriepelser-blog/signalr-long-running](https://github.com/jerriepelser-blog/signalr-long-running) -- 27 stars, JavaScript, licence MIT. Sample code for the blog post "Communicate the status of a background job with SignalR"

**Patterns worth reusing**

## Prior-art review: patterns worth reusing

**to-mc/checksumdir (MIT, Python).** Directly maps to AC7's spec-gate manifest hash. Worth reusing: the idea of hashing *content, not metadata* (filename/mtime excluded) for a deterministic directory digest, plus explicit include/exclude controls (`excluded_files`, `excluded_extensions`). This validates your "sorted-path + per-file-sha256 manifest" design — the sort is what makes it reproducible across filesystems. **Don't copy:** its default is MD5 (you correctly use sha256), and it hashes raw contents directly rather than a sorted path+hash manifest, so it wouldn't detect a file *rename* — your path-inclusive manifest does. Ideas are freely borrowable; don't vendor the code (no new deps allowed anyway).

**JarvusInnovations/background-action (Apache-2.0, JS).** Relevant to the gate/approval and status-reporting seams. Reuse the v2 lesson: **exact value matching, not substring** — their v1 silently enabled stderr on `no-stderr` and treated `abc123` as a 123ms timeout. Mirrors AC10–12: a wrong spec hash or a bare `--accept-risky` must be *refused*, not coerced. Also reuse **fail-fast with captured output** (a dead process reports immediately with its logs rather than hanging to timeout) — apply to AC8's "stop and report instead of calling a model." **Don't copy:** the GitHub-Actions I/O model, SIGTERM/grace-period lifecycle, and `RUNNER_TEMP` log placement are irrelevant to a one-shot CLI/MCP gate.

**jerriepelser-blog/signalr-long-running (MIT, JS).** README unavailable and SignalR push-status is the wrong model for your pull-based `osa_status`/`awaiting_confirmation` (AC9). Nothing concrete to reuse; skip.

**Licence note:** all three are permissive (MIT/Apache-2.0) and compatible, but your constraint forbids new dependencies — borrow the *patterns* above, write your own code. None require avoidance for ideas.

_No repositories matched "long-running background job durable status MCP tool node"; retried as "long-running background job"._
_No repositories matched "deterministic directory file manifest sha256 reproducible hash node"; retried as "deterministic directory file"._

## Open uncertainties

- Official documentation: @modelcontextprotocol/sdk: `current_version`
- Official documentation: Node.js: `key_findings`
- Official documentation: TypeScript: `current_version`
- Official documentation: TypeScript: `key_findings`
- Official documentation: TypeScript: `pitfalls`
- Official documentation: Node.js test runner: `key_findings`
- Intake schema, baby PRD types and backstop: `summary`
- Intake schema, baby PRD types and backstop: `key_findings`
- lockBabyPrd gate semantics: `key_findings`
- lockBabyPrd gate semantics: `summary`
- Pipeline stages, hashing and resume: `key_findings`
- Artifacts available for the deterministic TL;DR: `summary`
- Artifacts available for the deterministic TL;DR: `key_findings`
- Surfaces test and boundary scan: `key_findings`

## Independent check

Researched by claude-code; checked by antigravity-cli (antigravity-cli (gemini-3.8-flash) reviewed work written by claude-code (opus): a different model family, the most independent kind of check.). Verdict: **issues** -- DEGRADED: the reviewer could not open sources, so this is a consistency check only.

The research report contains notable internal contradictions regarding @modelcontextprotocol/sdk versioning and registerTool inputSchema requirements, as well as an invalid date calculation for SDK maintenance. While core claims regarding Node.js type stripping, TSConfig erasableSyntaxOnly, and crypto hashing primitives are supported by cited official documentation excerpts, several version numbers, performance claims, and test-runner mocking APIs lack backing in the provided source quotes. Furthermore, all claims concerning private repository internals (intake, lockBabyPrd, pipeline sequencing, and boundary enforcement) cannot be checked from external sources and remain unverifiable.

Claims NOT confirmed (treat as uncertain downstream):
- [unsupported] Current stable version of Zod is Zod 4, with 4.6 noted as the latest available. -- The quoted excerpts from the cited official documentation and changelog do not state that Zod 4 or 4.6 is the current stable release. (https://zod.dev)
- [unsupported] Zod 4 provides ~14x faster string parsing, 7x array parsing, and 6.5x object parsing versus Zod 3. -- No performance benchmarks or ratios appear in the quoted excerpts of the cited sources. (https://zod.dev)
- [unsupported] Zod 4 adds first-party JSON Schema conversion via z.toJSONSchema() and an .overwrite() transform. -- These APIs are not mentioned in any of the quoted excerpts from the cited Zod sources. (https://zod.dev/v4/changelog)
- [contradicted] The current published stable version of @modelcontextprotocol/sdk is 1.32.1. -- Contradicted internally by the report's subsequent section and by the cited npm registry metadata, which establishes the latest version is 1.32.2. (https://registry.npmjs.org/@modelcontextprotocol/sdk/latest)
- [contradicted] v1.x security updates are guaranteed for ~6 months past the v2 release through ~2026-07-27. -- Internally contradictory and mathematically incorrect; six months following the v2 release date of 2026-07-27 extends into late January 2027, not July 2026. (https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/README.md)
- [contradicted] registerTool inputSchema in @modelcontextprotocol/sdk v1.x must be a raw Zod shape object and cannot be a wrapped z.object(). -- Contradicted within the report by the tool declaration section, which recommends passing inputSchema as z.object({...}) and cites PR #816 accepting ZodType<object>. (https://github.com/modelcontextprotocol/typescript-sdk/pull/816)
- [unsupported] --experimental-transform-types was added in v22.7.0 and removed in Node.js v26.0.0. -- Neither cited Node.js documentation excerpt mentions --experimental-transform-types or its removal. (https://nodejs.org/api/typescript.html)
- [unsupported] Node.js is transitioning to one major release per year starting with v27 (Alpha Oct 2026, 27.0.0 April 2027). -- The quoted excerpt from the release schedule announcement does not mention this transition or version 27 dates. (https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule)
- [unsupported] TypeScript 7.0 is the current stable release line with 7.0.2 released on July 8, 2026. -- The quoted source excerpt only cites pre-release versions of 7.1.0-dev and does not state that 7.0 or 7.0.2 is the stable release. (https://releasealert.dev/npmjs/_/typescript)
- [unsupported] erasableSyntaxOnly was introduced in the TypeScript 5.8 line. -- The cited TSConfig excerpt does not provide the version where the flag was introduced (and the report itself acknowledges the page omits this). (https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html)
- [unsupported] The stable API surface of node:test includes top-level mocking (mock.fn(), mock.method(), mock.reset()) and lifecycle hooks (beforeEach, afterEach). -- The quoted excerpts from the test runner documentation do not mention mock objects, mock.fn(), or lifecycle hooks. (https://nodejs.org/api/test.html)
- [unverifiable] lockBabyPrd in src/*/lock.ts implements exit-code-19, --yes, and accept-risky gate semantics. -- Pertains to a private, unindexed repository codebase that cannot be verified from external public documentation. ()
- [unverifiable] pipeline.ts sequences intake/lock/research/spec, prd_sha256 verification, and research_validated 'resumed' counting. -- Private repository implementation details that cannot be inspected without access to the local codebase. ()
- [unverifiable] Artifacts including PRD goal/scope, spec_assumption records, and review-independence line are readable for deterministic TL;DR generation. -- Internal project artifacts and schemas cannot be confirmed from external sources. ()
- [unverifiable] Surfaces test pins exact tool list and boundary scanner enforces B1-B12 architectural rules. -- Repo-internal testing and boundary enforcement rules that are not publicly documented or checkable externally. ()

### Planted instructions found in sources (removed before use)

1 line(s) of source text were aimed at an AI rather than at a reader. They were cut out before any model used the material, and nothing in this report relies on them.

- governance in research result (model output derived from web pages) (research:docs-zod)
