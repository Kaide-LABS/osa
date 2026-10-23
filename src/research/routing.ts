// Provider routing for research (WS3.2): research runs on the providers' OWN built-in web search, so the
// researcher must be a provider that has one. If the first active provider lacks it, route to the other and
// say so (`research_routed`). The cross-provider reviewer is always the *other* provider of the pair.

import { StageError } from "../domain/errors.ts";
import type { ProviderId } from "../domain/run.ts";

/** Who researches and who checks, and whether the choice differs from the default. */
export interface ResearchRouting {
  readonly researcher: ProviderId;
  readonly reviewer: ProviderId;
  /** The researcher is not `pair[0]` because `pair[0]` has no built-in web search. */
  readonly routedAway: boolean;
  /** The reviewer can open sources itself; if not, its check is consistency-only (reported as degraded). */
  readonly reviewerHasWebSearch: boolean;
  readonly reason: string;
}

/**
 * Chooses researcher and reviewer from the run's provider pair. Throws {@link StageError} loudly when
 * neither provider has web search (research would be unverifiable) or when the pair is not two distinct
 * providers (a same-provider "cross check" is a self-review, which OSA never does silently).
 */
export function chooseResearchProviders(
  pair: readonly [ProviderId, ProviderId],
  hasWebSearch: (p: ProviderId) => boolean,
  /** True for a provider whose web-enabled call has NO file access at all (the researcher reads the most untrusted pages). */
  hasNoFileAccess: (p: ProviderId) => boolean = () => false,
): ResearchRouting {
  const [first, second] = pair;
  if (first === second) {
    throw new StageError(`Research needs two different providers (researcher and reviewer); got ${first} twice.`, { pair });
  }
  const withWeb = [first, second].filter((p) => hasWebSearch(p));
  // Prefer the provider that cannot read local files: it is the one fetching many attacker-controllable pages.
  const researcher = withWeb.find((p) => hasNoFileAccess(p)) ?? withWeb[0] ?? null;
  if (researcher === null) {
    throw new StageError(
      `Neither ${first} nor ${second} has a built-in web search tool, so research cannot be done on a verifiable footing. ` +
        "Pick a provider pair that includes one with web search (Claude Code or Codex CLI), or set research.enabled to false.",
      { pair },
    );
  }
  const reviewer = researcher === first ? second : first;
  const routedAway = researcher !== first;
  return {
    researcher,
    reviewer,
    routedAway,
    reviewerHasWebSearch: hasWebSearch(reviewer),
    reason: routedAway
      ? hasWebSearch(first)
        ? `${second} researches because ${first} can read local files while browsing; ${second} cannot.`
        : `${first} has no built-in web search; research routed to ${second}.`
      : `${researcher} has built-in web search.`,
  };
}
