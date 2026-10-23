// The research clients' shared HTTP helper. This directory (src/research/net/) is the ONE place OSA may
// touch the network (boundary rules B3/B4 are exempt here and B9 holds the line: global fetch only, no
// HTTP library, no dependency). See docs/osa/CONFLICTS.md C-01.
//
// Three properties every client inherits:
//   1. Never throws for a modelled failure -- a network error, an HTTP error and a rate limit are all
//      *results* ({@link HttpResult}), because "no useful academic results" is a valid outcome, not a crash.
//   2. Politeness: {@link MinIntervalLimiter} serialises calls through a single lane with a minimum gap
//      (arXiv's guidance: >= 3 s between calls, one connection).
//   3. Rate-limit handling: 429/503 (and GitHub's 403-with-remaining-0) honour `Retry-After` /
//      `X-RateLimit-Reset`, back off up to a cap, retry a bounded number of times, and otherwise return a
//      `rate_limited` result carrying how long the server asked us to wait.
//
// Everything that touches the outside world is injectable ({@link HttpDeps}) so tests use no network.

/** `fetch`-shaped function. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Sleeps for `ms` milliseconds. */
export type SleepFn = (ms: number) => Promise<void>;

/** Injectable collaborators; each defaults to the real thing. */
export interface HttpDeps {
  readonly fetchFn?: FetchFn;
  readonly sleepFn?: SleepFn;
  /** Monotonic-ish clock in ms; default `Date.now`. */
  readonly nowFn?: () => number;
  /** Told about every rate-limit back-off and give-up, so the caller can log it. */
  readonly onEvent?: (e: HttpEvent) => void;
}

/** A rate-limit notice from {@link httpGet}. */
export interface HttpEvent {
  readonly host: string;
  readonly status: number;
  /** The attempt that was just rate limited (1-based). */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** How long it will wait before retrying; `null` when giving up. */
  readonly waitMs: number | null;
  readonly action: "retrying" | "gave-up";
  readonly reason: string;
}

/** The outcome of a GET. */
export type HttpResult =
  | { readonly kind: "ok"; readonly status: number; readonly text: string; readonly headers: Headers }
  | { readonly kind: "rate_limited"; readonly status: number; readonly retryAfterMs: number | null; readonly message: string }
  | { readonly kind: "error"; readonly status: number | null; readonly message: string };

/**
 * The ONLY hosts OSA's own code may contact (the free research APIs). Provider-native web search is not here: it is
 * performed by the provider CLIs OSA spawns, never by OSA's `fetch`. `api.semanticscholar.org` is optional and used only
 * when the operator sets `S2_API_KEY`. Enforced at runtime by {@link isAllowedUrl} on every request AND every redirect hop,
 * as defence in depth behind the static boundary scan (B3/B4/B9).
 */
export const ALLOWED_HOSTS: readonly string[] = ["export.arxiv.org", "api.openalex.org", "api.github.com", "api.semanticscholar.org"];

/** Redirect hops followed per request (each hop is re-checked against {@link ALLOWED_HOSTS}). */
const MAX_REDIRECTS = 3;

/** True iff `url` is https, on an allowlisted host, with no embedded credentials and the default port. Pure. */
export function isAllowedUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.username === "" && u.password === "" && u.port === "" && ALLOWED_HOSTS.includes(u.hostname.toLowerCase());
}

/** Default real sleep. */
export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialises scheduled calls (one at a time, in order) and guarantees at least `minIntervalMs` between the
 * *starts* of consecutive calls. One instance per remote host is the "single connection, >= N s apart"
 * discipline arXiv asks of API clients.
 */
export class MinIntervalLimiter {
  readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: SleepFn;
  private lastStart: number | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(minIntervalMs: number, deps: HttpDeps = {}) {
    this.minIntervalMs = minIntervalMs;
    this.now = deps.nowFn ?? Date.now;
    this.sleep = deps.sleepFn ?? realSleep;
  }

