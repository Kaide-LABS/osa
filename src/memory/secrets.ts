// "Never stores secrets" (OSA_DIRECTIVE.md WS8). Every fact is scanned before it touches disk; a fact that looks like it
// contains a credential is REJECTED (and reported), never stored and never silently trimmed. The scan is deliberately
// biased toward false positives: a lost fact costs a sentence, a stored key costs a rotation.

interface Rule {
  readonly reason: string;
  readonly test: (text: string) => boolean;
}

/** Shannon entropy in bits per character. Pure. */
export function entropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const re = (pattern: RegExp): ((t: string) => boolean) => (t) => pattern.test(t);

const RULES: readonly Rule[] = [
  { reason: "a private key block", test: re(/-----BEGIN [A-Z ]*PRIVATE KEY-----/) },
  { reason: "an API key (sk-/pk-/rk- style)", test: re(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/) },
  { reason: "a Stripe-style key (sk_live_/rk_test_/...)", test: re(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/) },
  { reason: "an Anthropic key", test: re(/\bsk-ant-[A-Za-z0-9_-]{10,}/) },
  { reason: "a GitHub token", test: re(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/) },
  { reason: "a Slack token", test: re(/\bxox[baprs]-[A-Za-z0-9-]{10,}/) },
  { reason: "an AWS access key id", test: re(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/) },
  { reason: "a Google API key", test: re(/\bAIza[0-9A-Za-z_-]{30,}/) },
  { reason: "a JSON web token", test: re(/\bey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/) },
  { reason: "a Discord bot token", test: re(/\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/) },
  { reason: "a bearer token", test: re(/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i) },
  { reason: "an HTTP Basic credential", test: re(/\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/) },
  // Env-style names carry a prefix (HEROKU_API_KEY, DB_PASSWORD, GITHUB_TOKEN): "api key" must match inside "HEROKU_API_KEY".
  { reason: "a credential assignment (password=/secret=/api_key=/token=...)", test: re(/(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token|credential)s?(?:[_-][A-Za-z0-9_-]*)?["']?\s*[:=]\s*["']?[^\s"']{6,}/i) },
  // "the password is hunter2": no '=' or ':', so require the value to look like one (it contains a digit).
  { reason: "a credential stated in a sentence (password is ...)", test: re(/\b(?:password|passcode|passphrase|passwd|secret|api[ _-]?key|token|credentials?)\s+(?:is|was|are|=|:)\s+["']?[^\s"']*\d[^\s"']{5,}/i) },
  { reason: "a connection string with embedded credentials", test: re(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i) },
  {
    reason: "a long random-looking token",
    test: (t) =>
      (t.match(/\b[A-Za-z0-9_-]{32,}\b/g) ?? []).some((tok) => /[A-Za-z]/.test(tok) && /\d/.test(tok) && entropy(tok) >= 3.6),
  },
  {
    // Base64 keys contain '/' and '+', which split them below the 32-character threshold above (AWS secret keys, Azure storage keys).
    reason: "a long base64-style key",
    test: (t) => (t.match(/[A-Za-z0-9+/]{40,}={0,2}/g) ?? []).some((tok) => /[A-Z]/.test(tok) && /[a-z]/.test(tok) && /\d/.test(tok) && entropy(tok) >= 4.0 && !/^[A-Za-z0-9]+(?:\/[A-Za-z0-9._-]+){3,}$/.test(tok)),
  },
  // A UUID is an identifier (run ids) UNLESS it sits next to a credential word -- Heroku API keys, Azure client secrets and many vendor
  // keys ARE UUIDs. The scan below sees UUIDs as "<uuid>".
  { reason: "a UUID next to a credential word (UUID-shaped secret)", test: re(/\b(?:api[ _-]?key|secret|token|password|passwd|credential|bearer|licen[cs]e|private[ _-]?key|key)s?\W{0,24}<uuid>|<uuid>\W{0,24}(?:is |as |was )?(?:the |a |an |my |our )?(?:api[ _-]?key|secret|token|password|passwd|credential|licen[cs]e key|key)\b/i) },
];

/** Canonical UUIDs (run ids, record ids) are identifiers -- 36 characters of hex and hyphens that otherwise look "random". */
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

/** The reason `text` looks like it contains a secret, or `null` if it looks clean. Pure. */
export function findSecret(text: string): string | null {
  // First live end-to-end run: failure notes carrying a run UUID were rejected as "a long random-looking token".
  const scanned = text.replace(UUID, "<uuid>");
  for (const r of RULES) if (r.test(scanned)) return r.reason;
  return null;
}
