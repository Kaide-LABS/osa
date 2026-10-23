// Environment hygiene for provider processes (Suite 2). OSA's own secrets -- the research clients' GitHub / OpenAlex /
// Semantic Scholar keys -- are used only inside OSA's process; a provider CLI never needs them, and a provider that has
// been steered by planted text must not find them in its environment. Calls that can run a shell (the application agent,
// build turns) get a stricter scrub: anything that looks like a credential is dropped unless it is the provider's own.

/** Variables only OSA's research clients use. Never passed to any provider process. */
export const OSA_ONLY_SECRETS: readonly string[] = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT", "OPENALEX_API_KEY", "S2_API_KEY", "SEMANTIC_SCHOLAR_API_KEY", "NPM_TOKEN"];

const CREDENTIAL_LOOKING = /(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIAL|API_?KEY|ACCESS_?KEY|SESSION_?KEY|AUTH)/i;
/** A provider's own credentials and settings keep working. */
const PROVIDER_OWN = /^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE|OPENAI_|CODEX_|GEMINI_|GOOGLE_GENAI_|GOOGLE_API_KEY$|AGY_|ANTIGRAVITY_)/i;

/** Removes {@link OSA_ONLY_SECRETS}. Pure. */
export function withoutOsaSecrets(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (!OSA_ONLY_SECRETS.includes(k.toUpperCase())) out[k] = v;
  return out;
}

/** {@link withoutOsaSecrets} plus every credential-looking variable that is not a provider's own. Pure. */
export function withoutCredentials(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(withoutOsaSecrets(env))) {
    if (CREDENTIAL_LOOKING.test(k) && !PROVIDER_OWN.test(k)) continue;
    out[k] = v;
  }
  return out;
}
