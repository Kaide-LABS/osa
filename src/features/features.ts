// The optional features that are plug-ins (WS10). Each has exactly ONE switch; when it is off, none of that feature's code runs (nothing is imported,
// spawned, indexed, probed or written -- the modules are loaded lazily, only when the switch is on).
//
//   index.engine            "lexical" (default) | "cbm"   the codebase-memory-mcp code index (docs/osa/CBM_NOTES.md)
//   trim.enabled            false (default) | true        the trim-1 context trimmer (docs/osa/TRIM1_NOTES.md)
//   intake.quoteStatedRules false (default) | true        quote the person's stated rules into the acceptance criteria
//
// A switch can be set in `osa.config.json`, overridden for one command by a CLI flag, or left at its default. Precedence: flag > config > default.
// `osa features` lists every switch with its state and where it was set. Token instrumentation is NOT a feature: it is always on.

import { UsageError } from "../domain/errors.ts";
import type { OsaConfig } from "../domain/osa-config.ts";

export type FeatureId = "index.engine" | "trim.enabled" | "intake.quoteStatedRules";

/** Where the effective value of a switch came from. */
export type FeatureSource = "flag" | "config" | "default";

/** Per-command overrides (`--index-engine`, `--trim` / `--no-trim`, `--quote-stated-rules` / `--no-quote-stated-rules`). Absent = not given. */
export interface FeatureFlags {
  readonly indexEngine?: "lexical" | "cbm";
  readonly trim?: boolean;
  readonly quoteStatedRules?: boolean;
}

/** Which switches the config FILE sets explicitly (the schema fills defaults, so the parsed value alone cannot tell). */
export interface ExplicitFeatureKeys {
  readonly indexEngine: boolean;
  readonly trim: boolean;
  readonly quoteStatedRules: boolean;
}

export const NO_EXPLICIT_KEYS: ExplicitFeatureKeys = { indexEngine: false, trim: false, quoteStatedRules: false };

/** One switch as `osa features`, `osa doctor` and the `feature_state` event report it. */
export interface FeatureState {
  readonly id: FeatureId;
  readonly name: string;
  /** The effective value: "lexical" | "cbm", or "on" | "off". */
  readonly value: string;
  readonly enabled: boolean;
  readonly source: FeatureSource;
  /** The config key and the flags that control it. */
  readonly setting: string;
  readonly flags: string;
  /** One line about what it does and why it is (not) on. */
  readonly note: string;
}

/** The effective configuration with `flags` applied over it. Pure. */
export function applyFeatureFlags(config: OsaConfig, flags: FeatureFlags): OsaConfig {
  return {
    ...config,
    index: flags.indexEngine === undefined ? config.index : { ...config.index, engine: flags.indexEngine },
    trim: flags.trim === undefined ? config.trim : { ...config.trim, enabled: flags.trim },
    intake: flags.quoteStatedRules === undefined ? config.intake : { ...config.intake, quoteStatedRules: flags.quoteStatedRules },
  };
}

/** The state of every switch of the EFFECTIVE `config` (flags already applied), with where each was set. Pure. */
export function describeFeatures(config: OsaConfig, explicit: ExplicitFeatureKeys = NO_EXPLICIT_KEYS, flags: FeatureFlags = {}): FeatureState[] {
  const src = (flag: boolean, inFile: boolean): FeatureSource => (flag ? "flag" : inFile ? "config" : "default");
  const cbm = config.index.engine === "cbm";
  return [
    {
      id: "index.engine",
      name: "code index engine (codebase-memory-mcp)",
      value: config.index.engine,
      enabled: cbm,
      source: src(flags.indexEngine !== undefined, explicit.indexEngine),
      setting: 'index.engine: "lexical" | "cbm"',
      flags: "--index-engine lexical|cbm",
      note: cbm
        ? "CBM answers code searches behind OSA's confidence guard and falls back to the lexical index when unsure or unavailable"
        : "OSA's own lexical index answers; no CBM process, index, session or files (CBM missed its pass bar, docs/osa/TEST_REPORT.md Suite 7)",
    },
    {
      id: "trim.enabled",
      name: "context trimmer (trim-1)",
      value: config.trim.enabled ? "on" : "off",
      enabled: config.trim.enabled,
      source: src(flags.trim !== undefined, explicit.trim),
      setting: "trim.enabled: true | false",
      flags: "--trim | --no-trim",
      note: config.trim.enabled
        ? "handoffs go through trim-1 when its binary is installed (the no-op trimmer otherwise)"
        : "handoffs use the no-op trimmer; trim-1 is never probed or run (it saved 0.3-2.8 % of a run, Suite 9)",
    },
    {
      id: "intake.quoteStatedRules",
      name: "quote the stated rules into the acceptance criteria",
      value: config.intake.quoteStatedRules ? "on" : "off",
      enabled: config.intake.quoteStatedRules,
      source: src(flags.quoteStatedRules !== undefined, explicit.quoteStatedRules),
      setting: "intake.quoteStatedRules: true | false",
      flags: "--quote-stated-rules | --no-quote-stated-rules",
      note: config.intake.quoteStatedRules
        ? "intake copies the person's stated rules word for word into the criteria"
        : "the criteria are the model's own; most quoted criteria were trivial (Suite 9)",
    },
  ];
}

/**
 * Reads one feature flag from `args` at index `i`. Returns the overrides it sets and the index of the last argument it consumed, or `null` when
 * `args[i]` is not a feature flag. A flag with a missing or invalid value is a UsageError.
 */
export function parseFeatureFlag(args: readonly string[], i: number): { readonly patch: FeatureFlags; readonly last: number } | null {
  const a = args[i];
  if (a === "--index-engine") {
    const v = args[i + 1];
    if (v !== "lexical" && v !== "cbm") throw new UsageError('--index-engine must be "lexical" or "cbm".', { flag: a, value: v ?? null });
    return { patch: { indexEngine: v }, last: i + 1 };
  }
  if (a === "--trim") return { patch: { trim: true }, last: i };
  if (a === "--no-trim") return { patch: { trim: false }, last: i };
  if (a === "--quote-stated-rules") return { patch: { quoteStatedRules: true }, last: i };
  if (a === "--no-quote-stated-rules") return { patch: { quoteStatedRules: false }, last: i };
  return null;
}

/** Merges two override sets (the later one wins). Pure. */
export function mergeFlags(a: FeatureFlags, b: FeatureFlags): FeatureFlags {
  return { ...a, ...b };
}

/** The `osa features` text. Pure. */
export function renderFeatures(states: readonly FeatureState[]): string {
  const lines = ["osa features -- optional plug-ins (each has one switch; off = none of its code runs)", ""];
  for (const f of states) {
    lines.push(`${f.name}`, `  state:   ${f.enabled ? "ENABLED" : "disabled"} (${f.value}), set by ${f.source}`, `  switch:  ${f.setting}   flags: ${f.flags}`, `  ${f.note}`, "");
  }
  lines.push("Precedence: flag > osa.config.json > default. Token instrumentation is always on.");
  return `${lines.join("\n")}\n`;
}
