// Implements PHASE_1_SPEC.md §6.7 -- FM1 / FM9 [DET]
//
// Toolchain, git, and provider-CLI health checks. This module -- and everything it calls -- never
// triggers either provider's own credential-setup flow; it only *observes* credential state
// (boundary rule B6, PRD §9 FM1). On an authentication failure it points the operator at the
// provider CLI's own --help/docs rather than spelling out the exact lowercase sign-in command:
// boundary rule B6's source-pattern regex (§6.8) matches those exact word sequences regardless of
// whether they appear in real invocation code or in inert remediation text, so embedding them
// literally in a comment or string here would make OSA's own `doctor --boundary` scan
// fail on this file. Referring the operator to the CLI's own --help is also more robust against
// the version drift FM9 already tracks.

import type { PreflightReport } from "../ports/provider-adapter.ts";
import { InternalError } from "../domain/errors.ts";
import { PROVIDER_IDS } from "../domain/run.ts";
import type { AuthProbeState, ProviderId, RawInvocationResult } from "../domain/run.ts";
import { runProcess } from "../util/exec.ts";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitVersion } from "./git.ts";

const CLI_PROBE_TIMEOUT_MS = 15_000;

/** Per-provider CLI version acceptance range (min inclusive, max exclusive). §2.3. */
export const PROVIDER_VERSION_RANGES: Readonly<Record<ProviderId, { min: string; maxExclusive: string }>> = {
  "claude-code": { min: "2.1.200", maxExclusive: "3.0.0" },
  "codex-cli": { min: "0.128.0", maxExclusive: "1.0.0" },
  "antigravity-cli": { min: "1.1.20", maxExclusive: "2.0.0" },
  "opencode-cli": { min: "2.0.0", maxExclusive: "3.0.0" },
  "copilot-cli": { min: "0.0.1", maxExclusive: "1000.0.0" },
};

/**
 * Toolchain version acceptance ranges. Node.js and git only have a stated minimum (§2.3); the
 * `maxExclusive` sentinel below represents "no practical ceiling" so {@link inRange} can use one
 * uniform two-sided comparison for every range in this file.
 */
export const TOOL_VERSION_RANGES: Readonly<Record<"node" | "git", { min: string; maxExclusive: string }>> = {
  node: { min: "24.0.0", maxExclusive: "1000.0.0" },
  git: { min: "2.40.0", maxExclusive: "1000.0.0" },
};

/** The result of checking one toolchain component's presence and version. */
export interface ToolCheck {
  readonly found: boolean;
  readonly version: string | null;
  readonly inRange: boolean;
}

/** The aggregated result of {@link runPreflight}. */
export interface PreflightSummary {
  readonly node: ToolCheck;
  readonly git: ToolCheck;
  /** Every known provider identity, in {@link PROVIDER_IDS} order. */
  readonly providers: readonly PreflightReport[];
  readonly ok: boolean;
  readonly problems: readonly string[];
  /** Installed-but-broken providers when at least one other provider is healthy: worth knowing, not a reason to stop. */
  readonly warnings?: readonly string[];
}

/**
 * Extracts the first `MAJOR.MINOR.PATCH` triple from an arbitrary version banner (e.g.
 * `"2.1.211 (Claude Code)"`, `"codex-cli 0.128.0"`, `"git version 2.54.0.windows.1"`). Returns
 * `null` if no such triple is present.
 */
export function parseSemverish(s: string): { major: number; minor: number; patch: number } | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (match === null) {
    return null;
  }
  const majorStr = match[1];
  const minorStr = match[2];
  const patchStr = match[3];
  if (majorStr === undefined || minorStr === undefined || patchStr === undefined) {
    return null;
  }
  return { major: Number(majorStr), minor: Number(minorStr), patch: Number(patchStr) };
}

