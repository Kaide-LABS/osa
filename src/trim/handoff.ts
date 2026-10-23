// Handoff trimming (OSA_DIRECTIVE.md WS4.2/4.3). A handoff is a list of PARTS; each part is either trimmable
// (research output, phase output, relay text) or protected. Protected parts never reach the trimmer at all --
// they pass through byte-identical -- and the locked PRD, the spec and acceptance criteria *cannot* be
// marked trimmable: the attempt is an InternalError, not a quiet downgrade. Every decision is logged
// (`trim_applied` with before/after token estimates and ratio, or `trim_skipped` with the reason).

import { InternalError } from "../domain/errors.ts";
import type { EventSink } from "../osa/events.ts";
import type { ContextTrimmer } from "./trimmer.ts";

/** Labels that may NEVER be trimmed (compared case-insensitively). */
export const NEVER_TRIM_LABELS: ReadonlySet<string> = new Set(["prd", "baby-prd", "locked-prd", "spec", "phase-spec", "acceptance", "acceptance-criteria", "context"]);

/** One piece of a handoff. */
export interface HandoffPart {
  readonly label: string;
  readonly text: string;
  readonly trimmable: boolean;
  /** What the reader will do with this text (query-conditioned engines need it). */
  readonly query?: string;
  /** Extra literal substrings whose lines must survive. */
  readonly keep?: readonly string[];
  /** Token budget for this part (default: the handoff's `defaultBudgetTokens`). */
  readonly budgetTokens?: number;
}

/** A processed part. */
export interface HandoffOutPart {
  readonly label: string;
  readonly text: string;
  readonly trimmed: boolean;
}

/** The result of {@link trimHandoff}. */
export interface HandoffResult {
  readonly parts: readonly HandoffOutPart[];
}

/** Collaborators of {@link trimHandoff}. */
export interface HandoffDeps {
  readonly trimmer: ContextTrimmer;
  readonly events: EventSink;
  /** Default budget for a trimmable part that does not carry its own. */
  readonly defaultBudgetTokens: number;
  /** Why a non-noop engine isn't in use (logged on every skip so the cause is never silent). */
  readonly engineNote?: string | null;
}

/** Runs every part through the trimmer (or around it, if protected). Order is preserved. */
export async function trimHandoff(parts: readonly HandoffPart[], deps: HandoffDeps): Promise<HandoffResult> {
  const out: HandoffOutPart[] = [];
  for (const part of parts) {
    if (part.trimmable && NEVER_TRIM_LABELS.has(part.label.toLowerCase())) {
      throw new InternalError(`Refusing to trim "${part.label}": the locked PRD, the spec and acceptance criteria are never trimmed.`, { label: part.label });
    }
    if (!part.trimmable) {
      out.push({ label: part.label, text: part.text, trimmed: false });
      continue;
    }
    const result = await deps.trimmer.trim(part.text, {
      budgetTokens: part.budgetTokens ?? deps.defaultBudgetTokens,
      keep: part.keep ?? [],
      ...(part.query !== undefined ? { query: part.query } : {}),
    });
    if (result.applied) {
      await deps.events.emit("trim_applied", {
        label: part.label,
        engine: result.engine,
        point: result.point,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        ratio: Number(result.ratio.toFixed(4)),
        removedLines: result.removedLines,
        metBudget: result.metBudget,
      });
      out.push({ label: part.label, text: result.output, trimmed: true });
    } else {
      await deps.events.emit("trim_skipped", {
        label: part.label,
        engine: result.engine,
        reason: result.reason ?? "no reason given",
        engineNote: deps.engineNote ?? null,
        beforeTokens: result.beforeTokens,
      });
      out.push({ label: part.label, text: part.text, trimmed: false });
    }
  }
  return { parts: out };
}

/** Convenience for the common single-trimmable-part case: returns just the text. */
export async function trimText(label: string, text: string, query: string, deps: HandoffDeps, keep: readonly string[] = []): Promise<string> {
  const r = await trimHandoff([{ label, text, trimmable: true, query, keep }], deps);
  return r.parts[0]?.text ?? text;
}
