// GitHub Copilot CLI (`copilot`) in programmatic mode. [UNVERIFIED-LOCAL] The Copilot CLI is not installed on the machine this adapter was
// written on (the `copilot` on PATH is only the VS Code installer shim), so the flags below come from GitHub's own documentation
// (docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference, read 2026-10-23), not from a live run:
//
//   copilot -p "<short instruction>" -s --no-ask-user [--model=<model>]      (+ --allow-all-tools for a build turn)
//
// * `-p` runs one prompt and exits; `-s`/`--silent` prints only the agent's answer; `--no-ask-user` stops it pausing for input.
// * The prompt itself travels on standard input and `-p` carries a one-line instruction (OSA never puts a prompt on argv: Windows limits
//   a command line to ~32k characters). The documentation mentions piped input for non-interactive use but does not spell out the exact
//   contract, so `docs/osa/COPILOT.md` has a smoke test to run once the real CLI is installed; until it passes, treat this adapter as
//   experimental. `osa doctor` says so.
// * Without `--allow-tool` / `--allow-all-tools`, a non-interactive run cannot use shell or write tools, which is what a read-only text
//   call wants; `--deny-tool` is passed as well so that a user-level setting that allows them cannot widen the call.
// * Authentication: COPILOT_GITHUB_TOKEN, then GH_TOKEN, then GITHUB_TOKEN (a fine-grained token with the "Copilot Requests" permission).

import { InternalError, TurnTimeoutError } from "../domain/errors.ts";
import type { ModelTier } from "../domain/tiers.ts";
import type { ProviderId, RawInvocationResult, TurnOutcome, TurnRequest } from "../domain/run.ts";
import type { Invocation, PreflightReport, ProviderAdapter } from "../ports/provider-adapter.ts";
import type { TextCapabilities, TextCapableAdapter, TextOutcome, TextRequest } from "../ports/text-provider.ts";
import { buildProviderPreflightReport } from "../verify/preflight.ts";

/** Copilot CLI has no effort flag; one neutral value. */
export const COPILOT_EFFORT_VALUES = ["default"] as const;

/** The one-line instruction on `-p`; the actual task is the standard input. */
export const COPILOT_INSTRUCTION = "Carry out the task given on standard input. Reply with the result only.";

/** Provider adapter for the GitHub Copilot CLI (experimental, see the file comment). */
export class CopilotCliAdapter implements ProviderAdapter, TextCapableAdapter {
  readonly id: ProviderId = "copilot-cli";
  readonly textCapabilities: TextCapabilities = { webSearch: false, execute: false };

  preflight(): Promise<PreflightReport> {
    return buildProviderPreflightReport("copilot-cli");
  }

  resolveEffort(tier: ModelTier): string {
    if (tier.length === 0) throw new InternalError("CopilotCliAdapter.resolveEffort: empty tier");
    return "default";
  }

  buildInvocation(req: TurnRequest): Invocation {
    const args = ["-p", COPILOT_INSTRUCTION, "-s", "--no-ask-user", "--allow-all-tools"];
    if (req.modelOverride !== null) args.push(`--model=${req.modelOverride}`);
    return { command: "copilot", args, env: {}, cwd: req.repoDir, stdin: req.prompt };
  }

  interpretResult(raw: RawInvocationResult): TurnOutcome {
    if (raw.timedOut) return { ok: false, record: null, failure: new TurnTimeoutError("copilot-cli turn timed out", { exitCode: raw.exitCode, signal: raw.signal }) };
    if (raw.exitCode !== 0) return { ok: false, record: null, failure: new InternalError(`copilot-cli exited ${String(raw.exitCode)}`, { exitCode: raw.exitCode, signal: raw.signal, stderrExcerpt: raw.stderr.slice(0, 2000) }) };
    if (raw.stdout.trim() === "") return { ok: false, record: null, failure: new InternalError("copilot-cli produced no output", { stderrExcerpt: raw.stderr.slice(0, 2000) }) };
    return { ok: true, record: null, failure: null };
  }

  buildTextInvocation(req: TextRequest): Invocation {
    const args = ["-p", COPILOT_INSTRUCTION, "-s", "--no-ask-user", "--deny-tool=shell", "--deny-tool=write", "--deny-tool=url"];
    if (req.modelOverride !== null) args.push(`--model=${req.modelOverride}`);
    return { command: "copilot", args, env: {}, cwd: req.cwd, stdin: req.prompt };
  }

  interpretTextResult(raw: RawInvocationResult): TextOutcome {
    const turn = this.interpretResult(raw);
    if (!turn.ok) return { ok: false, text: null, failure: turn.failure };
    return { ok: true, text: raw.stdout.trim(), failure: null };
  }
}
