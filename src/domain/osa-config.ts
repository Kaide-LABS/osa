// OSA project configuration (`osa.config.json`). Every OSA feature is config-gated with the default
// stated in OSA_DIRECTIVE.md ("Logging / config summary"). The schema is a strict object so a typo'd key
// is a loud error rather than a silently ignored setting. Pure: no I/O (see src/util/config-file.ts).

import { z } from "zod";
import { ProviderIdSchema, RolePinSchema } from "./run.ts";
import type { ProviderId } from "./run.ts";

/** Short aliases accepted in config (the directive writes `"codex"`), normalised to canonical ids. */
const PROVIDER_ALIASES: Readonly<Record<string, ProviderId>> = {
  claude: "claude-code",
  codex: "codex-cli",
  antigravity: "antigravity-cli",
  agy: "antigravity-cli",
};

/** Accepts a canonical provider id or a short alias; yields the canonical id. */
export const ProviderRefSchema = z.preprocess(
  (v) => (typeof v === "string" ? (PROVIDER_ALIASES[v] ?? v) : v),
  ProviderIdSchema,
);

/** Closed set of context-trimming engines. `trim1` degrades to the no-op trimmer when its binary is absent. */
export const TRIM_ENGINES = ["trim1", "noop"] as const;

/** trim-1's three documented operating points (docs/osa/TRIM1_NOTES.md). */
export const TRIM_POINTS = ["conservative", "balanced", "aggressive"] as const;

const IntakeConfig = z.strictObject({
  /** Auto-lock (unattended / `--yes`) only when there are zero `risky` assumptions. */
  autoLockWhenNoRisky: z.boolean().default(true),
  /**
   * Quote the rules the person stated into the acceptance criteria, word for word (intake asks for them, only quotes that really occur in the
   * prompt are kept, each becomes a criterion). OFF by default: in the test-hardening runs most of those criteria were trivial ("Build a small
   * Python command-line tool called wordstat") and cost tokens without catching anything (docs/osa/TEST_REPORT.md, Suite 9).
   */
  quoteStatedRules: z.boolean().default(false),
});

const ResearchConfig = z.strictObject({
  enabled: z.boolean().default(true),
  /** A spec with zero documentation sources fails the phase. */
  docsRequired: z.boolean().default(true),
  /** arXiv + OpenAlex search in the spec phase. */
  academic: z.boolean().default(true),
  /** Sent as the OpenAlex `mailto` parameter (polite pool). Empty = omit. */
  openalexMailto: z.string().default(""),
  /** Optional Semantic Scholar source; additionally requires `S2_API_KEY` in the environment. */
  semanticScholar: z.boolean().default(false),
  githubLookup: z.boolean().default(true),
  /** Reviewer on a different provider checks report.md against its cited sources. */
  crossProviderCheck: z.boolean().default(true),
  /** Upper bound on research items generated from a PRD (keeps a run bounded). */
  maxItems: z.number().int().min(1).max(64).default(8),
  /** Research agents dispatched concurrently per batch. */
  batchSize: z.number().int().min(1).max(16).default(4),
});

const TrimConfig = z.strictObject({
  /**
   * The switch for the whole trim-1 plug-in. OFF by default: when off, no trim-1 module is loaded, no binary is probed or spawned, and the
   * handoffs use the no-op trimmer. (It removed 0.3-2.8 % of a run's tokens in the test-hardening measurements.)
   */
  enabled: z.boolean().default(false),
  engine: z.enum(TRIM_ENGINES).default("trim1"),
  /** Path to a locally-installed trim-1 `trim` binary. Empty = look it up on PATH. */
  binaryPath: z.string().default(""),
  /** trim-1 operating point to start from (it has no token-budget knob; budget is met by stepping up). */
  point: z.enum(TRIM_POINTS).default("balanced"),
  /** Default token budget for a handoff when the caller supplies none. */
  budgetTokens: z.number().int().min(100).default(6000),
});

