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
  opencode: "opencode-cli",
  copilot: "copilot-cli",
  "github-copilot": "copilot-cli",
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
  /** Default: the second seat's provider (an independent read of the spec). */
  implicationProvider: ProviderRefSchema.optional(),
  /** Proposes a materially different architecture; the planner records which was chosen and why. */
  lateralArchitecture: z.boolean().default(true),
  /**
   * Which provider runs the lateral agent. Absent = OSA picks the most independent seat available (a different model family if there is one,
   * else a different capability class, else a different model) and says how independent it is. Any provider and any model can be named;
   * naming the planner's own is allowed (it is reported, never refused).
   */
  lateralArchitectureProvider: ProviderRefSchema.optional(),
  /** The model for the lateral agent when `lateralArchitectureProvider` is named. Absent = that provider's default. */
  lateralArchitectureModel: z.string().min(1).optional(),
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
   * Which engine ranks the results. "lexical" (default) is OSA's own offline index. "hybrid" re-ranks the lexical candidates by MEANING with an
   * embeddings model you configure under `index.semantic` (docs/osa/SEMANTIC.md); it needs an endpoint and is off until you set one. "cbm" is
   * codebase-memory-mcp with a model-written query rewrite and a tuned channel mix (docs/osa/CBM_NOTES.md); it needs the CBM binary, so it is OFF by default.
   */
  engine: z.enum(["lexical", "cbm", "hybrid"]).default("lexical"),
  /** The embeddings endpoint for engine "hybrid": any OpenAI-compatible `/embeddings` API (hosted with a key, or a local server without one). */
  semantic: z
    .strictObject({
      /** The base URL of the API (a hosted one, or a local server on localhost such as an Ollama or LM Studio endpoint). https is required except for localhost. */
      baseUrl: z.string().default(""),
      model: z.string().default(""),
      /** The NAME of the environment variable holding the key (the key itself is never written in a file). Empty = send no key. */
      apiKeyEnv: z.string().default("OSA_EMBEDDINGS_API_KEY"),
      /** How many chunks are considered per query (lexical top hits, then the rest of the index up to this many). */
      candidateLimit: z.number().int().min(10).max(2000).default(300),
      batchSize: z.number().int().min(1).max(256).default(64),
      timeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
    })
    .prefault({}),
  /**
   * Query rewriting for engine "cbm": a small model turns the question into the identifiers and keywords the code likely contains, and those are
   * searched IN ADDITION to the question (the question is never dropped). One cheap call per new question, cached in .osa/index/rewrites.json. Unavailable
   * or failing = the search runs on the question alone. On 70 labelled queries it lifted right-file-in-top-5 from 64% to 79% (docs/osa/CBM_NOTES.md, section 6).
   */
  rewrite: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Default: the first seat's provider. */
      provider: ProviderRefSchema.optional(),
      /** Default: the provider's cheapest known model, else its own default. */
      model: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
    })
    .prefault({}),
  /** Where the codebase-memory-mcp binary and its private work directory live (both required for engine "cbm"; docs/osa/CBM_NOTES.md). */
  cbm: z
    .strictObject({
      binaryPath: z.string().default(""),
      workDir: z.string().default(""),
      indexMode: z.enum(["full", "moderate"]).default("full"),
      /**
       * Abstain-and-fall-back mode (the original design): when a confidence guard doubts the top hit the engine answers from the lexical index instead.
       * OFF by default: it cut confident-wrong answers but abstained on 65% of questions and lowered right-file-in-top-5 from 72% to 47% (an agent can
       * open a file and check it, so it is better served by a ranked list than by silence).
       */
      abstain: z.boolean().default(false),
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
  /**
   * The two seats a run uses: seat 0 plans, writes the first executor turn and (by default) reviews; seat 1 writes the second executor turn,
   * whose work seat 0 then reviews. The two may be the SAME provider on different models (`seatModels`), which is how one subscription is
   * enough. If a config FILE does not set `pair` at all, OSA picks the seats itself from the providers that are installed and signed in.
   */
  pair: z.tuple([ProviderRefSchema, ProviderRefSchema]).default(["claude-code", "codex-cli"]),
  /** The model each seat uses (`null` = that provider's own default). With the pair set and a model left null, OSA may choose one (see `independence`). */
  seatModels: z.tuple([z.string().min(1).nullable(), z.string().min(1).nullable()]).default([null, null]),
  /**
   * Models a provider may be asked to use, for choosing a reviewer from a different model class. Absent = the provider's well-known aliases
   * (Claude Code: opus, sonnet, haiku). Name them here for providers whose models differ per account (Codex, OpenCode, Copilot).
   */
  models: z.partialRecord(ProviderIdSchema, z.array(z.string().min(1)).min(1)).optional(),
  /**
   * "auto" (default): where the config leaves a seat's model open and the two seats would otherwise be the same model, OSA picks models from
   * different capability classes. "off": use `pair` and `seatModels` exactly as written. Neither mode ever refuses a configuration; a
   * weak review is reported in the log and the run summary, with advice on how to make it more independent.
   */
  independence: z.enum(["auto", "off"]).default("auto"),
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
