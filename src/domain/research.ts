// Research-stage data model (OSA_DIRECTIVE.md WS3.1): the outline, the field schema, per-item results.
// Adapted from the Deep-Research-skills two-file pattern (outline.yaml + fields.yaml + one JSON per item).
// Pure zod schemas, no I/O.

import { z } from "zod";
import { RESEARCH_MODULES } from "./intake.ts";

/** Marker an agent puts on any value it could not verify. Every marked field must also be named in `uncertain`. */
export const UNCERTAIN_MARKER = "[uncertain]";

/** What kind of source a citation is. `official-docs` is what the mandatory documentation check counts. */
export const SOURCE_TYPES = ["official-docs", "paper", "repo", "article", "forum", "other"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const ResearchSourceSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  url: z.string().trim().regex(/^https?:\/\/\S+$/, "url must be an http(s) URL").max(2000),
  type: z.enum(SOURCE_TYPES),
  /** A short excerpt that supports the claim -- lets a reviewer without web access check consistency. */
  quote: z.string().max(600).optional(),
});
export type ResearchSource = z.infer<typeof ResearchSourceSchema>;

export const FIELD_TYPES = ["string", "string[]", "sources"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FieldSpecSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
});
export type FieldSpec = z.infer<typeof FieldSpecSchema>;

/** `fields.yaml`: the schema every item result must satisfy. `byItem` adds fields for specific items. */
export const FieldsFileSchema = z.strictObject({
  common: z.array(FieldSpecSchema).min(1),
  byItem: z.record(z.string(), z.array(FieldSpecSchema)),
});
export type FieldsFile = z.infer<typeof FieldsFileSchema>;

/** `research` = open question for an agent; `docs` = an agent item that must cite official documentation. */
export const ITEM_KINDS = ["research", "docs"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const OutlineItemSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  title: z.string().min(1),
  question: z.string().min(1),
  kind: z.enum(ITEM_KINDS),
  modules: z.array(z.enum(RESEARCH_MODULES)).min(1),
});
export type OutlineItem = z.infer<typeof OutlineItemSchema>;

/**
 * `outline.yaml`. `execution` carries every setting the original skills asked the human about mid-run
 * (time range, batch size, resume, ...). They are settled from the locked PRD's research plan, so after the
 * lock research runs unattended.
 */
export const OutlineSchema = z.strictObject({
  topic: z.string().min(1),
  items: z.array(OutlineItemSchema).min(1),
  execution: z.strictObject({
    timeRange: z.string().min(1),
    batchSize: z.number().int().min(1),
    resume: z.boolean(),
    docsRequired: z.boolean(),
    academic: z.strictObject({ enabled: z.boolean(), queries: z.array(z.string()) }),
    githubLookup: z.strictObject({ enabled: z.boolean(), queries: z.array(z.string()) }),
  }),
});
export type Outline = z.infer<typeof OutlineSchema>;
