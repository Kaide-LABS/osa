// Which model rewrites search questions. The rewrite is a tiny task (turn a question into likely code names), so it should run on the CHEAPEST model
// available, not on the planner's. Chosen without probing anything: the configured provider and model if given, else the lowest capability band
// among the models OSA knows for the planner's provider (Claude Code: its small model), else that provider's own default. A rewrite that cannot
// run is never an error (the search then runs on the question alone), so no preflight is needed.

import { classifyModel, knownModels } from "../adapters/model-classes.ts";
import { bandRank } from "../domain/independence.ts";
import type { OsaConfig } from "../domain/osa-config.ts";
import type { ProviderId } from "../domain/run.ts";

export interface RewriteSeat {
  readonly provider: ProviderId;
  /** `null` = the provider's own default model. */
  readonly model: string | null;
  readonly timeoutMs: number;
}

/** The cheapest known model of `provider`: the lowest KNOWN band (never an unrecognised model), or `null` when none is known. Pure. */
export function cheapestModel(provider: ProviderId, configured: readonly string[] | undefined): string | null {
  const models = configured ?? knownModels(provider);
  const known = models.filter((model) => classifyModel({ provider, model }).band !== "unknown");
  known.sort((a, b) => bandRank(classifyModel({ provider, model: a }).band) - bandRank(classifyModel({ provider, model: b }).band));
  return known[0] ?? null;
}

/** The seat that rewrites search questions under `config`, or `null` when rewriting is switched off. Pure. */
export function rewriteSeatFor(config: Pick<OsaConfig, "index" | "providers">): RewriteSeat | null {
  const r = config.index.rewrite;
  if (!r.enabled) return null;
  const provider = r.provider ?? config.providers.pair[0];
  const model = r.model ?? cheapestModel(provider, config.providers.models?.[provider]) ?? config.providers.modelOverrides?.[provider] ?? null;
  return { provider, model, timeoutMs: r.timeoutMs };
}
