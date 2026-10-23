// The `validate_json` equivalent (Deep-Research-skills pattern, ported to TypeScript -- docs/osa/CONFLICTS.md
// C-05). A result is COMPLETE only when every field in the field schema is covered, with the right shape,
// and the `[uncertain]` bookkeeping is consistent. Resume uses it: an item whose JSON already validates is
// skipped; one that does not is re-run.

import { ResearchSourceSchema, UNCERTAIN_MARKER } from "../domain/research.ts";
import type { FieldSpec, ResearchSource } from "../domain/research.ts";

/** The verdict of {@link validateItemResult}. `valid` iff `problems` is empty. */
export interface ValidationVerdict {
  readonly valid: boolean;
  /** Required fields that are absent or empty. */
  readonly missing: readonly string[];
  /** Every problem, including the missing ones, in plain language. */
  readonly problems: readonly string[];
}

/** Options of {@link validateItemResult}. */
export interface ValidateOptions {
  /** The item is a documentation item: at least one `official-docs` source is mandatory. */
  readonly requireOfficialDocs?: boolean;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function stringsOf(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return (v as unknown[]).flatMap((x) => (typeof x === "string" ? [x] : []));
  return [];
}

/** Validates one item's parsed JSON against its field list. Pure. */
export function validateItemResult(result: unknown, fields: readonly FieldSpec[], opts: ValidateOptions = {}): ValidationVerdict {
  const missing: string[] = [];
  const problems: string[] = [];
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return { valid: false, missing: fields.filter((f) => f.required).map((f) => f.name), problems: ["The result is not a JSON object."] };
  }
  const obj = result as Record<string, unknown>;

  for (const f of fields) {
    const v = obj[f.name];
    if (v === undefined || v === null) {
      if (f.required) {
        missing.push(f.name);
        problems.push(`Required field "${f.name}" is missing.`);
      }
      continue;
    }
    if (f.type === "string") {
      if (!isNonEmptyString(v)) {
        if (f.required) {
          missing.push(f.name);
          problems.push(`Required field "${f.name}" must be a non-empty string.`);
        }
      }
    } else if (f.type === "string[]") {
      const ok = Array.isArray(v) && (v as unknown[]).every((x) => isNonEmptyString(x));
      if (!ok) {
        problems.push(`Field "${f.name}" must be an array of non-empty strings.`);
      } else if (f.required && (v as unknown[]).length === 0) {
        missing.push(f.name);
        problems.push(`Required field "${f.name}" must have at least one entry.`);
      }
    } else {
      // sources
      if (!Array.isArray(v)) {
        problems.push(`Field "${f.name}" must be an array of sources.`);
      } else {
        const parsed = (v as unknown[]).map((s) => ResearchSourceSchema.safeParse(s));
        parsed.forEach((p, i) => {
          if (!p.success) problems.push(`Field "${f.name}"[${String(i)}] is not a valid source (need title, http(s) url, type): ${p.error.issues[0]?.message ?? "invalid"}.`);
        });
        if (f.required && v.length === 0) {
          missing.push(f.name);
          problems.push(`Required field "${f.name}" must cite at least one source.`);
        }
        if (opts.requireOfficialDocs === true) {
          const good = parsed.flatMap((p) => (p.success ? [p.data] : []));
          if (!good.some((s: ResearchSource) => s.type === "official-docs")) {
            problems.push(`A documentation item must cite at least one source of type "official-docs".`);
          }
        }
      }
    }
  }

  // `uncertain` bookkeeping: always present as an array; marked fields <-> named fields.
  const uncertain = obj["uncertain"];
  if (!Array.isArray(uncertain) || !(uncertain as unknown[]).every((x) => typeof x === "string")) {
    missing.push("uncertain");
    problems.push(`The "uncertain" array is required (use [] when nothing is uncertain).`);
  } else {
    const named = new Set(uncertain as string[]);
    for (const name of named) {
      if (!(name in obj) || name === "uncertain") problems.push(`"uncertain" names "${name}", which is not a field of this result.`);
    }
    for (const [name, v] of Object.entries(obj)) {
      if (name === "uncertain") continue;
      if (stringsOf(v).some((s) => s.includes(UNCERTAIN_MARKER)) && !named.has(name)) {
        problems.push(`Field "${name}" contains ${UNCERTAIN_MARKER} but is not listed in the "uncertain" array.`);
      }
    }
  }

  return { valid: problems.length === 0, missing, problems };
}
