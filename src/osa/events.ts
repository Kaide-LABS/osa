// OSA's JSONL event log. Every config-gated feature logs to it with a *stable event name* (OSA_DIRECTIVE.md
// Ground Rule 6 + "Logging / config summary"). One file per OSA run:
// `.osa/runs/<run-id>/events.jsonl`. Append-only; a logging failure never fails the run (it is
// reported through the sink's `lastError`), exactly like the chat log's contract.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { osaDir } from "../util/paths.ts";

/** The stable event names. The directive's required set first, then the pipeline's own additions. */
export const OSA_EVENT_NAMES = [
  // required by the directive
  "assumptions_generated",
  "prd_locked",
  "research_item_done",
  "research_validated",
  "research_crosscheck",
  "academic_query",
  "github_lookup",
  "trim_applied",
  "trim_skipped",
  "implication_done",
  "lateral_arch_done",
  "application_check",
  "feature_state",
  "application_sandbox_leftover",
  "index_updated",
  "memory_written",
  // additions
  "run_started",
  "config_loaded",
  "text_call",
  "prd_lock_refused",
  "prd_lock_cancelled",
  "prd_integrity_verified",
  "research_routed",
  "research_docs_checked",
  "spec_assumption",
  "spec_written",
  "step14_done",
  "injection_flagged",
  "token_breakdown",
  "code_search_engine",
  "http_rate_limited",
  "run_finished",
] as const;

/** A member of {@link OSA_EVENT_NAMES}. */
export type OsaEventName = (typeof OSA_EVENT_NAMES)[number];

/** One line of `events.jsonl`. */
export interface OsaEvent {
  readonly schema_version: 1;
  readonly at: string;
  readonly run_id: string;
  readonly event: OsaEventName;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Where pipeline stages report events. Injected so tests can assert on an in-memory list. */
export interface EventSink {
  emit(event: OsaEventName, data?: Readonly<Record<string, unknown>>): Promise<void>;
}

/** The `events.jsonl` path for an OSA run. */
export function eventsPath(repoDir: string, runId: string): string {
  return `${osaDir(repoDir)}/runs/${runId}/events.jsonl`;
}

/** An {@link EventSink} appending to `events.jsonl`. Never throws; failures are kept in `lastError`. */
export class FileEventSink implements EventSink {
  readonly path: string;
  readonly runId: string;
  lastError: string | null = null;

  constructor(repoDir: string, runId: string) {
    this.path = eventsPath(repoDir, runId);
    this.runId = runId;
  }

  async emit(event: OsaEventName, data: Readonly<Record<string, unknown>> = {}): Promise<void> {
    const line: OsaEvent = { schema_version: 1, at: new Date().toISOString(), run_id: this.runId, event, data };
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, JSON.stringify(line) + "\n", "utf8");
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}

/** An in-memory {@link EventSink}, for tests and for stages that need to inspect what they emitted. */
export class MemoryEventSink implements EventSink {
  readonly events: OsaEvent[] = [];
  readonly runId: string;

  constructor(runId = "00000000-0000-4000-8000-000000000000") {
    this.runId = runId;
  }

  emit(event: OsaEventName, data: Readonly<Record<string, unknown>> = {}): Promise<void> {
    this.events.push({ schema_version: 1, at: new Date().toISOString(), run_id: this.runId, event, data });
    return Promise.resolve();
  }

  /** The names emitted so far, in order. */
  names(): OsaEventName[] {
    return this.events.map((e) => e.event);
  }
}
