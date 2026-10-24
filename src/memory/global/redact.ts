// The redacting scrubber for global memory (docs/osa/memory-phase1/CONTEXT.md). The existing `src/memory/secrets.ts`
// REJECTS a secret-shaped fact; global memory instead REDACTS the secret-shaped spans before anything reaches disk, and
// reports that it did so, so the clean remainder of a sentence can still be stored. The rule list is the same one
// `findSecret` uses: this file builds span-finding (global) regexes that mirror those rules, then uses `findSecret`
// itself as the final guarantee -- a caller treats any text on which `findSecret` STILL fires after redaction as
// unredactable and refuses it, so nothing secret-shaped can reach the database or the FTS index regardless of a gap in
// span coverage. `findSecret`'s own behaviour is not changed.

import { entropy, findSecret } from "../secrets.ts";

/** A span `[start, end)` of `text` that was redacted, and why. */
interface Span {
  readonly start: number;
  readonly end: number;
  readonly reason: string;
}

/** The result of {@link redactSecrets}. */
export interface RedactionResult {
  readonly text: string;
  /** One reason per redacted span, in document order (e.g. `["a GitHub token", "a bearer token"]`). */
  readonly redactions: string[];
  /** Fraction of the original text (0..1) covered by redactions. A husk (> 0.5) should be refused, not stored. */
  readonly fraction: number;
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_RE = new RegExp(`^${UUID}$`);
const CRED_WORD = "(?:api[ _-]?key|secret|token|password|passwd|credential|bearer|licen[cs]e|private[ _-]?key|key)";

// Ordered span-finding rules mirroring the detection rules in src/memory/secrets.ts. Specific keys come before generic
// ones so the most precise reason wins when spans overlap. Every regex carries the global flag.
const PATTERNS: readonly { readonly reason: string; readonly re: RegExp }[] = [
  { reason: "a private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { reason: "an Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
  { reason: "an API key (sk-/pk-/rk- style)", re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g },
  { reason: "a Stripe-style key", re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { reason: "a GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { reason: "a Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { reason: "an AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { reason: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { reason: "a JSON web token", re: /\bey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g },
  { reason: "a Discord bot token", re: /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g },
  { reason: "a bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/gi },
  { reason: "an HTTP Basic credential", re: /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g },
  { reason: "a credential assignment", re: /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token|credential)s?(?:[_-][A-Za-z0-9_-]*)?["']?\s*[:=]\s*["']?[^\s"']{6,}/gi },
  { reason: "a credential stated in a sentence", re: /\b(?:password|passcode|passphrase|passwd|secret|api[ _-]?key|token|credentials?)\s+(?:is|was|are|=|:)\s+["']?[^\s"']*\d[^\s"']{5,}/gi },
  { reason: "a connection string with embedded credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
  // A UUID next to a credential word is a UUID-shaped secret (Heroku API keys, Azure client secrets). A bare UUID (a run
  // id) is never redacted -- the entropy rule below exempts it, matching findSecret's own `<uuid>` exemption.
  { reason: "a UUID-shaped secret", re: new RegExp(`${CRED_WORD}s?\\W{0,24}${UUID}|${UUID}\\W{0,24}(?:is |as |was )?(?:the |a |an |my |our )?${CRED_WORD}`, "gi") },
];

/** Collects spans for the two entropy rules (long random-looking tokens and base64-style keys), skipping bare UUIDs. */
function entropySpans(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(/\b[A-Za-z0-9_-]{32,}\b/g)) {
    const tok = m[0];
    if (UUID_RE.test(tok)) continue; // a bare UUID is a run id, not a secret
    if (/[A-Za-z]/.test(tok) && /\d/.test(tok) && entropy(tok) >= 3.6) out.push({ start: m.index, end: m.index + tok.length, reason: "a long random-looking token" });
  }
  for (const m of text.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) {
    const tok = m[0];
    if (/[A-Z]/.test(tok) && /[a-z]/.test(tok) && /\d/.test(tok) && entropy(tok) >= 4.0 && !/^[A-Za-z0-9]+(?:\/[A-Za-z0-9._-]+){3,}$/.test(tok)) {
      out.push({ start: m.index, end: m.index + tok.length, reason: "a long base64-style key" });
    }
  }
  return out;
}

/** Merges overlapping/adjacent spans, keeping the earliest-listed reason. Input need not be sorted. */
function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && s.start <= last.end) {
      if (s.end > last.end) out[out.length - 1] = { start: last.start, end: s.end, reason: last.reason };
    } else {
      out.push(s);
    }
  }
  return out;
}

/**
 * Redacts every secret-shaped span of `text`, replacing it with `[redacted:<reason>]`, and reports what it removed.
 * Pure. Bare UUIDs (run ids) are preserved; UUIDs beside a credential word are redacted. The returned `fraction` lets a
 * caller refuse a husk; and because the detection rules can out-run the span rules in rare cases, callers run
 * {@link findSecret} on the result as the final gate.
 */
export function redactSecrets(text: string): RedactionResult {
  const spans: Span[] = [];
  for (const { reason, re } of PATTERNS) {
    for (const m of text.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length, reason });
  }
  spans.push(...entropySpans(text));
  const merged = merge(spans);
  if (merged.length === 0) return { text, redactions: [], fraction: 0 };

  const parts: string[] = [];
  const redactions: string[] = [];
  let cursor = 0;
  let covered = 0;
  for (const s of merged) {
    parts.push(text.slice(cursor, s.start), `[redacted:${s.reason}]`);
    redactions.push(s.reason);
    covered += s.end - s.start;
    cursor = s.end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(""), redactions, fraction: text.length === 0 ? 0 : covered / text.length };
}

/** True when `text` still looks like it contains a secret after redaction -- the final, authoritative gate. */
export function stillHasSecret(text: string): boolean {
  return findSecret(text) !== null;
}
