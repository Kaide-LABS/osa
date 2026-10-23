// The three OSA agents (OSA_DIRECTIVE.md WS6), declared in one place. Each agent has: its own prompt module
// (`implication.ts`, `lateral-architecture.ts`, `application.ts` -- prompts are TypeScript so they ship in the
// published package), declared inputs and outputs, an assignable provider, a config gate (default ON), and a
// stable event name in the JSONL log.

import type { OsaEventName } from "../osa/events.ts";

/** Static description of one agent. */
export interface AgentSpec {
  readonly name: "implication" | "lateral-architecture" | "application";
  readonly description: string;
  /** What the agent reads. */
  readonly inputs: readonly string[];
  /** What it produces. */
  readonly outputs: readonly string[];
  /** The `osa.config.json` key that gates it (`agents.<key>`), default true. */
  readonly configGate: "implication" | "lateralArchitecture" | "application";
  /** The `osa.config.json` key that assigns its provider (`agents.<key>`). */
  readonly providerKey: "implicationProvider" | "lateralArchitectureProvider" | "applicationProvider";
  /** Where it runs when the provider key is not set. */
  readonly defaultProvider: string;
  readonly event: OsaEventName;
  /** Where in the pipeline it runs. */
  readonly runsAfter: string;
  /** Whether a failure of the agent itself stops the run. */
  readonly failureIsFatal: boolean;
}

export const AGENT_SPECS: readonly AgentSpec[] = [
  {
    name: "lateral-architecture",
    description: "Proposes at least one materially different architecture to the planned one, with trade-offs. The planner records which was chosen and why.",
    inputs: ["locked baby PRD", "planned architecture (from the draft context.md)", "research digest"],
    outputs: ["architecture alternatives with trade-offs", "an 'Architecture decision' section in context.md (chosen option and reason)"],
    configGate: "lateralArchitecture",
    providerKey: "lateralArchitectureProvider",
    defaultProvider: "codex-cli (never the planner's provider unless agents.lateralArchitecturePinned)",
    event: "lateral_arch_done",
    runsAfter: "the draft spec",
    failureIsFatal: false,
  },
  {
    name: "implication",
    description: "Lists second-order consequences of the spec (data, security, performance, maintenance, cost, user impact) and turns material ones into acceptance criteria or explicit out-of-scope lines in the SPEC.",
    inputs: ["locked baby PRD", "context.md", "PHASE_1_SPEC.md"],
    outputs: ["an 'Implications' section appended to PHASE_1_SPEC.md (never the locked PRD)"],
    configGate: "implication",
    providerKey: "implicationProvider",
    defaultProvider: "the other provider of providers.pair (an independent read of the spec)",
    event: "implication_done",
    runsAfter: "the spec, before build",
    failureIsFatal: false,
  },
  {
    name: "application",
    description: "Exercises the built result as a user would (runs the CLI/app/endpoints) against the acceptance criteria, records evidence, and fails the run on unmet criteria.",
    inputs: ["locked baby PRD acceptance criteria", "spec's additional acceptance criteria", "a disposable clone of the built repository"],
    outputs: ["runs/<id>/application/evidence.json", "runs/<id>/application/report.md"],
    configGate: "application",
    providerKey: "applicationProvider",
    defaultProvider: "providers.pair[1], falling back to pair[0] if it cannot run commands",
    event: "application_check",
    runsAfter: "the build",
    failureIsFatal: true,
  },
];
