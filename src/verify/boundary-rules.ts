// Implements PHASE_1_SPEC.md §6.8 -- §5.1 [DET]
//
// The B1-B8 hard-boundary rule table as data (PRD §5.1). This file is excluded from its own scan
// (`src/verify/boundary.ts`'s `scanBoundary()`) because it contains every forbidden literal and
// pattern by construction -- that exclusion is exact and non-negotiable (§6.8).

/** A single mechanised boundary rule. */
export interface BoundaryRule {
  readonly id: "B1" | "B2" | "B3" | "B4" | "B5" | "B6" | "B7" | "B8" | "B9" | "B10" | "B11" | "B12";
  readonly description: string;
  readonly kind: "source-pattern" | "manifest";
  /** Present only for `kind === "source-pattern"`. */
  readonly pattern?: RegExp;
  readonly exitCode: 7 | 9;
}

/**
 * The normative B1-B8 rule table (PHASE_1_SPEC.md §6.8, §5.1). B4 is matched only after `//`
 * line comments are stripped (a documentation URL in a comment is not a violation); every other
 * rule matches the raw source line.
 */
export const BOUNDARY_RULES: readonly BoundaryRule[] = [
  {
    id: "B1",
    description:
      "Any case-insensitive occurrence of \"traycer\" in src/** or package.json dependencies " +
      "(the §4 locked architectural rejection).",
    kind: "source-pattern",
    pattern: /traycer/i,
    exitCode: 7,
  },
  {
    id: "B2",
    description:
      "Any runtime dependencies entry in package.json outside the allowlist (zod and " +
      "@modelcontextprotocol/sdk, and no other runtime dependency -- amended Phase 8 MCP server pass) -- " +
      "prevents a hosted/closed orchestration SDK entering by the side door.",
    kind: "manifest",
    exitCode: 7,
  },
  {
    id: "B3",
    description:
      "Any import of node:http/https/net/tls, undici, axios, got, or node-fetch, or a call to " +
      "global fetch()/XMLHttpRequest, in src/**. osa makes zero network calls -- with exactly ONE exemption " +
      "(OSA WS3, docs/osa/CONFLICTS.md C-01): src/research/net/**, the free public research APIs (arXiv, " +
      "OpenAlex, GitHub), which is held to B9 instead.",
    kind: "source-pattern",
    pattern:
      /\bfrom\s+["']node:(http|https|net|tls)["']|\brequire\(["']node:(http|https|net|tls)["']|\bfrom\s+["'](undici|axios|got|node-fetch)["']|(?<![.\w])fetch\s*\(|XMLHttpRequest/,
    exitCode: 7,
  },
  {
    id: "B4",
    description:
      "Any http:// or https:// string literal in src/** (comments and *.md excluded) -- catches a " +
      "URL smuggled into a spawn argument. Exempt only under src/research/net/** (the API clients' own base URLs).",
    kind: "source-pattern",
    pattern: /https?:\/\//,
    exitCode: 7,
  },
  {
    id: "B5",
    description:
      "Any import of open/opn/openurl/open-cli, or a spawn of start/xdg-open/rundll32 url.dll -- " +
      "an interactive browser flow in the run path is a boundary violation.",
    kind: "source-pattern",
    pattern: /\bfrom\s+["'](open|opn|openurl|open-cli)["']|\bxdg-open\b|\brundll32\s+url\.dll|["']start["']\s*,/,
    exitCode: 7,
  },
  {
    id: "B6",
    description:
      "Any invocation of the two providers' own credential-setup commands from src/**. " +
      "OSA never performs or triggers credential setup; it only observes credential state.",
    kind: "source-pattern",
    pattern: /claude["'\s,\]]+auth["'\s,\]]+login|claude["'\s,\]]+setup-token|codex["'\s,\]]+login(?!["'\s,\]]+status)|codex["'\s,\]]+auth/,
    exitCode: 7,
  },
  {
    id: "B7",
    description:
      "Any concrete provider model-name literal or bare tier alias string anywhere outside " +
      "src/adapters/** -- tier is an abstract effort-level property the adapter resolves per-provider.",
    kind: "source-pattern",
    pattern: /claude-(opus|sonnet|haiku|fable)|\bgpt-5[\w.-]*|\bgpt-oss[\w.-]*|\bgemini-\d[\w.-]*|\bo[34](-mini)?\b|["'](opus|sonnet|haiku|fable)["']/,
    exitCode: 9,
  },
  {
    id: "B9",
    description:
      "Inside the one network-exempt directory (src/research/net/**): any import of node:http/https/net/tls, " +
      "undici, axios, got or node-fetch, or XMLHttpRequest. Only the platform's global fetch() is allowed there, " +
      "so the exemption cannot grow into a general HTTP stack or a new dependency.",
    kind: "source-pattern",
    pattern:
      /\bfrom\s+["']node:(http|https|net|tls)["']|\brequire\(["']node:(http|https|net|tls)["']|\bfrom\s+["'](undici|axios|got|node-fetch)["']|XMLHttpRequest/,
    exitCode: 7,
  },
  {
    id: "B10",
    description:
      "Any import of node:child_process (static, require or dynamic) outside src/util/exec.ts, the one sanctioned " +
      "child-process wrapper. Every external program (provider CLIs, trim-1, codebase-memory-mcp, git) is launched " +
      "through runProcess: an argument array, no shell, a fixed binary path.",
    kind: "source-pattern",
    pattern: /\b(?:from|import|require)\s*\(?\s*["'](?:node:)?child_process["']/,
    exitCode: 7,
  },
  {
    id: "B11",
    description:
      "Any `shell: true` option, or a call to exec/execSync/execFile/execFileSync/spawnSync, outside src/util/exec.ts " +
      "-- a command line handed to a shell is a command-injection surface.",
    kind: "source-pattern",
    pattern: /\bshell\s*:\s*true\b|(?<![.\w])(?:exec|execSync|execFile|execFileSync|spawnSync)\s*\(/,
    exitCode: 7,
  },
  {
    id: "B12",
    description:
      "A spawned `command:` built by string interpolation or concatenation (a template literal with ${...}, or \"..\" + x). " +
      "The binary is a fixed path from config or a literal; only the argument array carries variable data.",
    kind: "source-pattern",
    pattern: /\bcommand\s*:\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+)/,
    exitCode: 7,
  },
  {
    id: "B8",
    description:
      "Any commit-attribution or model-generation string in a commit-message template under " +
      "src/**. Commits stay neutral.",
    kind: "source-pattern",
    pattern: /Co-Authored-By:\s*Claude|Co-authored-by:\s*Codex|Generated with \[?Claude Code|Generated with Codex/i,
    exitCode: 7,
  },
];