function compareSemverish(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

/** True iff `v` parses and falls in `[min, maxExclusive)`. */
export function inRange(v: string, min: string, maxExclusive: string): boolean {
  const parsedV = parseSemverish(v);
  const parsedMin = parseSemverish(min);
  const parsedMax = parseSemverish(maxExclusive);
  if (parsedV === null || parsedMin === null || parsedMax === null) {
    return false;
  }
  return compareSemverish(parsedV, parsedMin) >= 0 && compareSemverish(parsedV, parsedMax) < 0;
}

/** Node.js version check. Synchronous: reads `process.versions.node` directly, no child process. */
export function checkNodeVersion(): ToolCheck {
  const version = process.versions.node;
  const range = TOOL_VERSION_RANGES.node;
  return { found: true, version, inRange: inRange(version, range.min, range.maxExclusive) };
}

/** git availability/version check via `git --version` (`src/verify/git.ts`'s `gitVersion`). */
export async function checkGitAvailable(repoDir: string): Promise<ToolCheck> {
  const raw = await gitVersion(repoDir);
  if (raw === null) {
    return { found: false, version: null, inRange: false };
  }
  const range = TOOL_VERSION_RANGES.git;
  return { found: true, version: raw, inRange: inRange(raw, range.min, range.maxExclusive) };
}

const PROVIDER_COMMAND: Readonly<Record<ProviderId, string>> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  "antigravity-cli": "agy",
  "opencode-cli": "opencode",
  "copilot-cli": "copilot",
};

/**
 * One healthy provider is enough to run: OSA then separates author and reviewer by MODEL (src/domain/independence.ts) instead of by
 * provider. A second provider, ideally from another model family, makes the review more independent and is recommended, never required.
 */
export const MIN_HEALTHY_PROVIDERS = 1;

/**
 * Pure interpretation of a `<cli> --version` invocation's raw result. Exported (alongside the
 * other `parse*` functions below) so `checkProviderCli`/`checkProviderAuth` -- whose signatures
 * PHASE_1_SPEC.md §6.7 fixes to take only a {@link ProviderId} -- can stay exactly as specified
 * while this interpretation logic itself is unit-testable with a literally-constructed
 * {@link RawInvocationResult}, i.e. "injected fake process results" (PHASE_1_SPEC.md §1.6), with
 * no process spawned and no module-mocking machinery required.
 */
export function parseProviderCliVersionResult(result: RawInvocationResult): { found: boolean; version: string | null } {
  if (result.exitCode !== 0) {
    return { found: false, version: null };
  }
  return { found: true, version: result.stdout.trim() };
}

/**
 * The interpreted result of one credential probe.
 *
 * `authenticated` is retained with its original, unchanged meaning ("definitively authenticated")
 * so every existing consumer -- including the shipped `doctor --json` schema -- is unaffected; it is
 * derived from `authState` by {@link authProbeResult} and is never set independently, so the two can
 * never disagree. `authState` is the additive discriminant carrying the distinction the boolean
 * structurally cannot express: a probe that *failed* is not a provider that is *signed out*.
 */
export interface AuthProbeResult {
  readonly authenticated: boolean;
  readonly authState: AuthProbeState;
  readonly detail: string;
}

/**
 * The single constructor for an {@link AuthProbeResult}. Deriving `authenticated` here (rather than
 * letting each call site pass both) is what makes "`authenticated === true` iff
 * `authState === \"authenticated\"`" a property of the type rather than a convention every branch
 * has to remember.
 */
function authProbeResult(authState: AuthProbeState, detail: string): AuthProbeResult {
  return { authenticated: authState === "authenticated", authState, detail };
}

/**
 * Pure interpretation of a `claude auth status` invocation's raw result (PHASE_1_SPEC.md §6.7).
 *
 * The CLI's verified behaviour (docs/modernization_log.md §4) is exit `0` with a JSON object whose
 * `loggedIn` boolean is the answer -- in *both* directions. So `loggedIn: true` is the only
 * authenticated result and `loggedIn: false` is the only definitively-unauthenticated one; a
 * non-zero exit, a timeout, non-JSON stdout, or a JSON object with no `loggedIn` boolean are all
 * cases where the CLI did not actually answer the question, and are reported `"indeterminate"`
 * rather than being silently rounded down to "not signed in". Never a crash in any branch.
 */
