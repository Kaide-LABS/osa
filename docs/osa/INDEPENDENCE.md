# Review independence: separating author and reviewer by model

OSA used to refuse any run whose reviewer was on the same provider as the author ("cross-provider review is mandatory"). That rule is
gone. It made OSA unusable for a person who can only pay for one provider, and it measured the wrong thing: the bias a second look is
meant to remove is a **model** favouring its own output (see the self-preference literature cited in `src/dispatch/plan.ts`), and that
belongs to the model, not to the vendor's command-line tool. Two tools can front the same model; one tool can front several.

## The rule now

A run has two **seats**. Seat 0 plans, writes the first executor turn and, by default, reviews. Seat 1 writes the second executor turn,
whose work seat 0 reviews. A seat is a provider **and a model** (`providers.pair`, `providers.seatModels`).

OSA never refuses a configuration. It ranks how independent the reviewer is from the author (`src/domain/independence.ts`), logs it
(`review_independence`), shows it in the run report and summary, and says how to improve it when it is weak. The ladder, strongest first:

| Level | Meaning |
|---|---|
| `different-family` | the models come from different families (e.g. Claude vs GPT) |
| `different-class` | same family, different capability band (e.g. mid-size writes, largest reviews) |
| `different-provider` | the providers differ and a family could not be recognised on at least one side |
| `different-model` | same family and band, demonstrably a different model |
| `unverified` | one side uses its tool's default model, so it may be the same model |
| `same-model` | the same model reviews its own work (allowed; a warning with advice) |

Where a choice is open (a seat's model left unset, or a role like the lateral-architecture agent with no provider named), OSA picks the
most independent seat available and, on a tie, the more capable model (a reviewer should not be weaker than the author when avoidable).

## How seats are chosen

1. `providers.pair` **not set** in `osa.config.json`: OSA probes the five supported tools and uses the healthy ones.
   * two or more: the pair with the most different families, ties to the verified-first order (Claude Code, Codex, OpenCode, Copilot, Antigravity);
   * one: both seats on it, models chosen from `providers.models[provider]`, else the adapter's known aliases (Claude Code:
     `opus`/`sonnet`/`haiku`): a mid-size model writes, the strongest reviews.
2. `providers.pair` set: used as written. Where it names one provider twice and `independence` is `"auto"` (default), the unset seat models
   are chosen as above. `"independence": "off"` uses the config exactly.
3. Models the person names (`seatModels`) are never overridden.

## What "model class" means

`src/adapters/model-classes.ts` (the only place concrete model names may appear, boundary rule B7) classifies a model **by name pattern**,
so a model released after the file was written is still recognised if it follows its vendor's naming. A class is `family` (claude, gpt,
gemini, deepseek, ...) and capability `band` (high / mid / low / unknown). Unrecognised models are `unknown`, which the ladder treats
cautiously (never as a failure). A seat on its tool's default model is classified by what that tool is known to serve (Claude Code: the
Claude family, band unknown), which is why a default-vs-named pair reads as `unverified`.

## Where it applies

The build review (seat 0 reviews seat 1's diff), the research cross-check (the second seat researches, the first checks), the lateral
architecture agent, and the implication and application agents (they take the seat they run on). `osa doctor` needs one healthy provider and
only warns about installed-but-broken others.

## Limits to know about

* Discovery of a provider's models is not uniform: only OpenCode lists them (`opencode models --standalone`); for the other tools OSA uses its
  alias list or `providers.models`. A model your account cannot use fails the first call with the provider's own message.
* With a single provider whose models OSA cannot list (Codex, Copilot, OpenCode without `providers.models`), both seats fall to the tool's
  default model and the review is `same-model`; the warning says what to set.
* Research needs at least one seat with working web search (Claude Code or Codex today). OpenCode's `websearch` tool did not work headless
  and Copilot's is unverified, so an OpenCode-only or Copilot-only setup stops at research with a clear message unless `research.enabled` is false.
