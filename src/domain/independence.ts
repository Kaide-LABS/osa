// How independent is a reviewer from the work it reviews? OSA used to refuse any configuration where the reviewer ran on the
// same provider as the author. That made OSA unusable for a person who can only afford one provider, and it measured the wrong
// thing: the bias that matters (a model favouring its own output) belongs to the MODEL, not to the vendor's command-line tool.
//
// This module ranks a reviewer against the author on a ladder and never refuses. It knows no model names (boundary rule B7):
// a caller passes a classifier (`src/adapters/model-classes.ts`) that says which family and capability band a model is in.

import type { ProviderId } from "./run.ts";

/** A seat: who does a job. `model: null` means "whatever the provider's own CLI picks by default". */
export interface Seat {
  readonly provider: ProviderId;
  readonly model: string | null;
}

/** Capability band within a model family. `unknown` when the model is not recognised. */
export type PowerBand = "high" | "mid" | "low" | "unknown";

/** What a model is. `family` is a lower-case vendor-neutral label (or `"unknown"`). */
export interface ModelClass {
  readonly family: string;
  readonly band: PowerBand;
}

/** Says which class a seat's model belongs to. */
export type ModelClassifier = (seat: Seat) => ModelClass;

/**
 * Strongest first. A reviewer should reach as far down this list as the available seats allow; none of them is ever a reason to stop.
 *  - different-family   the two models come from different model families (e.g. a Claude model reviewed by a GPT model)
 *  - different-class    same family, different capability band (e.g. a mid-size model reviewed by the largest one)
 *  - different-provider the providers differ and at least one family is not recognised, so a family claim cannot be made
 *  - different-model    same family and band, but demonstrably a different model
 *  - unverified         one side uses the CLI's default model, so it may or may not be the same model as the other
 *  - same-model         the same model reviews its own work (still allowed; OSA says so plainly)
 */
export const INDEPENDENCE_LEVELS = ["different-family", "different-class", "different-provider", "different-model", "unverified", "same-model"] as const;

/** A member of {@link INDEPENDENCE_LEVELS}. */
export type Independence = (typeof INDEPENDENCE_LEVELS)[number];

/** Rank of a level; higher is more independent. */
export function independenceRank(level: Independence): number {
  return INDEPENDENCE_LEVELS.length - INDEPENDENCE_LEVELS.indexOf(level);
}

const BAND_RANK: Readonly<Record<PowerBand, number>> = { high: 3, mid: 2, low: 1, unknown: 0 };

/** Capability rank of a band (higher = more capable). */
export function bandRank(band: PowerBand): number {
  return BAND_RANK[band];
}

/** How independent `reviewer` is from `author`. Pure and symmetric. */
export function independenceOf(author: Seat, reviewer: Seat, classify: ModelClassifier): Independence {
  const a = classify(author);
  const r = classify(reviewer);
  const familiesKnown = a.family !== "unknown" && r.family !== "unknown";
  if (familiesKnown) {
    if (a.family !== r.family) return "different-family";
    if (a.band !== "unknown" && r.band !== "unknown" && a.band !== r.band) return "different-class";
  } else if (author.provider !== reviewer.provider) {
    return "different-provider";
  }
  const am = author.model;
  const rm = reviewer.model;
  if (am !== null && rm !== null) return am.toLowerCase() === rm.toLowerCase() ? "same-model" : "different-model";
  if (am === null && rm === null) return "same-model";
  return "unverified";
}

/** One candidate considered for the reviewer's seat, with how independent it would be. */
export interface RankedSeat {
  readonly seat: Seat;
  readonly level: Independence;
}

/**
 * The most independent reviewer among `candidates` for work done by `author`. Ties go to the more capable model (a reviewer should not
 * be weaker than the author when it can be avoided), then to the earlier candidate. `null` only when there are no candidates.
 */
export function chooseReviewerSeat(author: Seat, candidates: readonly Seat[], classify: ModelClassifier): RankedSeat | null {
  let best: { ranked: RankedSeat; power: number } | null = null;
  for (const seat of candidates) {
    const level = independenceOf(author, seat, classify);
    const power = bandRank(classify(seat).band);
    const better =
      best === null ||
      independenceRank(level) > independenceRank(best.ranked.level) ||
      (independenceRank(level) === independenceRank(best.ranked.level) && power > best.power);
    if (better) best = { ranked: { seat, level }, power };
  }
  return best === null ? null : best.ranked;
}

/** Plain-language account of a review's independence, for the run summary and the log. No model names are invented: seats print as given. */
export function describeIndependence(level: Independence, author: Seat, reviewer: Seat): string {
  const name = (s: Seat): string => (s.model === null ? s.provider : `${s.provider} (${s.model})`);
  const pair = `${name(reviewer)} reviewed work written by ${name(author)}`;
  switch (level) {
    case "different-family":
      return `${pair}: a different model family, the most independent kind of check.`;
    case "different-class":
      return `${pair}: the same model family but a different capability class.`;
    case "different-provider":
      return `${pair}: a different provider (the model families could not be compared).`;
    case "different-model":
      return `${pair}: a different model of the same kind. Using a different model family, or a more capable model, would make the check more independent.`;
    case "unverified":
      return `${pair}: one side uses its tool's default model, so it may be the same model. Name a model for each seat to make the check verifiable.`;
    case "same-model":
      return `${pair}: the same model. This works, but a model tends to favour its own output; a second model, ideally from another family, would make the check more independent.`;
  }
}
