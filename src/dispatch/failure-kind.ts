// Classifies why a provider process failed, so the halt reason is plain and the log label is right (Suite 6, provider failure
// injection). Before this every non-timeout failure was "<provider> exited N": a signed-out CLI, a missing CLI and a rate limit looked
// identical, and the run summary could only say "something went wrong". The patterns are STRICT on purpose -- a rate limit needs
// rate-limit wording; "context length limit", "file size limit", "too many open files" and a stray "429" inside an unrelated number are
// not rate limits, and calling them that sends the operator off to wait for something that will never clear.

import type { OsaError } from "../domain/errors.ts";
import type { ProviderId, RawInvocationResult } from "../domain/run.ts";

export type FailureKind = "timeout" | "cli_missing" | "auth" | "rate_limit" | "malformed_output" | "nonzero_exit";

export interface Classified {
  readonly kind: FailureKind;
  /** One sentence a non-engineer can act on. */
  readonly plain: string;
}

const CLI_MISSING_TEXT = /\bENOENT\b|is not recognized as an internal or external command|\bcommand not found\b|operable program or batch file|cannot find the (?:file|path) specified|spawn \S+ (?:failed|error)/i;
const AUTH_TEXT = [
  /\bnot (?:logged|signed) in\b/i,
  /\bplease (?:run )?\/?(?:log ?in|sign ?in)\b/i,
  /\b(?:log|sign) ?in (?:again|required|first)\b/i,
  /\binvalid (?:x-)?api[ -]?key\b|\bapi[ -]?key (?:is )?(?:invalid|missing|not set|required)\b/i,
  /\bauthentication (?:failed|required|error|failure)\b|\bauthorization (?:failed|required)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\b(?:403|401)\b[^\n]{0,30}\bforbidden\b|\bforbidden\b[^\n]{0,30}\b(?:403|401)\b|\b403 forbidden\b/i,
  /\b(?:session|token|credentials?|login) (?:has )?expired\b|\bexpired (?:session|token|credentials?)\b/i,
  /\bno credentials\b|\bmissing credentials\b|\bnot authenticated\b/i,
  /\bdoes not have access\b/i,
];
const RATE_TEXT = [
  /\b429\b[^\n]{0,60}\b(?:too many|rate|limit|requests|quota)\b/i,
  /\btoo many requests\b/i,
  /\brate[ _-]?limit(?:s|ed|ing)?\b/i,
  /\busage limit\b/i,
  /\bquota (?:exceeded|exhausted|reached)\b|\bexceeded your (?:current )?quota\b/i,
  /\b529\b[^\n]{0,40}\boverloaded\b|\boverloaded(?:_error)?\b/i,
  /\b(?:requests|tokens) per (?:minute|day|hour)\b/i,
  /\bcapacity (?:limit|reached)\b/i,
];

/** Classifies a failed provider process. Pure. `malformed` = the adapter judged an exit-0 reply unusable. */
export function classifyFailure(raw: RawInvocationResult, opts: { readonly malformed?: boolean } = {}): Classified {
  if (raw.timedOut) return { kind: "timeout", plain: "The AI provider took too long to answer and was stopped." };
  const text = `${raw.stderr}\n${raw.stdout.slice(0, 4000)}`;
  if ((raw.exitCode === null && raw.signal === null) || raw.exitCode === 127 || raw.exitCode === 9009 || (raw.exitCode !== 0 && CLI_MISSING_TEXT.test(raw.stderr))) {
    if (raw.exitCode === null && raw.signal === null && !CLI_MISSING_TEXT.test(raw.stderr) && raw.stderr.trim() !== "") {
      return { kind: "nonzero_exit", plain: `The AI provider could not be started: ${raw.stderr.trim().slice(0, 160)}` };
    }
    return { kind: "cli_missing", plain: "The AI tool isn't installed on this computer, or it could not be started." };
  }
  if (AUTH_TEXT.some((re) => re.test(text))) {
    return { kind: "auth", plain: "The AI provider isn't signed in on this computer, or its sign-in expired. Sign in with the provider's own app, then run again." };
  }
  if (RATE_TEXT.some((re) => re.test(text))) {
    return { kind: "rate_limit", plain: "The AI provider is limiting requests right now (a usage limit, or it is busy). Wait a while, then run again." };
  }
  if (opts.malformed === true || (raw.exitCode === 0 && text.trim() !== "")) {
    return { kind: "malformed_output", plain: "The AI provider's reply wasn't in the expected form." };
  }
  const how = raw.exitCode === null ? `was stopped by signal ${raw.signal ?? "unknown"}` : `exited with code ${String(raw.exitCode)}`;
  return { kind: "nonzero_exit", plain: `The AI provider stopped with an error (it ${how}).` };
}

/**
 * Returns `original` re-created with the plain explanation and `failureKind` in `details` (same error class, so exit codes and
 * `instanceof` checks are unchanged). The message names the provider.
 */
export function labelFailure(provider: ProviderId, original: OsaError, raw: RawInvocationResult): OsaError {
  const c = classifyFailure(raw, { malformed: raw.exitCode === 0 && !raw.timedOut });
  const Ctor = original.constructor as new (message: string, details?: Record<string, unknown>) => OsaError;
  return new Ctor(`${provider}: ${c.plain}`, { ...original.details, failureKind: c.kind, original: original.message });
}
