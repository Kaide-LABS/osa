// `osa memory`: print this project's persistent memory (.osa/memory). Read-only; to add a fact use the
// `memory_append` MCP tool or edit the markdown files by hand (one fact per line).

import { ExitCode } from "../domain/errors.ts";
import { MEMORY_CATEGORIES, MEMORY_DIR_REL, readFacts } from "../memory/store.ts";

export interface MemoryCommandOptions {
  readonly repoDir: string;
  readonly json: boolean;
}

/** Returns the text to print. */
export async function runMemoryCommand(opts: MemoryCommandOptions): Promise<{ text: string; exitCode: number }> {
  const facts = await readFacts(opts.repoDir);
  if (opts.json) return { text: `${JSON.stringify({ facts }, null, 2)}\n`, exitCode: ExitCode.OK };
  if (facts.length === 0) return { text: `No project memory yet (${MEMORY_DIR_REL}). It is written at the end of each osa run.\n`, exitCode: ExitCode.OK };
  const lines: string[] = [];
  for (const c of MEMORY_CATEGORIES) {
    const mine = facts.filter((f) => f.category === c);
    if (mine.length === 0) continue;
    lines.push(`${c} (${String(mine.length)}):`, ...mine.map((f) => `  - ${f.text}`), "");
  }
  return { text: `${lines.join("\n")}`, exitCode: ExitCode.OK };
}
