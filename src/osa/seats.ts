// Who sits where. A run has two SEATS: seat 0 plans, writes the first executor turn and (by default) reviews; seat 1 writes the second
// executor turn, whose work seat 0 then reviews. A seat is a provider AND a model, so one provider on two models is a valid pair: that is
// how a person with a single subscription still gets a review by a different model.
//
// Nothing here refuses. OSA used to insist on two different providers; the bias a review is meant to remove belongs to the model, not to the
// vendor's tool (src/domain/independence.ts). `planSeats` picks the most independent arrangement the available providers and models allow,
// and says plainly how independent it is.

import { UsageError } from "../domain/errors.ts";
import { chooseReviewerSeat, describeIndependence, independenceOf, independenceRank, bandRank } from "../domain/independence.ts";
import type { Independence, ModelClassifier, Seat } from "../domain/independence.ts";
import type { OsaConfig } from "../domain/osa-config.ts";
import type { ProviderId } from "../domain/run.ts";
import { classifyModel, knownModels } from "../adapters/model-classes.ts";
import type { PreflightSummary } from "../verify/preflight.ts";

/** Tie-break order when several providers are usable: the ones OSA has been verified against first. */
export const PROVIDER_PREFERENCE: readonly ProviderId[] = ["claude-code", "codex-cli", "opencode-cli", "copilot-cli", "antigravity-cli"];

/** The providers that passed preflight, in {@link PROVIDER_PREFERENCE} order. Pure. */
export function healthyProviders(summary: Pick<PreflightSummary, "providers">): ProviderId[] {
  const ok = new Set(summary.providers.filter((p) => p.problems.length === 0).map((p) => p.provider));
  return PROVIDER_PREFERENCE.filter((p) => ok.has(p));
}

export interface SeatInput {
  readonly config: OsaConfig;
  /** The config file set `providers.pair` itself (otherwise OSA chooses the providers). */
  readonly pairSet: boolean;
  /** Providers that passed preflight. Ignored when the pair is set. */
  readonly healthy: readonly ProviderId[];
  /** Models a provider reported (e.g. `opencode models`). Used when neither the config nor the adapter names any. */
  readonly discovered?: Readonly<Partial<Record<ProviderId, readonly string[]>>>;
  readonly classify?: ModelClassifier;
}

export interface SeatPlan {
  readonly pair: readonly [ProviderId, ProviderId];
  readonly seatModels: readonly [string | null, string | null];
  /** Every seat OSA may hand an independent job to (lateral agent, reviewers): each usable provider on each of its known models. */
  readonly candidates: readonly Seat[];
  /** The build review: seat 1 writes, seat 0 reviews. */
  readonly review: { readonly author: Seat; readonly reviewer: Seat; readonly level: Independence };
  /** True when OSA chose the providers (the config did not set a pair). */
  readonly auto: boolean;
  /** Plain-language account of the choice, for the run log and the summary. */
  readonly notes: readonly string[];
}

function modelsFor(input: SeatInput, provider: ProviderId): readonly string[] {
  return input.config.providers.models?.[provider] ?? input.discovered?.[provider] ?? knownModels(provider);
}

function seatsOf(input: SeatInput, provider: ProviderId): Seat[] {
  const models = modelsFor(input, provider);
  return models.length === 0 ? [{ provider, model: null }] : models.map((model) => ({ provider, model }));
}

/** The author seat among one provider's models: a mid-capability model if there is one (the reviewer can then be stronger), else the first. */
function pickAuthor(candidates: readonly Seat[], classify: ModelClassifier): Seat | null {
  const mid = candidates.find((s) => classify(s).band === "mid");
  if (mid !== undefined) return mid;
  const known = candidates.filter((s) => classify(s).band !== "unknown").sort((a, b) => bandRank(classify(a).band) - bandRank(classify(b).band));
  return known[0] ?? candidates[0] ?? null;
}

/** Both seats on ONE provider: choose its models so that the reviewer is as independent from the author as that provider's models allow. */
function sameProviderSeats(provider: ProviderId, candidates: readonly Seat[], set: readonly [string | null, string | null], classify: ModelClassifier): [Seat, Seat] {
  const [m0, m1] = set;
  if (m0 !== null && m1 !== null) return [{ provider, model: m0 }, { provider, model: m1 }];
  if (m1 !== null) {
    const author: Seat = { provider, model: m1 };
    return [m0 !== null ? { provider, model: m0 } : (chooseReviewerSeat(author, candidates, classify)?.seat ?? { provider, model: null }), author];
  }
  if (m0 !== null) {
    const reviewer: Seat = { provider, model: m0 };
    return [reviewer, chooseReviewerSeat(reviewer, candidates, classify)?.seat ?? { provider, model: null }];
  }
  const author = pickAuthor(candidates, classify) ?? { provider, model: null };
  return [chooseReviewerSeat(author, candidates, classify)?.seat ?? { provider, model: null }, author];
}