export function parseClaudeAuthResult(result: RawInvocationResult): AuthProbeResult {
  if (result.timedOut) {
    return authProbeResult("indeterminate", "auth status probe timed out; credential state not observed");
  }
  if (result.exitCode !== 0) {
    return authProbeResult(
      "indeterminate",
      `auth status probe exited ${String(result.exitCode)} instead of its expected 0; ` +
        "credential state not observed",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return authProbeResult("indeterminate", "unrecognised auth status output (not JSON); credential state not observed");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return authProbeResult(
      "indeterminate",
      "unrecognised auth status output (JSON, but not an object); credential state not observed",
    );
  }
  const loggedIn = (parsed as Record<string, unknown>)["loggedIn"];
  if (loggedIn === true) {
    return authProbeResult("authenticated", "authenticated");
  }
  if (loggedIn === false) {
    return authProbeResult("unauthenticated", "auth status reported loggedIn: false");
  }
  return authProbeResult(
    "indeterminate",
    "auth status output carried no loggedIn boolean; credential state not observed",
  );
}

/**
 * The exit code `codex login status` is documented and locally observed to return when the operator
 * is not signed in (docs/modernization_log.md §4: exit `1` + `Not logged in`). Any *other* non-zero
 * exit is an outcome neither of that CLI's two documented results describes, so it says nothing
 * about credentials -- see {@link parseCodexAuthResult}.
 */
const CODEX_NOT_SIGNED_IN_EXIT_CODE = 1;

/**
 * Pure interpretation of a `codex login status` invocation's raw result (PHASE_1_SPEC.md §6.7):
 * keyed on exit code only (the authenticated stdout shape is [UNVERIFIED]). A non-empty
 * `CODEX_API_KEY` or `OPENAI_API_KEY` in `env` is an accepted alternative BYOA satisfying path.
 *
 * This provider is where the exit-code ambiguity actually bit: the Windows `cmd.exe` relaunch
 * fallback in `src/util/exec.ts` could surface an exit code from the *shim* rather than from the
 * CLI, and the old boolean rendered that indistinguishable from a genuine not-signed-in result. So
 * only exit `0` (or a BYOA env var) is authenticated, only {@link CODEX_NOT_SIGNED_IN_EXIT_CODE}
 * with no such env var is definitively not, and every other exit code -- including a failed spawn's
 * `null` and a timeout -- is `"indeterminate"`.
 */
export function parseCodexAuthResult(
  result: RawInvocationResult,
  env: Readonly<Record<string, string | undefined>>,
): AuthProbeResult {
  if (result.exitCode === 0) {
    return authProbeResult("authenticated", "authenticated");
  }
  const apiKey = env["CODEX_API_KEY"] ?? env["OPENAI_API_KEY"] ?? "";
  if (apiKey !== "") {
    return authProbeResult("authenticated", "authenticated via API key env var");
  }
  if (result.timedOut) {
    return authProbeResult("indeterminate", "login status probe timed out; credential state not observed");
  }
  if (result.exitCode === CODEX_NOT_SIGNED_IN_EXIT_CODE) {
    return authProbeResult(
      "unauthenticated",
      `login status exited ${String(CODEX_NOT_SIGNED_IN_EXIT_CODE)} (its documented not-signed-in result) ` +
        "and no API key env var is set",
    );
  }
  return authProbeResult(
    "indeterminate",
    `login status exited ${String(result.exitCode)}, which matches neither its documented ` +
      `authenticated (0) nor not-signed-in (${String(CODEX_NOT_SIGNED_IN_EXIT_CODE)}) result; ` +
      "the probe itself may have failed, so credential state was not observed",
  );
}

/** Pure interpretation of Antigravity's headless settings and key presence (one of two recognized auth modes; see {@link interpretAntigravityAuthInputs}). */
function interpretAntigravityHeadlessSettings(settingsRaw: string | null, env: Readonly<Record<string, string | undefined>>): AuthProbeResult {
  if (settingsRaw === null) return authProbeResult("indeterminate", "Antigravity settings file could not be read; credential state not observed");
  let parsed: unknown;
  try { parsed = JSON.parse(settingsRaw); } catch { return authProbeResult("indeterminate", "Antigravity settings file could not be parsed; credential state not observed"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return authProbeResult("indeterminate", "Antigravity settings file is not an object; credential state not observed");
  const provider = (parsed as Record<string, unknown>)["modelProvider"];
  if (provider === undefined) return authProbeResult("indeterminate", "Antigravity modelProvider is absent; credential state not observed");
  if (provider !== "gemini") return authProbeResult("unauthenticated", "Antigravity is configured for a provider mode other than required headless Gemini mode");
  return typeof env["GEMINI_API_KEY"] === "string" && env["GEMINI_API_KEY"] !== ""
    ? authProbeResult("authenticated", "authenticated via headless Gemini API key mode")
    : authProbeResult("unauthenticated", "Antigravity headless Gemini mode is configured but its required API key is absent");
}

/**
 * Pure interpretation of a cached Google account (subscription) OAuth session -- the second
 * recognized auth mode, see {@link interpretAntigravityAuthInputs}. A `refresh_token` is the
 * signal, not the short-lived `access_token`: as long as one is present, `agy`'s own OAuth client
 * silently renews the session without a browser prompt, which is what keeps this observation
 * consistent with the no-interactive-prompt design. Only the field's presence/emptiness is used --
 * its value never leaves this function (same discipline as `GEMINI_API_KEY`, FM19).
 */
function interpretAntigravityOAuthCreds(oauthCredsRaw: string | null): AuthProbeResult {
  if (oauthCredsRaw === null) return authProbeResult("indeterminate", "Antigravity OAuth credentials file could not be read; credential state not observed");
  let parsed: unknown;
  try { parsed = JSON.parse(oauthCredsRaw); } catch { return authProbeResult("indeterminate", "Antigravity OAuth credentials file could not be parsed; credential state not observed"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return authProbeResult("indeterminate", "Antigravity OAuth credentials file is not an object; credential state not observed");
  const refreshToken = (parsed as Record<string, unknown>)["refresh_token"];
  return typeof refreshToken === "string" && refreshToken !== ""
    ? authProbeResult("authenticated", "authenticated via cached Google account (subscription) OAuth session")
    : authProbeResult("indeterminate", "Antigravity OAuth credentials file has no refresh_token; credential state not observed");
}

/**
 * Pure interpretation of Antigravity's credential state across both recognized, mutually
 * sufficient auth modes: headless Gemini API key mode (`modelProvider: "gemini"` +
 * `GEMINI_API_KEY`) and a cached Google account (subscription) OAuth session
 * (`~/.gemini/oauth_creds.json`). Subscription auth was originally out of scope (PHASE_11_SPEC.md
 * §7's out-of-scope list, item 3) because a session token can expire mid-run with no one present
 * to complete a browser re-auth; the operator explicitly confirmed accepting that risk to use
 * their own Google Gemini subscription rather than a standalone API key, so this is a deliberate
 * amendment, not a relaxation of B6 -- both modes are still only ever observed, never established.
 *
 * Either mode being conclusively `"authenticated"` is sufficient. Otherwise, a genuine
 * `"unauthenticated"` claim (a deliberately-configured mode that is broken) is preferred over a
 * vague `"indeterminate"` from the other mode, since it is more actionable.
 */
export function interpretAntigravityAuthInputs(
  settingsRaw: string | null,
  env: Readonly<Record<string, string | undefined>>,
  oauthCredsRaw: string | null,
): AuthProbeResult {
  const headless = interpretAntigravityHeadlessSettings(settingsRaw, env);
  if (headless.authState === "authenticated") return headless;
  const subscription = interpretAntigravityOAuthCreds(oauthCredsRaw);
  if (subscription.authState === "authenticated") return subscription;
  if (headless.authState === "unauthenticated") return headless;
  return subscription;
}

async function observeAntigravityHeadlessAuth(): Promise<AuthProbeResult> {
  let settingsRaw: string | null = null;
  try { settingsRaw = await readFile(join(homedir(), ".gemini", "antigravity-cli", "settings.json"), "utf8"); } catch { /* observation only */ }
  let oauthCredsRaw: string | null = null;
  try { oauthCredsRaw = await readFile(join(homedir(), ".gemini", "oauth_creds.json"), "utf8"); } catch { /* observation only */ }
  return interpretAntigravityAuthInputs(settingsRaw, process.env, oauthCredsRaw);
}

/**
 * Pure: OpenCode's `auth list` prints one line per stored login (`<name>  <id>  stored`, or `env` / `config` when the credential comes
 * from the environment or its config). Any such line means a provider is usable; nothing means only the free built-in models are.
 */
export function parseOpenCodeAuthResult(result: RawInvocationResult): AuthProbeResult {
  if (result.exitCode !== 0) return authProbeResult("indeterminate", `opencode auth list exited ${String(result.exitCode)}`);
  const logins = result.stdout.split("\n").map((l) => l.trim()).filter((l) => /\s(stored|env|config)$/i.test(l));
  return logins.length > 0
    ? authProbeResult("authenticated", `${String(logins.length)} stored login(s)`)
    : authProbeResult("unauthenticated", "no provider login stored in OpenCode");
}

/** Pure: Copilot CLI's sign-in cannot be observed from outside; a token in the environment is the only conclusive sign. */
export function interpretCopilotAuthInputs(env: Readonly<Record<string, string | undefined>>): AuthProbeResult {
  const named = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].find((k) => (env[k] ?? "") !== "");
  return named !== undefined ? authProbeResult("authenticated", `token in ${named}`) : authProbeResult("indeterminate", "no token in COPILOT_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN");
}

async function observeCopilotAuth(env: Readonly<Record<string, string | undefined>>): Promise<AuthProbeResult> {
  return interpretCopilotAuthInputs(env);
}

/** Runs `<cli> --version` for `id` and reports whether the CLI was found and its raw version banner. */
export async function checkProviderCli(id: ProviderId): Promise<{ found: boolean; version: string | null }> {
  const result = await runProcess({
    command: PROVIDER_COMMAND[id],
    args: ["--version"],
    cwd: process.cwd(),
    timeoutMs: CLI_PROBE_TIMEOUT_MS,
  });
  return parseProviderCliVersionResult(result);
}

/**
 * [DET, boundary-critical] Observes -- never establishes -- `id`'s credential state. Keys the
 * predicate exactly as PHASE_1_SPEC.md §6.7 specifies per provider.
 */
export async function checkProviderAuth(id: ProviderId): Promise<AuthProbeResult> {
  switch (id) {
    case "claude-code": {
      const result = await runProcess({
        command: PROVIDER_COMMAND[id],
        args: ["auth", "status"],
        cwd: process.cwd(),
        timeoutMs: CLI_PROBE_TIMEOUT_MS,
      });
      return parseClaudeAuthResult(result);
    }
    case "codex-cli": {
      const result = await runProcess({
        command: PROVIDER_COMMAND[id],
        args: ["login", "status"],
        cwd: process.cwd(),
        timeoutMs: CLI_PROBE_TIMEOUT_MS,
      });
      return parseCodexAuthResult(result, process.env);
    }
    case "antigravity-cli":
      return observeAntigravityHeadlessAuth();
    case "opencode-cli": {
      const result = await runProcess({ command: PROVIDER_COMMAND[id], args: ["auth", "list"], cwd: process.cwd(), timeoutMs: CLI_PROBE_TIMEOUT_MS });
      return parseOpenCodeAuthResult(result);
    }
    case "copilot-cli":
      return observeCopilotAuth(process.env);
    default:
      // Implements PHASE_11_SPEC.md §6.3. Keep a future identity from silently taking
      // another provider's credential path if this exhaustive dispatch is ever widened.
      throw new InternalError(`checkProviderAuth: unsupported provider "${String(id)}"`, { id });
  }
}

const NOT_FOUND_REMEDIATIONS: Readonly<Record<ProviderId, string>> = {
  "claude-code": "Claude Code CLI was not found on PATH. Install it and sign in yourself; osa never installs or signs in on your behalf.",
  "codex-cli": "Codex CLI was not found on PATH. Install it and sign in yourself; osa never installs or signs in on your behalf.",
  "antigravity-cli": "Antigravity CLI (`agy`) was not found on PATH. Install it yourself; osa never installs or signs in on your behalf.",
  "opencode-cli": "OpenCode (`opencode`) was not found on PATH. Install it yourself; osa never installs or signs in on your behalf.",
  "copilot-cli": "GitHub Copilot CLI (`copilot`) was not found on PATH. Install it yourself; osa never installs or signs in on your behalf.",
};

const AUTH_REMEDIATIONS: Readonly<Record<ProviderId, string>> = {
  "claude-code": "Claude Code CLI is not authenticated. Run `claude --help` yourself to find its own sign-in flow; osa only observes credential state and never signs you in.",
  "codex-cli": "Codex CLI is not authenticated. Run `codex --help` yourself to find its own sign-in flow, or set CODEX_API_KEY / OPENAI_API_KEY; osa only observes credential state and never signs you in.",
  "antigravity-cli": "Antigravity CLI is not authenticated via either recognized mode: headless Gemini API key mode (both the modelProvider setting and the GEMINI_API_KEY environment variable) or a cached Google account (subscription) OAuth session (observed from ~/.gemini/oauth_creds.json). Consult `agy --help` and provider documentation; osa only observes credential state.",
  "opencode-cli": "OpenCode has no stored provider login. Run `opencode auth login` yourself to add one (its free built-in models work without a login but are not recognised by osa's model classes); osa only observes credential state and never signs you in.",
  "copilot-cli": "GitHub Copilot CLI has no token in COPILOT_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN. Sign in with `copilot` (its /login command) or set a fine-grained token with the \"Copilot Requests\" permission; osa only observes credential state and never signs you in.",
};

/**
 * The remediation for an `"indeterminate"` probe. Deliberately worded as a *different instruction*
 * from {@link authRemediation}: this is not "go sign in", it is "the check itself did not work, so
 * do not trust either answer". An operator who cannot tell these two apart will follow the sign-in
 * advice, find they are already signed in, and conclude the tool is merely noisy -- which is exactly
 * how the Windows `cmd.exe` quoting defect stayed hidden while `doctor` looked plausible.
 */
const INDETERMINATE_AUTH_REMEDIATIONS: Readonly<Record<ProviderId, (detail: string) => string>> = {
  "claude-code": (detail) => `Claude Code CLI's credential state could NOT be determined -- this is not the same as being signed out, and signing in again will not fix it. The probe failed to produce a conclusive answer (${detail}). Run \`claude --help\` yourself and invoke that CLI's own status command directly to see what it actually reports; osa only observes credential state and never signs you in.`,
  "codex-cli": (detail) => `Codex CLI's credential state could NOT be determined -- this is not the same as being signed out, and signing in again will not fix it. The probe failed to produce a conclusive answer (${detail}). Run \`codex --help\` yourself and invoke that CLI's own status command directly to see what it actually reports; osa only observes credential state and never signs you in.`,
  "antigravity-cli": (detail) => `Antigravity CLI credential state could NOT be determined (${detail}). This is not the same as being signed out; inspect its settings, ~/.gemini/oauth_creds.json, and \`agy --help\` yourself.`,
  "opencode-cli": (detail) => `OpenCode's credential state could NOT be determined (${detail}). This is not the same as being signed out; run \`opencode auth list\` yourself.`,
  "copilot-cli": (detail) => `GitHub Copilot CLI's sign-in state cannot be observed from outside (${detail}). This is not the same as being signed out: if \`copilot\` already works for you, set COPILOT_GITHUB_TOKEN so osa can see it, or run it once and use /login.`,
};

/**
 * Assembles a single provider's {@link PreflightReport}: CLI presence/version, then (only if the
 * CLI was found) its auth state, then the derived `problems` list. This is the exact per-provider
 * block `runPreflight()`'s loop body computed inline in Phase 1, lifted out unchanged so both
 * `runPreflight()` (§below) and each Phase 2 `ProviderAdapter.preflight()` (`src/adapters/*.ts`)
 * assemble a provider's health from this single place -- never two independently-maintained
 * copies of the same version-range/auth-interpretation logic (PRD §9 FM9). Implements
 * PHASE_2_SPEC.md §1.5/§6.5.
 */
export async function buildProviderPreflightReport(id: ProviderId): Promise<PreflightReport> {
  const cli = await checkProviderCli(id);
  const range = PROVIDER_VERSION_RANGES[id];
  const versionInRange = cli.version !== null && inRange(cli.version, range.min, range.maxExclusive);
  // A CLI that was never found could not be probed at all, so its credential state is unknown --
  // "indeterminate", not "signed out". The missing CLI itself is already reported below, so this
  // branch deliberately adds no second problem line.
  const auth: AuthProbeResult = cli.found
    ? await checkProviderAuth(id)
    : authProbeResult("indeterminate", "CLI not found; auth probe skipped");

  const reportProblems: string[] = [];
  if (!cli.found) {
    reportProblems.push(NOT_FOUND_REMEDIATIONS[id]);
  } else if (!versionInRange) {
    reportProblems.push(
      `${id}: version ${cli.version ?? "unknown"} is outside the required range [${range.min}, ${range.maxExclusive}).`,
    );
  }
  if (cli.found && auth.authState === "unauthenticated") {
    reportProblems.push(AUTH_REMEDIATIONS[id]);
  } else if (cli.found && auth.authState === "indeterminate") {
    reportProblems.push(INDETERMINATE_AUTH_REMEDIATIONS[id](auth.detail));
  }

  return {
    provider: id,
    cliFound: cli.found,
    version: cli.version,
    versionInRange,
    authenticated: auth.authenticated,
    authState: auth.authState,
    problems: reportProblems,
  };
}

/**
 * Runs every toolchain and provider check and assembles a {@link PreflightSummary}. Always probes
 * every known provider identity, even if the first fails, so a single run reports every problem at once.
 */
export async function runPreflight(repoDir: string): Promise<PreflightSummary> {
  const node = checkNodeVersion();
  const git = await checkGitAvailable(repoDir);

  const problems: string[] = [];
  if (!node.inRange) {
    problems.push(
      node.found
        ? `Node.js ${node.version ?? "unknown"} is outside the required range [${TOOL_VERSION_RANGES.node.min}, ${TOOL_VERSION_RANGES.node.maxExclusive}).`
        : "Node.js was not found.",
    );
  }
  if (!git.inRange) {
    problems.push(
      git.found
        ? `git ${git.version ?? "unknown"} is outside the required range [${TOOL_VERSION_RANGES.git.min}, ${TOOL_VERSION_RANGES.git.maxExclusive}). Install git >=2.40.0.`
        : "git was not found. Install git >=2.40.0.",
    );
  }

  // Probed in parallel: each probe spawns a CLI and can take seconds.
  const providers: PreflightReport[] = await Promise.all(PROVIDER_IDS.map((id) => buildProviderPreflightReport(id)));

  const healthyCount = providers.filter((p) => p.problems.length === 0).length;
  const ok = node.inRange && git.inRange && healthyCount >= MIN_HEALTHY_PROVIDERS;
  // A provider that is not installed is simply not in use. Once enough providers are healthy, a broken one is a warning (an installed CLI
  // that is signed out is worth a line); until then every provider's remediation is a problem, because there is nothing to run on.
  const warnings: string[] = [];
  if (healthyCount >= MIN_HEALTHY_PROVIDERS) {
    for (const report of providers) if (report.cliFound && report.problems.length > 0) warnings.push(...report.problems);
  } else {
    for (const report of providers) problems.push(...report.problems);
  }
  if (healthyCount < MIN_HEALTHY_PROVIDERS) problems.push(`${String(healthyCount)} providers are usable; at least ${String(MIN_HEALTHY_PROVIDERS)} is required. Install and sign in to one of Claude Code, Codex CLI, Antigravity CLI, OpenCode or GitHub Copilot CLI.`);
  return { node, git, providers, ok, problems, warnings };
}
