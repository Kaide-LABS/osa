// The intake data model: TL;DR + baby PRD + tagged assumptions (OSA_DIRECTIVE.md WS2). Pure zod schemas.
//
// The research plan lives *inside* the PRD on purpose. The Deep-Research skills OSA adapts stop to ask
// the human about outline confirmation, time range, existing fields, batch size and next-batch approval;
// OSA settles every one of those at the lock (WS3.2), so each is a field here rather than a prompt later.

import { z } from "zod";

/** `safe` = reversible, low-impact, conventional default. `risky` = would change scope/architecture/data/cost/security if wrong. `defaulted` = a recommended-question default the person did not answer. */
export const ASSUMPTION_RISKS = ["safe", "risky", "defaulted"] as const;
export type AssumptionRisk = (typeof ASSUMPTION_RISKS)[number];

/** Scope of the prompt: 'narrow' (specific) or 'broad' (vague). */
export const SCOPES = ["narrow", "broad"] as const;
export type Scope = (typeof SCOPES)[number];

/** Search modules a research item may load (WS3.1). */
export const RESEARCH_MODULES = ["general-web", "github-debug", "stackoverflow", "academic-papers"] as const;
export type ResearchModule = (typeof RESEARCH_MODULES)[number];

const NonEmpty = z.string().trim().min(1);

export const RecommendedQuestionSchema = z.strictObject({
  question: z.string().trim().min(1).max(300),
  default: z.string().trim().min(1).max(500),
});
export type RecommendedQuestion = z.infer<typeof RecommendedQuestionSchema>;

export const AssumptionSchema = z.strictObject({
  text: NonEmpty.max(500),
  risk: z.enum(ASSUMPTION_RISKS),
});
export type Assumption = z.infer<typeof AssumptionSchema>;

export const ResearchItemSchema = z.strictObject({
  /** kebab-case identifier; becomes `research/results/<slug>.json`. */
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be kebab-case").max(60),
  title: NonEmpty.max(120),
  /** The question this item answers for the build. */
  question: NonEmpty.max(400),
  modules: z.array(z.enum(RESEARCH_MODULES)).min(1),
});
export type ResearchItem = z.infer<typeof ResearchItemSchema>;

export const ResearchPlanSchema = z.strictObject({
  topic: NonEmpty.max(200),
  /** Settled at the lock instead of asked mid-run, e.g. "last 3 years". */
  timeRange: NonEmpty.max(80),
  items: z.array(ResearchItemSchema).min(1).max(64),
  /** Libraries / frameworks / APIs named in the PRD; each needs an official-docs source (WS3.2). */
  docsTargets: z.array(NonEmpty.max(120)).max(64),
  academicQueries: z.array(NonEmpty.max(200)).max(16),
  priorArtQueries: z.array(NonEmpty.max(200)).max(16),
});
export type ResearchPlan = z.infer<typeof ResearchPlanSchema>;

/** The most of the person's request kept verbatim in the PRD. */
export const REQUEST_MAX_CHARS = 8000;

/** The structured baby PRD. `tldr` is 3-5 plain-language lines. */
export const BabyPrdSchema = z.strictObject({
  tldr: z.array(NonEmpty.max(300)).min(3).max(5),
  problem: NonEmpty.max(1500),
  users: NonEmpty.max(800),
  inScope: z.array(NonEmpty.max(400)).min(1).max(30),
  outOfScope: z.array(NonEmpty.max(400)).max(30),
  /** Falsifiable, rendered as a numbered list. */
  acceptanceCriteria: z.array(NonEmpty.max(500)).min(1).max(40),
  constraints: z.array(NonEmpty.max(400)).max(30),
  researchPlan: ResearchPlanSchema,
  assumptions: z.array(AssumptionSchema).max(60),
  scope: z.enum(SCOPES).default("narrow"),
  recommendedQuestions: z.array(RecommendedQuestionSchema).max(10).default([]),
  /**
   * The person's own request, verbatim, kept inside the locked PRD and authoritative over every summary above it. Intake rewrites what it was
   * told into scope lines and criteria, and a model summarising a precise request drops or contradicts details of it (found by the live
   * e2e run: an explicit "ASCII letters only" rule became an assumption that words include Unicode letters, and the build followed that).
   */
  request: z.string().max(REQUEST_MAX_CHARS + 100).optional(),
});
export type BabyPrd = z.infer<typeof BabyPrdSchema>;

/** True iff the PRD carries at least one `risky` assumption. */
export function hasRiskyAssumption(prd: Pick<BabyPrd, "assumptions">): boolean {
  return prd.assumptions.some((a) => a.risk === "risky");
}
