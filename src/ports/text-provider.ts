// The text-call port. `ProviderAdapter` is turn-shaped (it needs a full `TurnRequest`, a handoff record and
// a git repo). OSA's intake, research, review and agent stages instead need "send this prompt, give me the
// text back" -- optionally with the provider's own built-in web search. This is that seam, kept separate so
// `ProviderAdapter` and every existing adapter contract stay exactly as they were.
//
// Like `buildInvocation`, `buildTextInvocation` must be pure; the I/O lives in `src/dispatch/text-call.ts`.

import type { OsaError } from "../domain/errors.ts";
import type { ModelTier } from "../domain/tiers.ts";
import type { ProviderId, RawInvocationResult } from "../domain/run.ts";
import type { Invocation, ProviderAdapter } from "./provider-adapter.ts";

/** What a stage asks a provider for. */
export interface TextRequest {
  readonly prompt: string;
  /** Working directory the provider CLI is started in (read-only access to the target repo is allowed). */
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly tier: ModelTier;
  /** Use the provider's own built-in web search / fetch. Callers must check {@link TextCapabilities.webSearch} first. */
  readonly webSearch: boolean;
  /** Operator model override (`RunConfig.model_overrides` semantics); `null` = the CLI's own default. */
  readonly modelOverride: string | null;
  /**
   * Let the provider RUN commands (a shell) in `cwd`, in addition to the read-only tools -- used only by the
   * application agent, which exercises the built project. Never grants a file-edit tool; callers must point
   * `cwd` at a disposable copy of the repository. Callers must check {@link TextCapabilities.execute} first.
   */
  readonly execute?: boolean;
}

/** The result of interpreting a text call. `ok` iff `text` is non-null. */
export interface TextOutcome {
  readonly ok: boolean;
  readonly text: string | null;
  readonly failure: OsaError | null;
}

/** What a provider can do in a text call. */
export interface TextCapabilities {
  /** The provider CLI exposes a built-in web search / fetch tool in print mode. */
  readonly webSearch: boolean;
  /** The provider CLI can run shell commands in print mode when asked ({@link TextRequest.execute}). */
  readonly execute: boolean;  /**
   * What a WEB-ENABLED call can still reach on the local machine (Suite 2, live-verified): `no-file-access` = only web tools
   * exist (Claude Code); `read-only-files` = a read-only sandbox that still lets the model read files outside its working
   * directory (Codex CLI). Absent = assume the weaker `read-only-files`.
   */
  readonly webContainment?: "no-file-access" | "read-only-files";
}

/** An adapter that can also serve text calls. All three shipped adapters implement it. */
export interface TextCapableAdapter extends ProviderAdapter {
  readonly textCapabilities: TextCapabilities;
  /** Pure: builds the invocation for one text call. Never grants write tools. */
  buildTextInvocation(req: TextRequest): Invocation;
  /** Pure: interprets a completed process result. */
  interpretTextResult(raw: RawInvocationResult): TextOutcome;
}

/** Type guard for {@link TextCapableAdapter}. */
export function isTextCapable(adapter: ProviderAdapter): adapter is TextCapableAdapter {
  const a = adapter as Partial<TextCapableAdapter>;
  return typeof a.buildTextInvocation === "function" && typeof a.interpretTextResult === "function" && a.textCapabilities !== undefined;
}

/** One completed text call, as returned by a {@link TextCall}. */
export interface TextCallResult {
  readonly provider: ProviderId;
  readonly outcome: TextOutcome;
  readonly durationMs: number;
}

/** The function stages call. Production: `makeTextCall()`; tests inject fakes. Never throws for a modelled failure. */
export type TextCall = (provider: ProviderId, req: TextRequest, purpose: string) => Promise<TextCallResult>;