const AgentsConfig = z.strictObject({
  /** After the spec, before build: second-order consequences -> acceptance criteria / out-of-scope lines in the SPEC. */
  implication: z.boolean().default(true),
  /** Default: the other provider of the pair (an independent read of the spec). */
  implicationProvider: ProviderRefSchema.optional(),
  /** Proposes a materially different architecture; the planner records which was chosen and why. */
  lateralArchitecture: z.boolean().default(true),
  /** Must differ from the planner's provider (`providers.pair[0]`) unless `lateralArchitecturePinned`. */
  lateralArchitectureProvider: ProviderRefSchema.default("codex-cli"),
  /**
   * Explicitly allow the lateral agent to run on the SAME provider as the planner. Off by default: a planner
   * critiquing its own architecture is self-review. When on, the run proceeds with a loud warning.
   */
  lateralArchitecturePinned: z.boolean().default(false),
  /** After build: exercises the result against the acceptance criteria; unmet criteria fail the run. */
  application: z.boolean().default(true),
  /** Default: the provider of the pair that can run commands, preferring `providers.pair[1]`. */
  applicationProvider: ProviderRefSchema.optional(),
});

const IndexConfig = z.strictObject({
  enabled: z.boolean().default(true),
  /** "local" = built-in hashed-TF-IDF embedder (no network, no dependency). */
  embedder: z.enum(["local"]).default("local"),
  /** Hits injected into each phase's handoff context ("where to look first"). */
  topK: z.number().int().min(1).max(30).default(8),
  /**
   * Which engine ranks the results. "lexical" (default) is OSA's own offline index. "cbm" is codebase-memory-mcp behind OSA's confidence
   * guard, with the lexical index as the fallback; it is OFF by default because on the 40-query eval it did not meet the confident-wrong
   * bar (docs/osa/TEST_REPORT.md, suite 7).
   */
  engine: z.enum(["lexical", "cbm"]).default("lexical"),
  /** Where the codebase-memory-mcp binary and its private work directory live (both required for engine "cbm"; docs/osa/CBM_NOTES.md). */
  cbm: z
    .strictObject({
      binaryPath: z.string().default(""),
      workDir: z.string().default(""),
      indexMode: z.enum(["full", "moderate"]).default("full"),
    })
    .prefault({}),
});

const MemoryConfig = z.strictObject({
  enabled: z.boolean().default(true),
  /** Oldest facts are dropped beyond this many per memory file. */
  maxFactsPerFile: z.number().int().min(10).max(2000).default(200),
  /** Cap on the memory block handed to intake / the spec author. */
  readBudgetChars: z.number().int().min(200).max(20000).default(3000),
});

const ProvidersConfig = z.strictObject({
  /** The two providers a run activates (executor/reviewer alternate between them). */
  pair: z
    .tuple([ProviderRefSchema, ProviderRefSchema])
    .refine(([a, b]) => a !== b, "providers.pair must be two different providers")
    .default(["claude-code", "codex-cli"]),
  /** Optional exclusive-role pins, same semantics as RunConfig.role_pins. */
  rolePins: z.partialRecord(ProviderIdSchema, RolePinSchema).optional(),
  /**
   * Per-provider model override (same semantics as RunConfig.model_overrides), applied to every OSA text
   * call and every build turn. Needed when a provider CLI's own configured default is unusable -- e.g. a
   * Codex default the account no longer supports.
   */
  modelOverrides: z.partialRecord(ProviderIdSchema, z.string().min(1)).optional(),
  /** Per-turn timeout for build-phase turns. */
  turnTimeoutMs: z.number().int().min(1000).max(7_200_000).default(1_800_000),
  /** Timeout for intake / research / agent text calls. */
  textTimeoutMs: z.number().int().min(1000).max(7_200_000).default(900_000),
});

/** The full OSA project configuration. Every key defaults, so `{}` is a valid config. */
export const OsaConfig = z
  .strictObject({
    intake: IntakeConfig.prefault({}),
    research: ResearchConfig.prefault({}),
    trim: TrimConfig.prefault({}),
    agents: AgentsConfig.prefault({}),
    index: IndexConfig.prefault({}),
    memory: MemoryConfig.prefault({}),
    providers: ProvidersConfig.prefault({}),
  });

/** The parsed (defaults applied) configuration. */
export type OsaConfig = z.infer<typeof OsaConfig>;

/** The all-defaults configuration. */
export function defaultOsaConfig(): OsaConfig {
  return OsaConfig.parse({});
}
