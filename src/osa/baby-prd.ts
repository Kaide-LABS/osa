// Baby-PRD rendering, parsing and the deterministic risk backstop.
//
// The markdown file is the source of truth for the locked PRD (it is what gets hashed and committed),
// so it must round-trip: `parseBabyPrd(renderBabyPrd(x))` equals `x`. That is what lets the operator
// choose "Edit" at the lock, change the markdown by hand, and have every later stage read the edited
// structure -- never a stale copy of the pre-edit one.

import { z } from "zod";
import { IntakeError } from "../domain/errors.ts";
import { BabyPrdSchema, RESEARCH_MODULES } from "../domain/intake.ts";
import type { Assumption, BabyPrd, ResearchItem, ResearchModule, ResearchPlan } from "../domain/intake.ts";

const NONE = "(none)";

function bullets(items: readonly string[]): string[] {
  return items.length === 0 ? [`- ${NONE}`] : items.map((i) => `- ${oneLine(i)}`);
}

function oneLine(s: string): string {
  return s.replace(/\s*\r?\n\s*/g, " ").trim();
}

/** `|` is the research-item field separator, so it cannot appear inside a field. */
function noPipe(s: string): string {
  return oneLine(s).replaceAll("|", "/");
}

/** Renders a {@link BabyPrd} as the markdown shown at the lock, in the directive's section order. */
export function renderBabyPrd(prd: BabyPrd): string {
  const plan = prd.researchPlan;
  const risky = prd.assumptions.filter((a) => a.risk === "risky");
  const safe = prd.assumptions.filter((a) => a.risk === "safe");
  const lines: string[] = [
    `# Baby PRD -- ${oneLine(plan.topic)}`,
    "",
    "## TL;DR",
    ...prd.tldr.map((l) => `- ${oneLine(l)}`),
    "",
    "## Baby PRD",
    "",
    "### Problem",
    oneLine(prd.problem),
    "",
    "### Users / who it's for",
    oneLine(prd.users),
    "",
    "### In scope",
    ...bullets(prd.inScope),
    "",
    "### Out of scope",
    ...bullets(prd.outOfScope),
    "",
    "### Acceptance criteria",
    ...prd.acceptanceCriteria.map((c, i) => `${String(i + 1)}. ${oneLine(c)}`),
    "",
    "### Constraints",
    ...bullets(prd.constraints),
    "",
    "### Research plan",
    `- Topic: ${oneLine(plan.topic)}`,
    `- Time range: ${oneLine(plan.timeRange)}`,
    "- Items:",
    ...plan.items.map(
      (it, i) => `  ${String(i + 1)}. ${it.slug} | ${noPipe(it.title)} | ${noPipe(it.question)} | modules: ${it.modules.join(", ")}`,
    ),
    "- Official docs to read:",
    ...(plan.docsTargets.length === 0 ? [`  - ${NONE}`] : plan.docsTargets.map((d) => `  - ${oneLine(d)}`)),
    "- Academic searches:",
    ...(plan.academicQueries.length === 0 ? [`  - ${NONE}`] : plan.academicQueries.map((d) => `  - ${oneLine(d)}`)),
    "- Prior-art searches:",
    ...(plan.priorArtQueries.length === 0 ? [`  - ${NONE}`] : plan.priorArtQueries.map((d) => `  - ${oneLine(d)}`)),
    "",
    "## Assumptions",
    ...(prd.assumptions.length === 0 ? [`- ${NONE}`] : [...risky, ...safe].map((a) => `- [${a.risk}] ${oneLine(a.text)}`)),
    "",
    ...(prd.request === undefined || prd.request.trim() === ""
      ? []
      : [REQUEST_HEADING, "", REQUEST_NOTE, "", ...prd.request.replace(/\r\n?/g, "\n").trimEnd().split("\n").map((l) => (l === "" ? ">" : `> ${l}`)), ""]),
  ];
  return lines.join("\n");
}

/** Heading of the verbatim-request section (also how a hand-edited PRD is parsed back). */
export const REQUEST_HEADING = "## Original request (authoritative)";
const REQUEST_NOTE = "The person's own words, unedited. Where anything above differs from this, this request wins.";

/** The text of the verbatim-request section: its quoted lines with the quote marks removed; `undefined` when there is none. Pure. */
function parseRequest(lines: readonly string[] | undefined): string | undefined {
  if (lines === undefined) return undefined;
  const quoted = lines.filter((l) => l.startsWith(">")).map((l) => l.replace(/^>\s?/, ""));
  const text = quoted.join("\n").trim();
  return text === "" ? undefined : text;
}

/** Splits `text` into sections at lines starting with `prefix` (e.g. "## "), keyed by the heading text. */
function sectionsAt(text: string, prefix: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith(prefix) && !raw.startsWith(prefix + "#")) {
      current = [];
      map.set(raw.slice(prefix.length).trim(), current);
    } else if (current !== null) {
      current.push(raw);
    }
  }
  return map;
}

function listItems(lines: readonly string[], indent = ""): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const m = l.match(new RegExp(`^${indent}-\\s+(.*\\S)\\s*$`));
    if (m?.[1] !== undefined && m[1] !== NONE) out.push(m[1]);
  }
  return out;
}

function numberedItems(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const m = l.match(/^\d+\.\s+(.*\S)\s*$/);
    if (m?.[1] !== undefined) out.push(m[1]);
  }
  return out;
}

function paragraph(lines: readonly string[]): string {
  return lines.map((l) => l.trim()).filter((l) => l !== "").join(" ");
}

