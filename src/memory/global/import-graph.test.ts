// FM-I: with the memory feature unused, no global-memory module is reachable from any entry point's STATIC import graph.
// The store (and its node:sqlite dependency) must load only through the dynamic import() in the MCP tool handlers and
// the CLI run function. This mirrors the discipline the plug-in invariant test (src/osa/modular-features.test.ts)
// already enforces for CBM and trim-1, applied here to src/memory/global/**.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

/** Static import specifiers: `import … from`, `export … from`, bare `import "x"`; NOT `import type`, NOT dynamic import(). Pure. */
function staticImports(src: string): string[] {
  const out: string[] = [];
  const re = /^(?:import|export)\s+(?!type\b)(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (const m of src.matchAll(re)) if (m[1] !== undefined) out.push(m[1]);
  return out;
}

async function staticClosure(entry: string): Promise<string[]> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of staticImports(text)) if (spec.startsWith(".")) stack.push(resolve(dirname(file), spec));
  }
  return [...seen];
}

const ROOT = resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const isGlobalMemory = (rel: string): boolean => rel.startsWith("src/memory/global/");

test("FM-I: no entry point statically imports any src/memory/global/ module", async () => {
  for (const entry of ["src/cli/main.ts", "src/mcp/server.ts", "src/mcp/tools/memory-global.ts", "src/cli/memory-cmd.ts", "src/osa/pipeline.ts"]) {
    const reached = (await staticClosure(resolve(ROOT, entry))).map((f) => relative(ROOT, f).split("\\").join("/"));
    assert.ok(reached.length > 1, `${entry}: the walker found its imports`);
    assert.deepEqual(reached.filter(isGlobalMemory), [], `${entry} statically imports a global-memory module (it must be a dynamic import)`);
  }
});

test("the walker does catch a planted static import of the global store (mutation check)", async () => {
  // a self-check: if memory-global.ts were to statically import the store, this test's walker would see it
  const src = 'import { saveFact } from "../../memory/global/memory.ts";\n';
  const specs = staticImports(src);
  assert.deepEqual(specs, ["../../memory/global/memory.ts"]);
  const dynamic = 'const { saveFact } = await import("../../memory/global/memory.ts");\n';
  assert.deepEqual(staticImports(dynamic), [], "a dynamic import() is not a static edge");
});
