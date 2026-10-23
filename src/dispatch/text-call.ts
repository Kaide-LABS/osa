// The production {@link TextCall}: resolve the adapter, build the (pure) text invocation, merge env the same
// way `runTurn` does (`{ ...process.env, ...invocation.env }`), spawn through the one sanctioned
// `runProcess`, interpret. A provider that cannot do text calls is a modelled failure, not a throw.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { InternalError } from "../domain/errors.ts";
import type { ProviderId } from "../domain/run.ts";
import type { AdapterRegistry } from "../ports/provider-adapter.ts";
import type { TextCall, TextCallResult } from "../ports/text-provider.ts";
import { isTextCapable } from "../ports/text-provider.ts";
import { ADAPTER_REGISTRY } from "../adapters/registry.ts";
import { runProcess } from "../util/exec.ts";
import { withoutCredentials, withoutOsaSecrets } from "../util/safe-env.ts";
import { findSecret } from "../memory/secrets.ts";
import { labelFailure } from "./failure-kind.ts";
import { isolateInvocation } from "./provider-isolation.ts";
import type { EventSink } from "../osa/events.ts";

/** The last words a failed provider CLI printed (stderr, else stdout), short and withheld if they look like a credential. Pure. */
export function failureEvidence(raw: { readonly stderr: string; readonly stdout: string }): string {
  const said = (raw.stderr.trim() !== "" ? raw.stderr : raw.stdout).replace(/\s+/g, " ").trim();
  const tail = said.slice(-500);
  return findSecret(tail) !== null ? "[withheld: the output looked like a credential]" : tail;
}

/** Dependencies of {@link makeTextCall}; every field defaults to the real thing. */
export interface TextCallDeps {
  readonly adapters?: Readonly<Partial<AdapterRegistry>>;
  readonly runProcessFn?: typeof runProcess;
  readonly events?: EventSink;
  /** Default per-provider model, used when a request does not carry its own `modelOverride`. */
  readonly modelOverrides?: Readonly<Partial<Record<ProviderId, string>>>;
}

function filteredProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** Builds the production {@link TextCall}. Logs a `text_call` event per call when `deps.events` is given. */
export function makeTextCall(deps: TextCallDeps = {}): TextCall {
  const spawn = deps.runProcessFn ?? runProcess;
  return async (provider: ProviderId, req, purpose): Promise<TextCallResult> => {
    const adapter = deps.adapters?.[provider] ?? ADAPTER_REGISTRY[provider];
    if (!isTextCapable(adapter)) {
      const outcome = { ok: false, text: null, failure: new InternalError(`${provider} does not support text calls`, { provider }) };
      return { provider, outcome, durationMs: 0 };
    }
    if (req.webSearch && !adapter.textCapabilities.webSearch) {
      const outcome = {
        ok: false,
        text: null,
        failure: new InternalError(`${provider} has no built-in web search; route this call to a provider that does`, { provider }),
      };
      return { provider, outcome, durationMs: 0 };
    }
    if (req.execute === true && !adapter.textCapabilities.execute) {
      const outcome = { ok: false, text: null, failure: new InternalError(`${provider} cannot run commands in a text call; route this call to a provider that can`, { provider }) };
      return { provider, outcome, durationMs: 0 };
    }
    // CONTAINMENT (Suite 2). A call that can reach the open web reads attacker-controlled pages, so it must hold nothing
    // worth stealing and nothing it could damage: it runs in a fresh EMPTY directory (not the repository, so no .env or
    // source to read and send out), and with a credential-free environment. The adapters also drop the file-reading tools
    // for such a call (Claude) or run it in a read-only sandbox (Codex).
    const isolated = req.webSearch;
    const scratch = isolated ? await mkdtemp(`${tmpdir()}/osa-web-`) : null;
    const effective = {
      ...req,
      cwd: scratch ?? req.cwd,
      modelOverride: req.modelOverride === null ? (deps.modelOverrides?.[provider] ?? null) : req.modelOverride,
    };
    const invocation = await isolateInvocation(provider, adapter.buildTextInvocation(effective));
    const started = Date.now();
    const baseEnv = req.webSearch || req.execute === true ? withoutCredentials(filteredProcessEnv()) : withoutOsaSecrets(filteredProcessEnv());
    let raw;
    try {
      raw = await spawn({
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        env: { ...baseEnv, ...invocation.env },
        stdin: invocation.stdin,
        timeoutMs: req.timeoutMs,
      });
    } finally {
      if (scratch !== null) await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    }
    const interpreted = adapter.interpretTextResult(raw);
    const outcome = interpreted.ok || interpreted.failure === null ? interpreted : { ...interpreted, failure: labelFailure(provider, interpreted.failure, raw) };
    const durationMs = Date.now() - started;
    await deps.events?.emit("text_call", {
      provider,
      purpose,
      ok: outcome.ok,
      webSearch: req.webSearch,
      isolatedCwd: isolated,
      durationMs,
      failure: outcome.failure?.message ?? null,
      failureKind: (outcome.failure?.details as Record<string, unknown> | undefined)?.["failureKind"] ?? null,
      // What the CLI itself said, so "it exited with code 1" can be diagnosed from the log (a failed call only).
      ...(outcome.ok ? {} : { evidence: failureEvidence(raw) }),
    });
    return { provider, outcome, durationMs };
  };
}