function parseResearchPlan(lines: readonly string[]): ResearchPlan {
  // Top-level "- Key:" bullets own the indented lines that follow them.
  const groups = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const l of lines) {
    const m = l.match(/^-\s+([^:]+):\s*(.*)$/);
    if (m?.[1] !== undefined) {
      current = [];
      groups.set(m[1].trim(), current);
      if (m[2] !== undefined && m[2].trim() !== "") current.push(`INLINE ${m[2].trim()}`);
    } else if (current !== null && l.trim() !== "") {
      current.push(l);
    }
  }
  const inline = (key: string): string => {
    const first = groups.get(key)?.find((l) => l.startsWith("INLINE "));
    return first === undefined ? "" : first.slice("INLINE ".length);
  };
  const nested = (key: string): string[] => listItems(groups.get(key) ?? [], "\\s+");

  const items: ResearchItem[] = [];
  for (const l of groups.get("Items") ?? []) {
    const m = l.match(/^\s+\d+\.\s+(.*\S)\s*$/);
    if (m?.[1] === undefined) continue;
    const parts = m[1].split("|").map((p) => p.trim());
    const [slug, title, question, modulesPart] = parts;
    if (slug === undefined || title === undefined || question === undefined || modulesPart === undefined) {
      throw new IntakeError(`Research item is not "slug | title | question | modules: ...": ${m[1]}`);
    }
    const modules = modulesPart
      .replace(/^modules:\s*/i, "")
      .split(",")
      .map((x) => x.trim())
      .filter((x): x is ResearchModule => (RESEARCH_MODULES as readonly string[]).includes(x));
    items.push({ slug, title, question, modules });
  }

  return {
    topic: inline("Topic"),
    timeRange: inline("Time range"),
    items,
    docsTargets: nested("Official docs to read"),
    academicQueries: nested("Academic searches"),
    priorArtQueries: nested("Prior-art searches"),
  };
}

/**
 * Parses the markdown produced by {@link renderBabyPrd} (possibly hand-edited) back into a validated
 * {@link BabyPrd}. Throws {@link IntakeError} with a plain-language reason on any structural problem, so the
 * lock flow can show it and re-open the editor instead of crashing.
 */
export function parseBabyPrd(markdown: string): BabyPrd {
  const top = sectionsAt(markdown, "## ");
  const tldr = listItems(top.get("TL;DR") ?? []);
  const body = sectionsAt((top.get("Baby PRD") ?? []).join("\n"), "### ");
  const assumptions: Assumption[] = [];
  for (const item of listItems(top.get("Assumptions") ?? [])) {
    const m = item.match(/^\[(risky|safe)\]\s+(.*\S)$/i);
    if (m?.[1] === undefined || m[2] === undefined) {
      throw new IntakeError(`Assumption must start with [risky] or [safe]: "${item}"`);
    }
    assumptions.push({ risk: m[1].toLowerCase() === "risky" ? "risky" : "safe", text: m[2] });
  }
  const candidate = {
    tldr,
    problem: paragraph(body.get("Problem") ?? []),
    users: paragraph(body.get("Users / who it's for") ?? []),
    inScope: listItems(body.get("In scope") ?? []),
    outOfScope: listItems(body.get("Out of scope") ?? []),
    acceptanceCriteria: numberedItems(body.get("Acceptance criteria") ?? []),
    constraints: listItems(body.get("Constraints") ?? []),
    researchPlan: parseResearchPlan(body.get("Research plan") ?? []),
    assumptions,
    ...(parseRequest(top.get(REQUEST_HEADING.slice(3))) !== undefined ? { request: parseRequest(top.get(REQUEST_HEADING.slice(3))) as string } : {}),
  };
  const result = BabyPrdSchema.safeParse(candidate);
  if (!result.success) {
    throw new IntakeError(`The baby PRD is not valid: ${z.prettifyError(result.error)}`, { issues: result.error.issues.length });
  }
  return result.data;
}

/**
 * Words that signal an assumption changes security, money, destructive data handling, or architecture if
 * wrong. Deliberately focused rather than exhaustive: it can only ever *upgrade* `safe` to `risky` (never
 * the reverse), so a miss costs nothing the model's own tag did not already cost, and a hit is a cheap
 * extra human look at the lock. Broad words ("database", "schema") are excluded so unattended `--yes`
 * stays usable for ordinary builds.
 */
const RISK_SIGNALS =
  /\b(auth(?:entication|orization|orisation)?|log-?in|passwords?|credentials?|secrets?|api[- ]?keys?|tokens?|oauth|encrypt\w*|pii|personal(?:ly)? (?:data|information)|gdpr|hipaa|permissions?|payments?|billing|credit cards?|paid|subscriptions?|pricing|costs?|delet\w+|drop(?:s|ping)? (?:the )?(?:table|database)|destroy\w*|overwrit\w+|migrat\w+|production|deploy\w*|re-?architect\w*|rewrit\w+|breaking changes?|third[- ]party (?:service|api))\b/i;

/** Result of {@link applyRiskBackstop}. */
export interface BackstopResult {
  readonly prd: BabyPrd;
  /** The texts of assumptions the model tagged `safe` that the backstop upgraded to `risky`. */
  readonly upgraded: readonly string[];
}

/** Upgrades (never downgrades) `safe` assumptions whose text matches {@link RISK_SIGNALS}. */
export function applyRiskBackstop(prd: BabyPrd): BackstopResult {
  const upgraded: string[] = [];
  const assumptions = prd.assumptions.map((a): Assumption => {
    if (a.risk === "safe" && RISK_SIGNALS.test(a.text)) {
      upgraded.push(a.text);
      return { text: a.text, risk: "risky" };
    }
    return a;
  });
  return { prd: { ...prd, assumptions }, upgraded };
}
