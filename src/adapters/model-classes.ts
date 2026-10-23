// What each provider's models are, in vendor-neutral terms (family + capability band). Concrete model names are allowed here and only
// here (boundary rule B7): the rest of OSA sees `ModelClass` values and never a model name.
//
// Recognition is by NAME PATTERN, not by a fixed list, so a model released after this file was written is still classified when it
// follows its vendor's naming (a new Claude "opus", a new "gpt-N-mini", a new "gemini-N-flash"). Anything unrecognised is
// `{ family: "unknown", band: "unknown" }` and is treated cautiously by the independence ladder, never as a failure.

import type { ModelClass, PowerBand, Seat } from "../domain/independence.ts";
import type { ProviderId } from "../domain/run.ts";

const UNKNOWN: ModelClass = { family: "unknown", band: "unknown" };

/** Strips a routing prefix such as `anthropic/` or `github-copilot/` and a `#variant` suffix; lower-cases. */
function bareName(model: string): { readonly vendor: string | null; readonly name: string } {
  const noVariant = model.split("#")[0] ?? model;
  const slash = noVariant.lastIndexOf("/");
  return slash < 0 ? { vendor: null, name: noVariant.toLowerCase() } : { vendor: noVariant.slice(0, slash).toLowerCase(), name: noVariant.slice(slash + 1).toLowerCase() };
}

interface FamilyRule {
  readonly family: string;
  /** Matches a bare model name. */
  readonly test: RegExp;
  readonly band: (name: string) => PowerBand;
}

const FAMILIES: readonly FamilyRule[] = [
  {
    family: "claude",
    test: /claude|^(opus|sonnet|haiku|fable)\b/,
    band: (n) => (/opus|fable/.test(n) ? "high" : /sonnet/.test(n) ? "mid" : /haiku/.test(n) ? "low" : "unknown"),
  },
  {
    family: "gpt",
    test: /^gpt|^o[1-9](-|$)|codex|chatgpt/,
    band: (n) => (/mini|nano|lite|flash/.test(n) ? "low" : /pro|^o[1-9]|max|ultra/.test(n) ? "high" : "mid"),
  },
  {
    family: "gemini",
    test: /gemini|gemma/,
    band: (n) => (/lite|nano|flash-8b/.test(n) ? "low" : /flash/.test(n) ? "mid" : /pro|ultra/.test(n) ? "high" : "unknown"),
  },
  { family: "deepseek", test: /deepseek/, band: (n) => (/flash|lite|distill/.test(n) ? "low" : /reasoner|pro|v\d/.test(n) ? "high" : "mid") },
  { family: "glm", test: /^glm|zhipu/, band: (n) => (/flash|lite|air/.test(n) ? "low" : "mid") },
  { family: "qwen", test: /qwen/, band: (n) => (/\b(0\.|1\.|3|4|7)b\b|flash|lite|mini/.test(n) ? "low" : /max|plus/.test(n) ? "high" : "mid") },
  { family: "grok", test: /grok/, band: (n) => (/mini|fast/.test(n) ? "low" : "high") },
  { family: "llama", test: /llama/, band: (n) => (/\b(1|3|7|8)b\b/.test(n) ? "low" : "mid") },
  { family: "mistral", test: /mistral|mixtral|codestral|devstral|magistral/, band: (n) => (/small|tiny|ministral/.test(n) ? "low" : /large|medium/.test(n) ? "high" : "mid") },
  { family: "nemotron", test: /nemotron/, band: (n) => (/lightning|nano|mini/.test(n) ? "low" : /ultra/.test(n) ? "high" : "mid") },
];

/** The family and capability band of a model name, wherever it is reached from. */
export function classifyModelName(model: string): ModelClass {
  const { name } = bareName(model);
  for (const rule of FAMILIES) {
    if (rule.test.test(name)) return { family: rule.family, band: rule.band(name) };
  }
  return UNKNOWN;
}

/**
 * The class of a seat. A seat that names a model is classified by that name. A seat that leaves the model to the CLI's default is
 * classified by what the provider is known to run by default, which is only certain for a provider that serves a single vendor's
 * models; for the others the default is unknown (the independence ladder then says "unverified" rather than guess).
 */
export function classifyModel(seat: Seat): ModelClass {
  if (seat.model !== null) return classifyModelName(seat.model);
  switch (seat.provider) {
    case "claude-code":
      return { family: "claude", band: "unknown" };
    case "codex-cli":
      return { family: "gpt", band: "unknown" };
    case "antigravity-cli":
      return { family: "gemini", band: "unknown" };
    default:
      return UNKNOWN;
  }
}

/**
 * Models OSA can propose for a provider without asking it: short aliases the provider's own CLI accepts. Used so a person with ONE
 * provider still gets an automatically chosen second model of a different capability class. Empty when the provider has no stable
 * aliases (its models are discovered, or named in `osa.config.json`).
 */
export function knownModels(provider: ProviderId): readonly string[] {
  switch (provider) {
    case "claude-code":
      return ["opus", "sonnet", "haiku"];
    default:
      return [];
  }
}
