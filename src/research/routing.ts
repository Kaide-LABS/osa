// Provider routing for research (WS3.2): research runs on the providers' OWN built-in web search, so the
// researcher must be a seat whose provider has one. If the first seat lacks it, route to the other and say so
// (`research_routed`). The reviewer is always the OTHER seat -- a different provider when the pair has two, otherwise a different model of the
// same provider (src/domain/independence.ts ranks how independent that is; it is reported, never refused).

import { StageError } from "../domain/errors.ts";
import type { ProviderId } from "../domain/run.ts";

/** Who researches and who checks, and whether the choice differs from the default. */
export interface ResearchRouting {
  readonly researcher: ProviderId;
  readonly reviewer: ProviderId;
  /** The model each uses (`null` = the provider's default). */
  readonly researcherModel: string | null;
  readonly reviewerModel: string | null;
  /** The researcher is not the first seat because the first seat's provider has no built-in web search (or can read local files while browsing). */
  readonly routedAway: boolean;
  /** The reviewer can open sources itself; if not, its check is consistency-only (reported as degraded). */
  readonly reviewerHasWebSearch: boolean;
  readonly reason: string;
}

/**
 * Chooses researcher and reviewer from the run's two seats. Throws {@link StageError} loudly only when neither seat's provider has web search
 * (research would be unverifiable). When both seats are the same provider, the second seat researches and the first (stronger) seat checks.
 */
export function chooseResearchProviders(
  pair: readonly [ProviderId, ProviderId],
  hasWebSearch: (p: ProviderId) => boolean,
  /** True for a provider whose web-enabled call has NO file access at all (the researcher reads the most untrusted pages). */
  hasNoFileAccess: (p: ProviderId) => boolean = () => false,
  /** The model of each seat. */
  models: readonly [string | null, string | null] = [null, null],
): ResearchRouting {
  const [first, second] = pair;
  const withWeb = ([0, 1] as const).filter((i) => hasWebSearch(pair[i]));
  let researcherIdx: 0 | 1;
  if (withWeb.length === 0) {
    throw new StageError(
      `Neither ${first} nor ${second} has a built-in web search tool, so research cannot be done on a verifiable footing. ` +
        "Use a provider with web search (Claude Code or Codex CLI) for at least one seat, or set research.enabled to false.",
      { pair },
    );
  }
  if (first === second) {
    researcherIdx = 1; // the same provider twice: the second seat researches, the first (stronger) seat checks
  } else {
    // Prefer the provider that cannot read local files: it is the one fetching many attacker-controllable pages.
    researcherIdx = withWeb.find((i) => hasNoFileAccess(pair[i])) ?? (withWeb[0] as 0 | 1);
  }
  const reviewerIdx = researcherIdx === 0 ? 1 : 0;
  const researcher = pair[researcherIdx];
  const reviewer = pair[reviewerIdx];
  const routedAway = first !== second && researcherIdx !== 0;
  return {
    researcher,
    reviewer,
    researcherModel: models[researcherIdx],
    reviewerModel: models[reviewerIdx],
    routedAway,
    reviewerHasWebSearch: hasWebSearch(reviewer),
    reason: routedAway
      ? hasWebSearch(first)
        ? `${second} researches because ${first} can read local files while browsing; ${second} cannot.`
        : `${first} has no built-in web search; research routed to ${second}.`
      : `${researcher} has built-in web search.`,
  };
}