  /** Runs `fn` after every previously scheduled call has finished and the minimum gap has elapsed. */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.lastStart !== null) {
        const wait = this.lastStart + this.minIntervalMs - this.now();
        if (wait > 0) await this.sleep(wait);
      }
      this.lastStart = this.now();
      return fn();
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Options of {@link httpGet}. */
export interface HttpGetOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Total attempts including the first (default 3). */
  readonly maxAttempts?: number;
  /** Longest single back-off we are willing to sleep (default 30 s); a longer ask is returned as `rate_limited`. */
  readonly maxBackoffMs?: number;
  readonly limiter?: MinIntervalLimiter;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(unparseable url)";
  }
}

/** Parses `Retry-After` (seconds or an HTTP date) / `X-RateLimit-Reset` (epoch seconds) into a wait in ms, or `null`. */
export function parseWaitMs(headers: Headers, nowMs: number): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
  }
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset !== null) {
    const epoch = Number(reset);
    if (Number.isFinite(epoch)) return Math.max(0, epoch * 1000 - nowMs);
  }
  return null;
}

function isRateLimit(status: number, headers: Headers): boolean {
  if (status === 429 || status === 503) return true;
  // GitHub signals primary/secondary limits with 403 (+ remaining 0, or a Retry-After).
  return status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after") !== null);
}

/** GET `url`, with limiter, timeout, bounded back-off on rate limits, and no throws. */
export async function httpGet(url: string, opts: HttpGetOptions = {}, deps: HttpDeps = {}): Promise<HttpResult> {
  const fetchFn: FetchFn = deps.fetchFn ?? ((u, i) => globalThis.fetch(u, i));
  const sleep = deps.sleepFn ?? realSleep;
  const now = deps.nowFn ?? Date.now;
  const maxAttempts = opts.maxAttempts ?? 3;
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const once = async (): Promise<HttpResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = { method: "GET", redirect: "manual", signal: controller.signal, ...(opts.headers !== undefined ? { headers: { ...opts.headers } } : {}) };
      let target = url;
      let res: Response | null = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!isAllowedUrl(target)) {
          return { kind: "error", status: null, message: `refused: ${hostOf(target)} is not on the research host allowlist` };
        }
        res = await fetchFn(target, init);
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location !== null) {
          await res.text().catch(() => "");
          target = new URL(location, target).toString();
          res = null;
          continue;
        }
        break;
      }
      if (res === null) return { kind: "error", status: null, message: "too many redirects" };
      const text = await res.text();
      if (isRateLimit(res.status, res.headers)) {
        return {
          kind: "rate_limited",
          status: res.status,
          retryAfterMs: parseWaitMs(res.headers, now()),
          message: `HTTP ${String(res.status)} (rate limited)`,
        };
      }
      if (res.status < 200 || res.status >= 300) {
        return { kind: "error", status: res.status, message: `HTTP ${String(res.status)}: ${text.slice(0, 200)}` };
      }
      return { kind: "ok", status: res.status, text, headers: res.headers };
    } catch (err) {
      return { kind: "error", status: null, message: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  };

  let last: HttpResult = { kind: "error", status: null, message: "no attempt was made" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = opts.limiter !== undefined ? await opts.limiter.schedule(once) : await once();
    if (last.kind !== "rate_limited") return last;
    const wait = last.retryAfterMs ?? Math.min(2000 * 2 ** (attempt - 1), maxBackoffMs);
    const notice = { host: hostOf(url), status: last.status, attempt, maxAttempts };
    if (wait > maxBackoffMs) {
      deps.onEvent?.({ ...notice, waitMs: null, action: "gave-up", reason: `the server asked for ${String(Math.round(wait / 1000))}s, longer than the ${String(Math.round(maxBackoffMs / 1000))}s cap` });
      return last;
    }
    if (attempt === maxAttempts) {
      deps.onEvent?.({ ...notice, waitMs: null, action: "gave-up", reason: "attempts exhausted" });
      return last;
    }
    deps.onEvent?.({ ...notice, waitMs: wait, action: "retrying", reason: "rate limited" });
    await sleep(wait);
  }
  return last;
}

/** Result envelope every source client returns: records plus an honest account of what happened. */
export interface SourceResult<T> {
  readonly source: string;
  readonly query: string;
  readonly records: readonly T[];
  /** `null` when the source answered normally (even with zero records). */
  readonly problem: string | null;
}

/** Collapses runs of whitespace and trims. */
export function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
