// The `memory_read` and `memory_append` MCP tools (OSA_DIRECTIVE.md WS8). Project memory is plain markdown under
// `.osa/memory/`, one fact per line, never a secret: `memory_append` validates every fact (single line, bounded, no
// credentials), de-duplicates, and REPORTS what it rejected instead of dropping it silently.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OsaError } from "../../domain/errors.ts";
import { MEMORY_CATEGORIES, MAX_FACT_CHARS, appendFacts, formatMemoryForPrompt, readFacts } from "../../memory/store.ts";

export const MemoryReadInput = z.strictObject({
  repo_dir: z.string().min(1),
  /** Which categories to read; default all four. */
  categories: z.array(z.enum(MEMORY_CATEGORIES)).min(1).optional(),
  /** Also return the block formatted the way intake sees it (newest first, bounded). */
  as_prompt: z.boolean().default(false),
  max_chars: z.number().int().min(200).max(20000).default(3000),
});
export type MemoryReadInput = z.infer<typeof MemoryReadInput>;

const FactOut = z.strictObject({ category: z.enum(MEMORY_CATEGORIES), text: z.string(), runId: z.string().nullable(), date: z.string().nullable() });

export const MemoryReadOutput = z.strictObject({ facts: z.array(FactOut), prompt: z.string().nullable() });
export type MemoryReadOutput = z.infer<typeof MemoryReadOutput>;

export const MemoryAppendInput = z.strictObject({
  repo_dir: z.string().min(1),
  category: z.enum(MEMORY_CATEGORIES),
  /** Each fact is ONE line of at most 300 characters and must not contain a secret. */
  facts: z.array(z.string().min(1).max(MAX_FACT_CHARS * 2)).min(1).max(50),
  /** Optional run id for provenance. */
  run_id: z.string().max(64).optional(),
});
export type MemoryAppendInput = z.infer<typeof MemoryAppendInput>;

export const MemoryAppendOutput = z.strictObject({
  appended: z.array(z.string()),
  duplicates: z.array(z.string()),
  rejected: z.array(z.strictObject({ text: z.string(), reason: z.string() })),
  compacted: z.number().int(),
});
export type MemoryAppendOutput = z.infer<typeof MemoryAppendOutput>;

export const MEMORY_READ_DESCRIPTION =
  "Read this project's persistent memory (.osa/memory): decisions, conventions, past failures and fixes, and the user's preferences for this project. " +
  "One fact per line. Use it before making assumptions about how this project does things.";
export const MEMORY_APPEND_DESCRIPTION =
  "Append facts to this project's memory (categories: decisions, conventions, failures, preferences). One fact per line, max 300 characters, " +
  "never a secret: facts that look like credentials are rejected and reported, and duplicates are skipped.";

function err(e: unknown): CallToolResult {
  const text = e instanceof OsaError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
  return { content: [{ type: "text", text }], isError: true };
}

export async function runMemoryRead(input: MemoryReadInput): Promise<MemoryReadOutput> {
  const facts = await readFacts(input.repo_dir, input.categories ?? MEMORY_CATEGORIES);
  return { facts: [...facts], prompt: input.as_prompt ? formatMemoryForPrompt(facts, input.max_chars) : null };
}

export async function runMemoryAppend(input: MemoryAppendInput): Promise<MemoryAppendOutput> {
  const r = await appendFacts(input.repo_dir, input.category, input.facts, { runId: input.run_id ?? null });
  return { appended: [...r.appended], duplicates: [...r.duplicates], rejected: [...r.rejected], compacted: r.compacted };
}

/** Registers `memory_read` and `memory_append`. */
export function registerMemoryTools(server: McpServer): void {
  server.registerTool("memory_read", { description: MEMORY_READ_DESCRIPTION, inputSchema: MemoryReadInput, outputSchema: MemoryReadOutput }, async (input): Promise<CallToolResult> => {
    try {
      const out = await runMemoryRead(input);
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
    } catch (e) {
      return err(e);
    }
  });
  server.registerTool("memory_append", { description: MEMORY_APPEND_DESCRIPTION, inputSchema: MemoryAppendInput, outputSchema: MemoryAppendOutput }, async (input): Promise<CallToolResult> => {
    try {
      const out = await runMemoryAppend(input);
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
    } catch (e) {
      return err(e);
    }
  });
}