/** The best ordered pair of DIFFERENT providers among the usable ones: the most independent, ties to the earlier in the preference order. */
function bestProviderPair(healthy: readonly ProviderId[], classify: ModelClassifier): [ProviderId, ProviderId] {
  let best: { pair: [ProviderId, ProviderId]; rank: number } | null = null;
  for (const a of healthy) {
    for (const b of healthy) {
      if (a === b) continue;
      const rank = independenceRank(independenceOf({ provider: b, model: null }, { provider: a, model: null }, classify));
      if (best === null || rank > best.rank) best = { pair: [a, b], rank };
    }
  }
  return (best as { pair: [ProviderId, ProviderId] }).pair;
}

/** Chooses the two seats. Never refuses a configuration; throws {@link UsageError} only when no provider is usable at all. */
export function planSeats(input: SeatInput): SeatPlan {
  const classify = input.classify ?? classifyModel;
  const { providers } = input.config;
  const notes: string[] = [];
  const auto = !input.pairSet;

  let seat0: Seat;
  let seat1: Seat;
  let usable: ProviderId[];

  if (auto) {
    if (input.healthy.length === 0) {
      throw new UsageError("No AI provider is usable: install and sign in to at least one of Claude Code, Codex CLI, Antigravity CLI, OpenCode or GitHub Copilot CLI (run `osa doctor` to see what is missing).");
    }
    usable = [...input.healthy];
    if (usable.length >= 2) {
      const [a, b] = bestProviderPair(usable, classify);
      seat0 = { provider: a, model: providers.seatModels[0] };
      seat1 = { provider: b, model: providers.seatModels[1] };
      notes.push(`OSA chose ${a} and ${b} from the providers that are installed and signed in.`);
    } else {
      const only = usable[0] as ProviderId;
      [seat0, seat1] = providers.independence === "off" ? [{ provider: only, model: providers.seatModels[0] }, { provider: only, model: providers.seatModels[1] }] : sameProviderSeats(only, seatsOf(input, only), providers.seatModels, classify);
      notes.push(`Only ${only} is installed and signed in, so one provider fills both seats; the review is separated by model instead.`);
    }
  } else {
    const [p0, p1] = providers.pair;
    usable = [...new Set([p0, p1])];
    if (p0 === p1 && providers.independence === "auto") {
      [seat0, seat1] = sameProviderSeats(p0, seatsOf(input, p0), providers.seatModels, classify);
    } else {
      seat0 = { provider: p0, model: providers.seatModels[0] };
      seat1 = { provider: p1, model: providers.seatModels[1] };
    }
  }

  const level = independenceOf(seat1, seat0, classify);
  notes.push(describeIndependence(level, seat1, seat0));
  if (level === "same-model" || level === "unverified") {
    const p = seat0.provider;
    notes.push(
      seat0.provider === seat1.provider
        ? `To make the review more independent, install a second provider (ideally from another model family), or name models in osa.config.json: providers.seatModels, and providers.models.${p} if ${p}'s models are not recognised automatically.`
        : "To make the review more independent, name a model for each seat in osa.config.json (providers.seatModels).",
    );
  }

  const candidates: Seat[] = [];
  const seen = new Set<string>();
  for (const s of [seat0, seat1, ...usable.flatMap((p) => seatsOf(input, p))]) {
    const key = `${s.provider}|${s.model ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(s);
    }
  }
  return { pair: [seat0.provider, seat1.provider], seatModels: [seat0.model, seat1.model], candidates, review: { author: seat1, reviewer: seat0, level }, auto, notes };
}

/** The config with the chosen seats written into `providers`. */
export function applySeatPlan(config: OsaConfig, plan: SeatPlan): OsaConfig {
  return { ...config, providers: { ...config.providers, pair: [plan.pair[0], plan.pair[1]], seatModels: [plan.seatModels[0], plan.seatModels[1]] } };
}

/**
 * The model to ask `provider` for. A provider that holds one seat uses that seat's model; one that holds both uses seat `preferSeat`
 * (default 0, the planner). A provider in no seat uses the operator's per-provider override. `null` = the provider's own default.
 */
export function modelFor(config: OsaConfig, provider: ProviderId, preferSeat: 0 | 1 = 0): string | null {
  const { pair, seatModels } = config.providers;
  const holds = [pair[0] === provider, pair[1] === provider];
  const seat = holds[preferSeat] ? preferSeat : holds[0] ? 0 : holds[1] ? 1 : null;
  const fromSeat = seat === null ? null : seatModels[seat];
  return fromSeat ?? config.providers.modelOverrides?.[provider] ?? null;
}

/** A seat as one short label: `provider` or `provider (model)`. */
export function seatKey(s: Seat): string {
  return s.model === null ? s.provider : `${s.provider} (${s.model})`;
}
